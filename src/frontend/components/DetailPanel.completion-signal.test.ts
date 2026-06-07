// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState, ClientMessage } from '../../shared/protocol.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { DetailPanel } from './DetailPanel.js';

vi.mock('../telemetry.js', () => ({ track: vi.fn(), trackClick: vi.fn() }));
vi.mock('./ActivityPanel.js', () => ({ ActivityPanel: () => React.createElement('div', { 'data-testid': 'activity-panel' }) }));
vi.mock('./GitHubPanel.js', () => ({ GitHubPanel: () => React.createElement('div', { 'data-testid': 'github-panel' }) }));
vi.mock('./TerminalPanel.js', () => ({ TerminalPanel: () => React.createElement('div', { 'data-testid': 'terminal-panel' }) }));
vi.mock('./DiffPane.js', () => ({ DiffPane: () => React.createElement('div', { 'data-testid': 'diff-pane' }) }));
vi.mock('./SnoozeDialog.js', () => ({ SnoozeDialog: () => null }));
vi.mock('./EffectiveHookSettingsModal.js', () => ({ EffectiveHookSettingsModal: () => null }));

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function completionSignalAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'agent-1',
    taskId: 'task-1',
    taskName: 'Review-ready task',
    events: [],
    anomaly: {
      agentId: 'agent-1',
      type: 'needs_input',
      subType: 'stop',
      severity: 'info',
      explanation: 'Agent is waiting for input.',
      detectedAt: new Date('2026-06-07T09:46:44.135Z'),
    },
    turnState: 'completed_turn',
    latestCompletionSignal: { id: 'signal-1' },
    agentType: 'codex-cli',
    cwd: '/tmp/kookr',
    startedAt: '2026-06-07T09:00:00.000Z',
    taskStatus: 'inProgress',
    ...overrides,
  };
}

function renderDetailPanel(
  container: HTMLElement,
  send: (msg: ClientMessage) => boolean = vi.fn(() => true),
  agent: AgentState = completionSignalAgent(),
): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(DetailPanel, {
      agent,
      send,
      onLaunch: vi.fn(),
      onRequestComplete: vi.fn(),
    }));
  });
  return root;
}

describe('DetailPanel completion signal presentation', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ shares: [] }), {
      headers: { 'content-type': 'application/json' },
    })));
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  test('surfaces derived completion signals without an explicit pending signal', () => {
    root = renderDetailPanel(container);

    const completeButton = container.querySelector<HTMLButtonElement>('[data-testid="action-complete"]');
    expect(completeButton).toBeInstanceOf(HTMLButtonElement);
    expect(completeButton?.className).toContain('action-btn--signal-ready');

    const banner = container.querySelector<HTMLElement>('[data-testid="agent-signal-banner"]');
    expect(banner).toBeInstanceOf(HTMLElement);
    expect(banner?.textContent).toContain('ready for review');
    expect(container.querySelector('[data-testid="agent-signal-dismiss"]')).toBeNull();
  });

  test('does not render an ineffective dismiss button when explicit and derived signals overlap', () => {
    const sent: ClientMessage[] = [];
    const agent = completionSignalAgent({
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: '2026-06-07T09:01:00.000Z',
        note: 'done',
      },
    });
    root = renderDetailPanel(container, (msg) => {
      sent.push(msg);
      return true;
    }, agent);

    expect(container.querySelector('[data-testid="agent-signal-banner"]')?.textContent).toContain('ready for review');
    expect(container.querySelector('[data-testid="agent-signal-dismiss"]')).toBeNull();
    expect(sent).toEqual([]);
  });

  test('keeps pending-signal-only dismiss behavior', () => {
    const sent: ClientMessage[] = [];
    const agent = completionSignalAgent({
      turnState: undefined,
      latestCompletionSignal: undefined,
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: '2026-06-07T09:01:00.000Z',
      },
    });
    root = renderDetailPanel(container, (msg) => {
      sent.push(msg);
      return true;
    }, agent);

    const dismiss = container.querySelector<HTMLButtonElement>('[data-testid="agent-signal-dismiss"]');
    expect(dismiss).toBeInstanceOf(HTMLButtonElement);
    act(() => dismiss!.click());

    expect(sent).toContainEqual({ type: 'dismissAgentSignal', taskId: 'task-1' });
  });
});
