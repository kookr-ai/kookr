// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState, ClientMessage } from '../../shared/protocol.js';
import { track } from '../telemetry.js';
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

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('DetailPanel empty Enter behavior', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  test('skips the selected finding and advances when Enter is pressed with empty input', () => {
    const first = makeAgent('agent-1', {
      agentId: 'agent-1',
      type: 'needs_input',
      severity: 'warning',
      explanation: 'waiting',
      detectedAt: new Date('2026-05-24T16:00:00.000Z'),
    });
    const second = makeAgent('agent-2', {
      agentId: 'agent-2',
      type: 'repeated_error',
      severity: 'warning',
      explanation: 'stuck',
      detectedAt: new Date('2026-05-24T16:01:00.000Z'),
    });
    useKookrStore.setState({ agents: [first, second], selectedAgentId: first.agentId });
    const sent: ClientMessage[] = [];
    root = renderDetailPanel(container, first, (msg) => {
      sent.push(msg);
      return true;
    });

    const input = container.querySelector<HTMLInputElement>('.response-row input');
    expect(input).toBeInstanceOf(HTMLInputElement);
    act(() => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(sent).toEqual([{ type: 'skip', agentId: 'agent-1' }]);
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-2');
    expect(track).toHaveBeenCalledWith({
      type: 'finding_skipped',
      agentId: 'agent-1',
      anomalyType: 'needs_input',
      method: 'empty_enter',
    });
    expect(track).toHaveBeenCalledWith({
      type: 'shortcut_used',
      key: 'Enter',
      action: 'skip_empty_input',
      context: 'input_focused',
    });
  });

  test('treats whitespace-only input as empty when skipping with Enter', () => {
    const first = makeAgent('agent-1', {
      agentId: 'agent-1',
      type: 'needs_input',
      severity: 'warning',
      explanation: 'waiting',
      detectedAt: new Date('2026-05-24T16:00:00.000Z'),
    });
    const second = makeAgent('agent-2', {
      agentId: 'agent-2',
      type: 'repeated_error',
      severity: 'warning',
      explanation: 'stuck',
      detectedAt: new Date('2026-05-24T16:01:00.000Z'),
    });
    useKookrStore.setState({ agents: [first, second], selectedAgentId: first.agentId });
    const sent: ClientMessage[] = [];
    root = renderDetailPanel(container, first, (msg) => {
      sent.push(msg);
      return true;
    });

    const input = container.querySelector<HTMLInputElement>('.response-row input');
    expect(input).toBeInstanceOf(HTMLInputElement);
    act(() => {
      setInputValue(input!, '   ');
    });
    act(() => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(sent).toEqual([{ type: 'skip', agentId: 'agent-1' }]);
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-2');
  });

  test('on a healthy task with a pending finding, empty Enter jumps to the finding without sending skip', () => {
    const healthy = makeAgent('agent-healthy', null);
    const finding = makeAgent('agent-finding', {
      agentId: 'agent-finding',
      type: 'needs_input',
      severity: 'warning',
      explanation: 'waiting',
      detectedAt: new Date('2026-05-24T16:00:00.000Z'),
    });
    useKookrStore.setState({ agents: [healthy, finding], selectedAgentId: healthy.agentId });
    const sent: ClientMessage[] = [];
    root = renderDetailPanel(container, healthy, (msg) => {
      sent.push(msg);
      return true;
    });

    const input = container.querySelector<HTMLInputElement>('.response-row input');
    expect(input).toBeInstanceOf(HTMLInputElement);
    act(() => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(sent).toEqual([]);
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-finding');
    expect(track).toHaveBeenCalledWith({
      type: 'shortcut_used',
      key: 'Enter',
      action: 'advance_empty_input',
      context: 'input_focused',
    });
  });

  test('on a healthy task with no findings, empty Enter advances to the next task without sending skip', () => {
    const first = makeAgent('agent-1', null);
    const second = makeAgent('agent-2', null);
    useKookrStore.setState({ agents: [first, second], selectedAgentId: first.agentId });
    const sent: ClientMessage[] = [];
    root = renderDetailPanel(container, first, (msg) => {
      sent.push(msg);
      return true;
    });

    const input = container.querySelector<HTMLInputElement>('.response-row input');
    expect(input).toBeInstanceOf(HTMLInputElement);
    act(() => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(sent).toEqual([]);
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-2');
    expect(track).toHaveBeenCalledWith({
      type: 'shortcut_used',
      key: 'Enter',
      action: 'advance_empty_input',
      context: 'input_focused',
    });
  });

  test('on a healthy task, whitespace-only Enter advances without sending skip', () => {
    const first = makeAgent('agent-1', null);
    const second = makeAgent('agent-2', null);
    useKookrStore.setState({ agents: [first, second], selectedAgentId: first.agentId });
    const sent: ClientMessage[] = [];
    root = renderDetailPanel(container, first, (msg) => {
      sent.push(msg);
      return true;
    });

    const input = container.querySelector<HTMLInputElement>('.response-row input');
    expect(input).toBeInstanceOf(HTMLInputElement);
    act(() => {
      setInputValue(input!, '   ');
    });
    act(() => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(sent).toEqual([]);
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-2');
  });
});
