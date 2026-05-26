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
vi.mock('./TerminalPanel.js', () => ({
  TerminalPanel: ({ onEmptySubmit, agentPromptReady }: { onEmptySubmit?: () => void; agentPromptReady?: boolean }) => React.createElement(
    'button',
    {
      'data-testid': 'terminal-empty-submit',
      'data-agent-prompt-ready': agentPromptReady ? 'true' : 'false',
      onClick: onEmptySubmit,
    },
    'terminal',
  ),
}));
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

  test('sends an empty-enter intent when a server terminal-input snapshot is present', () => {
    const agent = {
      ...makeAgent('agent-1', null),
      terminalInputSnapshot: {
        sessionId: 'agent-1',
        taskId: 'task-agent-1',
        inputStateEpoch: 'epoch-1',
        readinessVersion: 42,
        promptReady: true,
      },
    };
    useKookrStore.setState({
      agents: [agent],
      selectedAgentId: agent.agentId,
      dashboardSelection: {
        selectedTaskId: agent.taskId!,
        selectedSessionId: agent.agentId,
        selectionVersion: 7,
      },
    });
    const sent: ClientMessage[] = [];
    root = renderDetailPanel(container, agent, (msg) => {
      sent.push(msg);
      return true;
    });

    const terminalSubmit = container.querySelector<HTMLButtonElement>('[data-testid="terminal-empty-submit"]');
    act(() => {
      terminalSubmit!.click();
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'emptyEnterIntent',
      taskId: agent.taskId,
      sessionId: agent.agentId,
      selectionVersion: 7,
      inputStateEpoch: 'epoch-1',
      observedReadinessVersion: 42,
    });
    expect(sent[0]).toHaveProperty('intentId');
    expect(useKookrStore.getState().selectedAgentId).toBe(agent.agentId);
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

  test('empty Enter on the only remaining finding falls through to nextTask instead of deselecting', () => {
    // Regression: nextBottleneck wraps onto self when there is exactly one
    // finding and deselects the agent, unmounting the reply input. Subsequent
    // Enters then hit <body> and the user is stranded. The empty-Enter path
    // must fall through to nextTask so a selection is preserved.
    const onlyFinding = makeAgent('agent-finding', {
      agentId: 'agent-finding',
      type: 'needs_input',
      severity: 'warning',
      explanation: 'waiting',
      detectedAt: new Date('2026-05-24T16:00:00.000Z'),
    });
    const healthyA = makeAgent('agent-healthy-a', null);
    const healthyB = makeAgent('agent-healthy-b', null);
    useKookrStore.setState({
      agents: [onlyFinding, healthyA, healthyB],
      selectedAgentId: onlyFinding.agentId,
    });
    const sent: ClientMessage[] = [];
    root = renderDetailPanel(container, onlyFinding, (msg) => {
      sent.push(msg);
      return true;
    });

    const input = container.querySelector<HTMLInputElement>('.response-row input');
    expect(input).toBeInstanceOf(HTMLInputElement);
    act(() => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(sent).toEqual([{ type: 'skip', agentId: 'agent-finding' }]);
    // Critical: did NOT deselect — selection moved forward into the healthy list.
    expect(useKookrStore.getState().selectedAgentId).not.toBeNull();
    expect(useKookrStore.getState().selectedAgentId).toBe(healthyA.agentId);
  });

  test('empty Enter on the only finding falls through even when no healthy tasks exist', () => {
    // Defensive: if nextTask has nothing to advance to either, the worst case
    // is no movement — but we should not silently deselect (which would unmount
    // the input and break the user's rapid-skim flow).
    const onlyFinding = makeAgent('agent-finding', {
      agentId: 'agent-finding',
      type: 'needs_input',
      severity: 'warning',
      explanation: 'waiting',
      detectedAt: new Date('2026-05-24T16:00:00.000Z'),
    });
    useKookrStore.setState({
      agents: [onlyFinding],
      selectedAgentId: onlyFinding.agentId,
    });
    const sent: ClientMessage[] = [];
    root = renderDetailPanel(container, onlyFinding, (msg) => {
      sent.push(msg);
      return true;
    });

    const input = container.querySelector<HTMLInputElement>('.response-row input');
    expect(input).toBeInstanceOf(HTMLInputElement);
    act(() => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(sent).toEqual([{ type: 'skip', agentId: 'agent-finding' }]);
    // With nothing else to advance to, selection stays put rather than being
    // nulled out. The DetailPanel remains mounted and the input keeps focus.
    expect(useKookrStore.getState().selectedAgentId).toBe(onlyFinding.agentId);
  });

  test('Skip BUTTON on the only finding keeps the deselect-on-last behavior', () => {
    // Symmetric guard: the user-explicit Skip click should NOT have changed.
    // Only the empty-Enter rapid-skim shortcut falls through to nextTask.
    const onlyFinding = makeAgent('agent-finding', {
      agentId: 'agent-finding',
      type: 'needs_input',
      severity: 'warning',
      explanation: 'waiting',
      detectedAt: new Date('2026-05-24T16:00:00.000Z'),
    });
    const healthyA = makeAgent('agent-healthy-a', null);
    useKookrStore.setState({
      agents: [onlyFinding, healthyA],
      selectedAgentId: onlyFinding.agentId,
    });
    const sent: ClientMessage[] = [];
    root = renderDetailPanel(container, onlyFinding, (msg) => {
      sent.push(msg);
      return true;
    });

    const skipButton = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Skip') as HTMLButtonElement | undefined;
    expect(skipButton).toBeInstanceOf(HTMLButtonElement);
    act(() => {
      skipButton!.click();
    });

    expect(sent).toEqual([{ type: 'skip', agentId: 'agent-finding' }]);
    expect(useKookrStore.getState().selectedAgentId).toBeNull();
  });

  test('empty Enter treats snoozed and suppressed findings as "no other finding"', () => {
    // Pins the `hasOtherFinding` predicate guards: a snoozed-with-anomaly or
    // suppressed agent does not count as a routable bottleneck (the slice's
    // nextBottleneck filter excludes both), so the empty-Enter path must still
    // fall through to nextTask when the only OTHER findings are snoozed/suppressed.
    const onlyFinding = makeAgent('agent-finding', {
      agentId: 'agent-finding',
      type: 'needs_input',
      severity: 'warning',
      explanation: 'waiting',
      detectedAt: new Date('2026-05-24T16:00:00.000Z'),
    });
    const snoozed: AgentState = {
      ...makeAgent('agent-snoozed', {
        agentId: 'agent-snoozed',
        type: 'repeated_error',
        severity: 'warning',
        explanation: 'paused',
        detectedAt: new Date('2026-05-24T16:00:00.000Z'),
      }),
      snoozedUntil: Date.now() + 60_000,
    };
    const suppressed: AgentState = {
      ...makeAgent('agent-suppressed', {
        agentId: 'agent-suppressed',
        type: 'repeated_error',
        severity: 'warning',
        explanation: 'muted',
        detectedAt: new Date('2026-05-24T16:00:00.000Z'),
      }),
      suppressed: true,
    };
    const healthy = makeAgent('agent-healthy', null);

    useKookrStore.setState({
      agents: [onlyFinding, snoozed, suppressed, healthy],
      selectedAgentId: onlyFinding.agentId,
    });
    const sent: ClientMessage[] = [];
    root = renderDetailPanel(container, onlyFinding, (msg) => {
      sent.push(msg);
      return true;
    });

    const input = container.querySelector<HTMLInputElement>('.response-row input');
    expect(input).toBeInstanceOf(HTMLInputElement);
    act(() => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(sent).toEqual([{ type: 'skip', agentId: 'agent-finding' }]);
    // hasOtherFinding must return false → nextTask, landing on the healthy agent.
    expect(useKookrStore.getState().selectedAgentId).toBe(healthy.agentId);
  });

  test('passes agentPromptReady=true to TerminalPanel when turnState is completed_turn', () => {
    // The terminal needs a coherent React-prop hint to dispatch empty-Enter
    // during the brief window after a session switch where the buffer hasn't
    // repainted yet. completed_turn is the canonical "Claude is idle at the
    // empty prompt awaiting follow-up" signal.
    const idle = makeAgent('agent-idle', null);
    idle.turnState = 'completed_turn';
    useKookrStore.setState({ agents: [idle], selectedAgentId: idle.agentId });
    root = renderDetailPanel(container, idle, () => true);

    const terminalSubmit = container.querySelector<HTMLButtonElement>('[data-testid="terminal-empty-submit"]');
    expect(terminalSubmit?.dataset.agentPromptReady).toBe('true');
  });

  test('passes agentPromptReady=true to TerminalPanel when turnState is waiting_for_input', () => {
    const waiting = makeAgent('agent-waiting', null);
    waiting.turnState = 'waiting_for_input';
    useKookrStore.setState({ agents: [waiting], selectedAgentId: waiting.agentId });
    root = renderDetailPanel(container, waiting, () => true);

    const terminalSubmit = container.querySelector<HTMLButtonElement>('[data-testid="terminal-empty-submit"]');
    expect(terminalSubmit?.dataset.agentPromptReady).toBe('true');
  });

  test('passes agentPromptReady=false to TerminalPanel when turnState is running', () => {
    // Claude is actively streaming — Enter at the terminal must NOT be
    // interpreted as advance regardless of any buffer-scan misfire.
    const running = makeAgent('agent-running', null);
    running.turnState = 'running';
    useKookrStore.setState({ agents: [running], selectedAgentId: running.agentId });
    root = renderDetailPanel(container, running, () => true);

    const terminalSubmit = container.querySelector<HTMLButtonElement>('[data-testid="terminal-empty-submit"]');
    expect(terminalSubmit?.dataset.agentPromptReady).toBe('false');
  });

  test('passes agentPromptReady=false to TerminalPanel when turnState is blocked', () => {
    // `blocked` covers non-permission hard-blocks (api_error stops, etc.).
    // The hint must stay false so the buffer scan owns the decision.
    const blocked = makeAgent('agent-blocked-turn', null);
    blocked.turnState = 'blocked';
    useKookrStore.setState({ agents: [blocked], selectedAgentId: blocked.agentId });
    root = renderDetailPanel(container, blocked, () => true);

    const terminalSubmit = container.querySelector<HTMLButtonElement>('[data-testid="terminal-empty-submit"]');
    expect(terminalSubmit?.dataset.agentPromptReady).toBe('false');
  });

  test('passes agentPromptReady=false to TerminalPanel when turnState is unknown or absent', () => {
    // Pinning the default branch — synthetic pending/terminal entries have
    // no turnState, and `unknown` is the explicit "no events yet" placeholder.
    // Both must fall through to the local buffer scan rather than override.
    const noState = makeAgent('agent-no-state', null);
    useKookrStore.setState({ agents: [noState], selectedAgentId: noState.agentId });
    root = renderDetailPanel(container, noState, () => true);
    const noStateSubmit = container.querySelector<HTMLButtonElement>('[data-testid="terminal-empty-submit"]');
    expect(noStateSubmit?.dataset.agentPromptReady).toBe('false');

    const unknown = makeAgent('agent-unknown', null);
    unknown.turnState = 'unknown';
    useKookrStore.setState({ agents: [unknown], selectedAgentId: unknown.agentId });
    act(() => root?.unmount());
    root = renderDetailPanel(container, unknown, () => true);
    const unknownSubmit = container.querySelector<HTMLButtonElement>('[data-testid="terminal-empty-submit"]');
    expect(unknownSubmit?.dataset.agentPromptReady).toBe('false');
  });

  test('passes agentPromptReady=false to TerminalPanel when anomaly is permission_blocked', () => {
    // Permission dialog needs an explicit Allow/Deny choice — empty-Enter
    // must not silently advance past it. The buffer scan already returns
    // false for permission dialogs; the React hint mirrors that policy so
    // the two signals can't disagree and let a misfire through.
    const blocked = makeAgent('agent-blocked', {
      agentId: 'agent-blocked',
      type: 'permission_blocked',
      severity: 'warning',
      explanation: 'awaiting choice',
      detectedAt: new Date('2026-05-24T16:00:00.000Z'),
    });
    blocked.turnState = 'waiting_for_input';
    useKookrStore.setState({ agents: [blocked], selectedAgentId: blocked.agentId });
    root = renderDetailPanel(container, blocked, () => true);

    const terminalSubmit = container.querySelector<HTMLButtonElement>('[data-testid="terminal-empty-submit"]');
    expect(terminalSubmit?.dataset.agentPromptReady).toBe('false');
  });

  test('terminal empty-submit callback uses the same empty Enter advance path', () => {
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

    const terminalSubmit = container.querySelector<HTMLButtonElement>('[data-testid="terminal-empty-submit"]');
    expect(terminalSubmit).toBeInstanceOf(HTMLButtonElement);
    act(() => {
      terminalSubmit!.click();
    });

    expect(sent).toEqual([{ type: 'skip', agentId: 'agent-1' }]);
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-2');
    expect(track).toHaveBeenCalledWith({
      type: 'finding_skipped',
      agentId: 'agent-1',
      anomalyType: 'needs_input',
      method: 'empty_enter',
    });
  });
});
