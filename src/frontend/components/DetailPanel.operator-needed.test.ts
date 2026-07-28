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

function baseAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'agent-1',
    taskId: 'task-1',
    taskName: 'Autonomous task',
    events: [],
    anomaly: null,
    agentType: 'claude-code',
    cwd: '/tmp/kookr',
    startedAt: '2026-07-28T09:00:00.000Z',
    taskStatus: 'inProgress',
    unattended: true,
    ...overrides,
  };
}

function renderDetailPanel(container: HTMLElement, agent: AgentState): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(DetailPanel, {
      agent,
      send: vi.fn(() => true) as (msg: ClientMessage) => boolean,
      onLaunch: vi.fn(),
      onRequestComplete: vi.fn(),
    }));
  });
  return root;
}

describe('DetailPanel operator-needed presentation (issue #1562)', () => {
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

  test('renders an operator-needed badge and banner when the flag is set', () => {
    const agent = baseAgent({
      operatorNeeded: {
        reason: 'interactive_tool_denied',
        toolName: 'AskUserQuestion',
        detectedAt: new Date('2026-07-28T10:00:00.000Z'),
        message: 'Autonomous task tried to use the interactive tool "AskUserQuestion".',
      },
    });
    root = renderDetailPanel(container, agent);

    expect(container.querySelector('[data-testid="task-operator-needed-badge"]')).toBeInstanceOf(HTMLElement);
    const banner = container.querySelector<HTMLElement>('[data-testid="agent-operator-needed-banner"]');
    expect(banner).toBeInstanceOf(HTMLElement);
    expect(banner?.textContent).toContain('AskUserQuestion');
  });

  test('renders nothing operator-needed when the flag is absent', () => {
    root = renderDetailPanel(container, baseAgent());

    expect(container.querySelector('[data-testid="task-operator-needed-badge"]')).toBeNull();
    expect(container.querySelector('[data-testid="agent-operator-needed-banner"]')).toBeNull();
  });
});
