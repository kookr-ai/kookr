// @vitest-environment jsdom

/**
 * F17 (UX-dogfooding RFC): the completion composer offers a plain "Send"
 * primary action that STAYS on the current task, plus a secondary
 * "Send & Next". Keyboard: Enter = send & stay, Ctrl/Cmd+Enter = send & next.
 */

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
vi.mock('./TaskShareModal.js', () => ({ TaskShareModal: () => null }));

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeAgent(agentId: string, anomaly: AgentState['anomaly']): AgentState {
  return {
    agentId,
    taskId: `task-${agentId}`,
    taskName: `Task ${agentId}`,
    events: [],
    anomaly,
    cwd: '/tmp/kookr',
    startedAt: '2026-05-24T16:00:00.000Z',
    taskStatus: 'inProgress',
  };
}

function makeFinding(agentId: string, detectedAt: string): AgentState {
  return makeAgent(agentId, {
    agentId,
    type: 'needs_input',
    severity: 'warning',
    explanation: 'waiting',
    detectedAt: new Date(detectedAt),
  });
}

function renderDetailPanel(container: HTMLElement, agent: AgentState, send: (msg: ClientMessage) => boolean): Root {
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

function setInputValue(input: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function composer(container: HTMLElement): HTMLTextAreaElement {
  const input = container.querySelector<HTMLTextAreaElement>('.response-row textarea');
  expect(input).toBeInstanceOf(HTMLTextAreaElement);
  return input!;
}

describe('DetailPanel send actions (F17)', () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let sent: ClientMessage[];
  let first: AgentState;
  let second: AgentState;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
    sent = [];
    first = makeFinding('agent-1', '2026-05-24T16:00:00.000Z');
    second = makeFinding('agent-2', '2026-05-24T16:01:00.000Z');
    useKookrStore.setState({ agents: [first, second], selectedAgentId: first.agentId });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  test('plain Enter sends the response and STAYS on the current task', () => {
    root = renderDetailPanel(container, first, (msg) => { sent.push(msg); return true; });

    const input = composer(container);
    act(() => { setInputValue(input, 'Try the helper'); });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(sent).toEqual([{ type: 'respond', agentId: 'agent-1', input: 'Try the helper' }]);
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-1');
    expect(input.value).toBe('');
  });

  test('Ctrl+Enter sends the response AND advances to the next finding', () => {
    root = renderDetailPanel(container, first, (msg) => { sent.push(msg); return true; });

    const input = composer(container);
    act(() => { setInputValue(input, 'Try the helper'); });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    });

    expect(sent).toEqual([{ type: 'respond', agentId: 'agent-1', input: 'Try the helper' }]);
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-2');
  });

  test('Shift+Enter does not send (reserved for newline insertion)', () => {
    root = renderDetailPanel(container, first, (msg) => { sent.push(msg); return true; });

    const input = composer(container);
    act(() => { setInputValue(input, 'line one'); });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    });

    expect(sent).toEqual([]);
    expect(input.value).toBe('line one');
  });

  test('the Send button sends and stays; Send & Next sends and advances', () => {
    root = renderDetailPanel(container, first, (msg) => { sent.push(msg); return true; });

    const sendButton = container.querySelector<HTMLButtonElement>('[data-testid="send-button"]');
    const sendNextButton = container.querySelector<HTMLButtonElement>('[data-testid="send-next-button"]');
    expect(sendButton?.textContent).toBe('Send');
    expect(sendNextButton?.textContent).toBe('Send & Next');
    expect(sendButton?.className).toBe('btn-primary');
    expect(sendNextButton?.className).toBe('btn-secondary');

    const input = composer(container);
    act(() => { setInputValue(input, 'stay here'); });
    act(() => { sendButton!.click(); });
    expect(sent).toEqual([{ type: 'respond', agentId: 'agent-1', input: 'stay here' }]);
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-1');

    act(() => { setInputValue(input, 'now advance'); });
    act(() => { sendNextButton!.click(); });
    expect(sent).toEqual([
      { type: 'respond', agentId: 'agent-1', input: 'stay here' },
      { type: 'respond', agentId: 'agent-1', input: 'now advance' },
    ]);
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-2');
  });

  test('direct replies (healthy agent) show only the Send button', () => {
    const healthy = makeAgent('agent-3', null);
    useKookrStore.setState({ agents: [healthy], selectedAgentId: healthy.agentId });
    root = renderDetailPanel(container, healthy, (msg) => { sent.push(msg); return true; });

    expect(container.querySelector('[data-testid="send-button"]')?.textContent).toBe('Send');
    expect(container.querySelector('[data-testid="send-next-button"]')).toBeNull();

    const input = composer(container);
    act(() => { setInputValue(input, 'hello'); });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(sent).toEqual([{ type: 'directReply', agentId: 'agent-3', input: 'hello' }]);
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-3');
  });
});
