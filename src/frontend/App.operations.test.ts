// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App, DEFAULT_DESTRUCTIVE_ACTION_UNDO_MS } from './App.js';
import { createKookrStore, useKookrStore } from './store/useStore.js';
import { close as closeOnboardingTour } from './store/onboarding-store.js';
import { recordOutbound, recordReportableAlert, resetBugReportRecorderForTests } from './bug-report-recorder.js';
import { clearDebugTimeline, setDebugTimelineEnabledForTests } from './debug-timeline.js';
import { __resetViewerSessionForTests } from './viewer-session.js';
import type { AgentState } from '../shared/protocol.js';
import type { WorktreeCleanupVerdict } from '../shared/contracts/worktree-cleanup-verdict.js';

const websocketMock = vi.hoisted(() => ({
  send: vi.fn(() => true),
}));

vi.mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: () => ({ send: websocketMock.send }),
}));

vi.mock('./hooks/useNotifications.js', () => ({
  useNotifications: () => {},
}));

vi.mock('./hooks/useAudibleAlert.js', () => ({
  useAudibleAlert: () => {},
}));

vi.mock('./hooks/useTaskCompletionChime.js', () => ({
  useTaskCompletionChime: () => {},
}));

vi.mock('./telemetry.js', () => ({
  track: vi.fn(),
}));

vi.mock('./components/DetailPanel.js', () => ({
  DetailPanel: (props: { onRequestComplete: () => void; onLaunchPlaybooks?: () => void; onOpenSchedules?: () => void }) => React.createElement(
    'div',
    { 'data-testid': 'detail-panel' },
    React.createElement('button', { 'data-testid': 'mock-complete-button', onClick: props.onRequestComplete }, 'Complete'),
    React.createElement('button', { 'data-testid': 'mock-launch-playbooks', onClick: props.onLaunchPlaybooks }, 'Recent playbook'),
    React.createElement('button', { 'data-testid': 'mock-open-schedules', onClick: props.onOpenSchedules }, 'Next scheduled'),
  ),
}));

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function removableVerdict(): WorktreeCleanupVerdict {
  return {
    worktreePath: '/wt/task-1',
    worktreeName: 'task-1',
    branch: 'feature',
    removable: true,
    evidence: { dirty: { modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0 }, aheadCount: 0 },
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Simulate the server's reply to the dialog's `worktree:inspectCleanup` probe.
 *
 * The socket is mocked here, so nothing answers the probe on its own and the
 * dialog would sit in its "checking" state — where it deliberately makes no
 * cleanup claim. Any test that exercises the checkbox has to settle it first.
 */
async function settleCleanupVerdicts(verdicts: WorktreeCleanupVerdict[] = [removableVerdict()]) {
  const taskId = useKookrStore.getState().cleanupVerdictsTaskId;
  if (taskId === null) return;
  await act(async () => {
    useKookrStore.getState().handleWorktreeCleanupVerdicts(taskId, verdicts);
  });
}

async function waitForElement<T extends Element>(container: Element, selector: string): Promise<T> {
  const startedAt = Date.now();
  // 5s is generous but matches the App-level render budget the spec exercises;
  // the previous 1s budget flaked under full-suite parallel load (the operations
  // panel can take ~1.2s to mount when 380+ test files compete for the CPU).
  while (Date.now() - startedAt < 5_000) {
    await flush();
    const element = container.querySelector<T>(selector);
    if (element) return element;
  }
  throw new Error(`Timed out waiting for ${selector}`);
}

function makeAgent(overrides: Partial<AgentState>): AgentState {
  return {
    agentId: overrides.agentId ?? 'agent-1',
    taskId: overrides.taskId ?? 'task-1',
    taskName: overrides.taskName ?? 'Example task',
    events: [],
    anomaly: null,
    cwd: overrides.cwd ?? '/tmp/kookr',
    startedAt: '2026-05-24T00:00:00.000Z',
    taskStatus: overrides.taskStatus ?? 'inProgress',
    ...overrides,
  } as AgentState;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('App operations modal shortcuts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('kookr:onboarding:seen-v2', 'true');
    websocketMock.send.mockReset();
    websocketMock.send.mockImplementation(() => true);
    resetBugReportRecorderForTests();
    setDebugTimelineEnabledForTests(null);
    clearDebugTimeline();
    __resetViewerSessionForTests();
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/settings')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ cleanupWorktreeOnComplete: true }),
        } as Response);
      }
      if (url.includes('/api/anomaly-stats')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ checks: {}, fires: {}, falsePositives: {} }),
        } as Response);
      }
      if (url.includes('/api/schedules')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            revision: 1,
            schedules: [],
            status: {
              timezone: 'UTC',
              catchUpMode: 'auto',
              catchUpEnabled: true,
              schedulerHealthy: true,
            },
          }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ configured: false }),
      } as Response);
    }));
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = '';
    localStorage.clear();
    sessionStorage.clear();
    vi.useRealTimers();
    setDebugTimelineEnabledForTests(null);
    clearDebugTimeline();
    __resetViewerSessionForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    act(() => {
      closeOnboardingTour();
    });
  });

  test('global help shortcut is suppressed while diagnostics is modal', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });
    const operations = await waitForElement<HTMLButtonElement>(container, '.operations-trigger');

    await act(async () => {
      operations.click();
    });
    await waitForElement(container, '.operations-panel');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: '?',
        bubbles: true,
        cancelable: true,
      }));
    });
    await flush();

    expect(container.querySelector('.shortcuts-help')).toBeNull();
    expect(container.querySelector('.operations-panel')).not.toBeNull();
  });

  test('detail-panel complete requests open the feedback-enabled complete dialog', async () => {
    useKookrStore.setState({
      agents: [{
        agentId: 'agent-1',
        taskId: 'task-1',
        taskName: 'Example task',
        events: [],
        anomaly: null,
        cwd: '/tmp/kookr',
        startedAt: '2026-05-24T00:00:00.000Z',
        taskStatus: 'inProgress',
      }],
      selectedAgentId: 'agent-1',
    });

    await act(async () => {
      root.render(React.createElement(App));
    });

    const completeButton = await waitForElement<HTMLButtonElement>(container, '[data-testid="mock-complete-button"]');
    await act(async () => {
      completeButton.click();
    });
    await settleCleanupVerdicts();

    expect(container.textContent).toContain('Complete Task');
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Thumbs up"]')).toBeInstanceOf(HTMLButtonElement);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Thumbs down"]')).toBeInstanceOf(HTMLButtonElement);
    const cleanupCheckbox = await waitForElement<HTMLInputElement>(
      container,
      '.complete-cleanup-checkbox input[type="checkbox"]',
    );
    expect(cleanupCheckbox.checked).toBe(true);
  });

  test('TS-CLEANUP-002: completion dialog lets the user override worktree cleanup for one task', async () => {
    useKookrStore.setState({
      agents: [makeAgent({ agentId: 'agent-1', taskId: 'task-1' })],
      selectedAgentId: 'agent-1',
    });

    await act(async () => {
      root.render(React.createElement(App));
    });

    const completeButton = await waitForElement<HTMLButtonElement>(container, '[data-testid="mock-complete-button"]');
    await act(async () => {
      completeButton.click();
    });
    await settleCleanupVerdicts();
    const cleanupCheckbox = await waitForElement<HTMLInputElement>(
      container,
      '.complete-cleanup-checkbox input[type="checkbox"]',
    );
    expect(cleanupCheckbox.checked).toBe(true);

    await act(async () => {
      cleanupCheckbox.click();
    });
    const confirmButton = await waitForElement<HTMLButtonElement>(container, '.confirm-dialog-actions .btn-primary');
    await act(async () => {
      confirmButton.click();
    });

    expect(websocketMock.send).toHaveBeenCalledWith({
      type: 'completeTask',
      taskId: 'task-1',
      cleanupWorktree: false,
    });
  });

  test('TS-CLEANUP-003: uses the saved cleanup setting as the completion checkbox default', async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/settings')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ cleanupWorktreeOnComplete: false }),
        } as Response);
      }
      if (url.includes('/api/anomaly-stats')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ checks: {}, fires: {}, falsePositives: {} }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ configured: false }) } as Response);
    });
    useKookrStore.setState({
      agents: [makeAgent({ agentId: 'agent-1', taskId: 'task-1' })],
      selectedAgentId: 'agent-1',
    });

    await act(async () => {
      root.render(React.createElement(App));
    });
    await flush();

    const completeButton = await waitForElement<HTMLButtonElement>(container, '[data-testid="mock-complete-button"]');
    await act(async () => {
      completeButton.click();
    });
    await settleCleanupVerdicts();
    const cleanupCheckbox = await waitForElement<HTMLInputElement>(
      container,
      '.complete-cleanup-checkbox input[type="checkbox"]',
    );
    expect(cleanupCheckbox.checked).toBe(false);

    websocketMock.send.mockClear();
    const confirmButton = await waitForElement<HTMLButtonElement>(container, '.confirm-dialog-actions .btn-primary');
    await act(async () => {
      confirmButton.click();
    });
    expect(websocketMock.send).toHaveBeenCalledWith({
      type: 'completeTask',
      taskId: 'task-1',
      cleanupWorktree: false,
    });
  });

  test('does not override the server policy when settings have not loaded yet', async () => {
    let resolveSettings!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/settings')) {
        return new Promise<Response>((resolve) => {
          resolveSettings = resolve;
        });
      }
      if (url.includes('/api/anomaly-stats')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ checks: {}, fires: {}, falsePositives: {} }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ configured: false }) } as Response);
    });
    useKookrStore.setState({
      agents: [makeAgent({ agentId: 'agent-1', taskId: 'task-1' })],
      selectedAgentId: 'agent-1',
    });

    await act(async () => {
      root.render(React.createElement(App));
    });

    const completeButton = await waitForElement<HTMLButtonElement>(container, '[data-testid="mock-complete-button"]');
    await act(async () => {
      completeButton.click();
    });
    await settleCleanupVerdicts();
    const confirmButton = await waitForElement<HTMLButtonElement>(container, '.confirm-dialog-actions .btn-primary');
    await act(async () => {
      confirmButton.click();
    });

    expect(websocketMock.send).toHaveBeenCalledWith({ type: 'completeTask', taskId: 'task-1' });
    resolveSettings({
      ok: true,
      json: () => Promise.resolve({ cleanupWorktreeOnComplete: false }),
    } as Response);
  });

  test('a blocked worktree sends cleanupWorktree: false rather than omitting the field', async () => {
    // Omitting it would let the server's default decide, so a dialog that said
    // "kept — uncommitted changes" could still be followed by a removal.
    useKookrStore.setState({
      agents: [makeAgent({ agentId: 'agent-1', taskId: 'task-1' })],
      selectedAgentId: 'agent-1',
    });

    await act(async () => {
      root.render(React.createElement(App));
    });
    const completeButton = await waitForElement<HTMLButtonElement>(container, '[data-testid="mock-complete-button"]');
    await act(async () => {
      completeButton.click();
    });
    await settleCleanupVerdicts([{
      ...removableVerdict(),
      removable: false,
      blocker: 'uncommitted-changes',
    }]);

    const confirmButton = await waitForElement<HTMLButtonElement>(container, '.confirm-dialog-actions .btn-primary');
    await act(async () => {
      confirmButton.click();
    });

    expect(websocketMock.send).toHaveBeenCalledWith({
      type: 'completeTask',
      taskId: 'task-1',
      cleanupWorktree: false,
    });
  });

  test('refuses worktree cleanup for an active Ralph iteration, and says so on the wire', async () => {
    // The server refuses to complete an active loop's task outright
    // (task-lifecycle-commands: the Ralph branch returns before any cleanup),
    // so the old hidden checkbox was never a cleanup risk — it just vanished
    // with no explanation. Show it blocked, and state the refusal on the wire
    // rather than relying on a server short-circuit the client never declared.
    useKookrStore.setState({
      agents: [makeAgent({
        agentId: 'agent-1',
        taskId: 'task-1',
        ralphLoop: { status: 'running' } as never,
      })],
      selectedAgentId: 'agent-1',
    });

    await act(async () => {
      root.render(React.createElement(App));
    });
    const completeButton = await waitForElement<HTMLButtonElement>(container, '[data-testid="mock-complete-button"]');
    await act(async () => {
      completeButton.click();
    });
    // The server reports the worktree as removable; the live loop still vetoes it.
    await settleCleanupVerdicts();

    const cleanupCheckbox = container.querySelector<HTMLInputElement>('.complete-cleanup-checkbox input[type="checkbox"]');
    expect(cleanupCheckbox).not.toBeNull();
    expect(cleanupCheckbox!.disabled).toBe(true);
    expect(cleanupCheckbox!.checked).toBe(false);
    expect(container.textContent).toContain('Ralph loop still active');

    const confirmButton = await waitForElement<HTMLButtonElement>(container, '.confirm-dialog-actions .btn-primary');
    await act(async () => {
      confirmButton.click();
    });
    expect(websocketMock.send).toHaveBeenCalledWith({
      type: 'completeTask',
      taskId: 'task-1',
      cleanupWorktree: false,
    });
  });

  test('delete task undo cancels the deferred destructive send', async () => {
    useKookrStore.setState({
      agents: [
        makeAgent({
          agentId: 'done-agent',
          taskId: 'task-delete',
          taskName: 'Accidental delete',
          taskStatus: 'completed',
        }),
      ],
      selectedAgentId: 'done-agent',
    });

    await act(async () => {
      root.render(React.createElement(App));
    });

    const completedToggle = await waitForElement<HTMLButtonElement>(container, '.completed-section .section-header');
    await act(async () => {
      completedToggle.click();
    });

    const deleteButton = await waitForElement<HTMLButtonElement>(container, 'button[aria-label="Delete Accidental delete"]');
    websocketMock.send.mockClear();
    vi.useFakeTimers();
    await act(async () => {
      deleteButton.click();
    });

    expect(websocketMock.send).not.toHaveBeenCalledWith({
      type: 'deleteTask',
      taskId: 'task-delete',
    });
    expect(useKookrStore.getState().selectedAgentId).toBeNull();
    expect(container.querySelector('.completed-row.pending-deletion')?.textContent).toContain('deleting soon');
    expect(container.querySelector('.toast-undo')?.textContent).toContain('Deleting "Accidental delete"');

    const undoButton = container.querySelector<HTMLButtonElement>('.toast-action');
    expect(undoButton).toBeInstanceOf(HTMLButtonElement);
    act(() => {
      undoButton!.click();
    });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_DESTRUCTIVE_ACTION_UNDO_MS + 1);
    });

    expect(websocketMock.send).not.toHaveBeenCalledWith({
      type: 'deleteTask',
      taskId: 'task-delete',
    });
    expect(container.querySelector('.completed-row.pending-deletion')).toBeNull();
    expect(container.querySelector('.toast-undo')).toBeNull();
  });

  test('delete task sends only after the undo window expires', async () => {
    useKookrStore.setState({
      agents: [
        makeAgent({
          agentId: 'done-agent',
          taskId: 'task-delete',
          taskName: 'Expired delete',
          taskStatus: 'completed',
        }),
      ],
      selectedAgentId: null,
    });

    await act(async () => {
      root.render(React.createElement(App));
    });

    const completedToggle = await waitForElement<HTMLButtonElement>(container, '.completed-section .section-header');
    await act(async () => {
      completedToggle.click();
    });
    const deleteButton = await waitForElement<HTMLButtonElement>(container, 'button[aria-label="Delete Expired delete"]');
    websocketMock.send.mockClear();
    vi.useFakeTimers();
    await act(async () => {
      deleteButton.click();
    });

    expect(websocketMock.send).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(DEFAULT_DESTRUCTIVE_ACTION_UNDO_MS - 1);
    });
    expect(websocketMock.send).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(websocketMock.send).toHaveBeenCalledWith({
      type: 'deleteTask',
      taskId: 'task-delete',
    });
    expect(container.querySelector('.toast-undo')).toBeNull();
  });

  test('clear completed undo cancels the deferred project-scoped send', async () => {
    useKookrStore.setState({
      agents: [
        makeAgent({
          agentId: 'project-a-done',
          taskId: 'task-a',
          taskName: 'Project A done',
          projectId: 'github.com/acme/a',
          taskStatus: 'completed',
        }),
        makeAgent({
          agentId: 'project-b-done',
          taskId: 'task-b',
          taskName: 'Project B done',
          projectId: 'github.com/acme/b',
          taskStatus: 'completed',
        }),
      ],
      selectedProject: 'github.com/acme/a',
      selectedAgentId: null,
    });

    await act(async () => {
      root.render(React.createElement(App));
    });

    const completedToggle = await waitForElement<HTMLButtonElement>(container, '.completed-section .section-header');
    await act(async () => {
      completedToggle.click();
    });
    const clearButton = await waitForElement<HTMLButtonElement>(container, 'button.btn-clear-completed');
    await act(async () => {
      clearButton.click();
    });
    const deleteButton = await waitForElement<HTMLButtonElement>(container, '.confirm-dialog-actions .btn-danger');
    websocketMock.send.mockClear();
    vi.useFakeTimers();
    await act(async () => {
      deleteButton.click();
    });

    expect(websocketMock.send).not.toHaveBeenCalled();
    expect(container.querySelectorAll('.completed-row.pending-deletion')).toHaveLength(1);
    expect(container.querySelector('.toast-undo')?.textContent).toContain('Deleting 1 finished task');

    const undoButton = container.querySelector<HTMLButtonElement>('.toast-action');
    expect(undoButton).toBeInstanceOf(HTMLButtonElement);
    act(() => {
      undoButton!.click();
    });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_DESTRUCTIVE_ACTION_UNDO_MS + 1);
    });

    expect(websocketMock.send).not.toHaveBeenCalled();
    expect(container.querySelector('.completed-row.pending-deletion')).toBeNull();
  });

  test('clear completed deletes only the captured project task after the undo window expires', async () => {
    useKookrStore.setState({
      agents: [
        makeAgent({
          agentId: 'project-a-done',
          taskId: 'task-a',
          taskName: 'Project A done',
          projectId: 'github.com/acme/a',
          taskStatus: 'completed',
        }),
        makeAgent({
          agentId: 'project-b-done',
          taskId: 'task-b',
          taskName: 'Project B done',
          projectId: 'github.com/acme/b',
          taskStatus: 'completed',
        }),
      ],
      selectedProject: 'github.com/acme/a',
      selectedAgentId: null,
    });

    await act(async () => {
      root.render(React.createElement(App));
    });

    const clearButton = await waitForElement<HTMLButtonElement>(container, 'button.btn-clear-completed');
    await act(async () => {
      clearButton.click();
    });

    expect(container.querySelector('.confirm-dialog-message')?.textContent).toContain('Delete 1 finished task?');

    const deleteButton = await waitForElement<HTMLButtonElement>(container, '.confirm-dialog-actions .btn-danger');
    websocketMock.send.mockClear();
    vi.useFakeTimers();
    await act(async () => {
      deleteButton.click();
    });

    expect(websocketMock.send).not.toHaveBeenCalled();
    expect(container.querySelector('.toast-undo')?.textContent).toContain('Deleting 1 finished task');

    act(() => {
      vi.advanceTimersByTime(DEFAULT_DESTRUCTIVE_ACTION_UNDO_MS - 1);
    });
    expect(websocketMock.send).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(websocketMock.send).toHaveBeenCalledTimes(1);
    expect(websocketMock.send).toHaveBeenCalledWith({
      type: 'deleteTask',
      taskId: 'task-a',
    });
  });

  test('complete dialog can request reflection after thumbs-up feedback', async () => {
    useKookrStore.setState({
      agents: [{
        agentId: 'agent-1',
        taskId: 'task-1',
        taskName: 'Reflection task',
        events: [],
        anomaly: null,
        cwd: '/tmp/kookr',
        startedAt: '2026-05-24T00:00:00.000Z',
        taskStatus: 'inProgress',
      }],
      selectedAgentId: 'agent-1',
    });

    await act(async () => {
      root.render(React.createElement(App));
    });

    const completeButton = await waitForElement<HTMLButtonElement>(container, '[data-testid="mock-complete-button"]');
    await act(async () => {
      completeButton.click();
    });
    await settleCleanupVerdicts();

    const thumbsUp = await waitForElement<HTMLButtonElement>(container, 'button[aria-label="Thumbs up"]');
    await act(async () => {
      thumbsUp.click();
    });

    const reflectCheckbox = await waitForElement<HTMLInputElement>(
      container,
      '.complete-feedback-checkbox input[type="checkbox"]',
    );
    expect(reflectCheckbox.checked).toBe(false);
    await act(async () => {
      reflectCheckbox.click();
    });

    const confirmButton = await waitForElement<HTMLButtonElement>(container, '.confirm-dialog-actions .btn-primary');
    await act(async () => {
      confirmButton.click();
    });

    expect(websocketMock.send).toHaveBeenCalledWith({
      type: 'completeTask',
      taskId: 'task-1',
      feedback: { rating: 'up' },
      requestReflect: true,
      cleanupWorktree: true,
    });
  });

  test('complete dialog proposes reflection by default for thumbs-down feedback', async () => {
    useKookrStore.setState({
      agents: [{
        agentId: 'agent-1',
        taskId: 'task-1',
        taskName: 'Broken task',
        events: [],
        anomaly: null,
        cwd: '/tmp/kookr',
        startedAt: '2026-05-24T00:00:00.000Z',
        taskStatus: 'inProgress',
      }],
      selectedAgentId: 'agent-1',
    });

    await act(async () => {
      root.render(React.createElement(App));
    });

    const completeButton = await waitForElement<HTMLButtonElement>(container, '[data-testid="mock-complete-button"]');
    await act(async () => {
      completeButton.click();
    });
    await settleCleanupVerdicts();

    const thumbsDown = await waitForElement<HTMLButtonElement>(container, 'button[aria-label="Thumbs down"]');
    await act(async () => {
      thumbsDown.click();
    });

    const checkboxes = Array.from(container.querySelectorAll<HTMLInputElement>('.complete-feedback-checkbox input[type="checkbox"]'));
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[1]!.checked).toBe(true);

    const confirmButton = await waitForElement<HTMLButtonElement>(container, '.confirm-dialog-actions .btn-primary');
    await act(async () => {
      confirmButton.click();
    });

    expect(websocketMock.send).toHaveBeenCalledWith({
      type: 'completeTask',
      taskId: 'task-1',
      feedback: { rating: 'down' },
      requestReflect: true,
      cleanupWorktree: true,
    });
  });

  test('complete confirmation advances to the next available task', async () => {
    useKookrStore.setState({
      agents: [
        {
          agentId: 'agent-1',
          taskId: 'task-1',
          taskName: 'First task',
          events: [],
          anomaly: null,
          cwd: '/tmp/kookr',
          startedAt: '2026-05-24T00:00:00.000Z',
          taskStatus: 'inProgress',
        },
        {
          agentId: 'agent-2',
          taskId: 'task-2',
          taskName: 'Second task',
          events: [],
          anomaly: null,
          cwd: '/tmp/kookr',
          startedAt: '2026-05-24T00:01:00.000Z',
          taskStatus: 'inProgress',
        },
        {
          agentId: 'agent-3',
          taskId: 'task-3',
          taskName: 'Third task',
          events: [],
          anomaly: null,
          cwd: '/tmp/kookr',
          startedAt: '2026-05-24T00:02:00.000Z',
          taskStatus: 'inProgress',
        },
      ],
      selectedAgentId: 'agent-1',
    });

    await act(async () => {
      root.render(React.createElement(App));
    });

    const completeButton = await waitForElement<HTMLButtonElement>(container, '[data-testid="mock-complete-button"]');
    await act(async () => {
      completeButton.click();
    });
    await settleCleanupVerdicts();
    const confirmButton = await waitForElement<HTMLButtonElement>(container, '.confirm-dialog-actions .btn-primary');
    await act(async () => {
      confirmButton.click();
    });

    expect(websocketMock.send).toHaveBeenCalledWith({ type: 'completeTask', taskId: 'task-1', cleanupWorktree: true });
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-2');
  });

  test('complete confirmation does not steal focus after a manual selection change', async () => {
    useKookrStore.setState({
      agents: [
        {
          agentId: 'agent-1',
          taskId: 'task-1',
          taskName: 'First task',
          events: [],
          anomaly: null,
          cwd: '/tmp/kookr',
          startedAt: '2026-05-24T00:00:00.000Z',
          taskStatus: 'inProgress',
        },
        {
          agentId: 'agent-2',
          taskId: 'task-2',
          taskName: 'Second task',
          events: [],
          anomaly: null,
          cwd: '/tmp/kookr',
          startedAt: '2026-05-24T00:01:00.000Z',
          taskStatus: 'inProgress',
        },
      ],
      selectedAgentId: 'agent-1',
    });

    await act(async () => {
      root.render(React.createElement(App));
    });

    const completeButton = await waitForElement<HTMLButtonElement>(container, '[data-testid="mock-complete-button"]');
    await act(async () => {
      completeButton.click();
    });
    await settleCleanupVerdicts();
    await act(async () => {
      useKookrStore.getState().selectAgent('agent-3');
    });
    const confirmButton = await waitForElement<HTMLButtonElement>(container, '.confirm-dialog-actions .btn-primary');
    await act(async () => {
      confirmButton.click();
    });

    expect(websocketMock.send).toHaveBeenCalledWith({ type: 'completeTask', taskId: 'task-1', cleanupWorktree: true });
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-3');
  });

  test('complete confirmation does not advance when completion send fails', async () => {
    websocketMock.send.mockReturnValue(false);
    useKookrStore.setState({
      agents: [
        {
          agentId: 'agent-1',
          taskId: 'task-1',
          taskName: 'First task',
          events: [],
          anomaly: null,
          cwd: '/tmp/kookr',
          startedAt: '2026-05-24T00:00:00.000Z',
          taskStatus: 'inProgress',
        },
        {
          agentId: 'agent-2',
          taskId: 'task-2',
          taskName: 'Second task',
          events: [],
          anomaly: null,
          cwd: '/tmp/kookr',
          startedAt: '2026-05-24T00:01:00.000Z',
          taskStatus: 'inProgress',
        },
      ],
      selectedAgentId: 'agent-1',
    });

    await act(async () => {
      root.render(React.createElement(App));
    });

    const completeButton = await waitForElement<HTMLButtonElement>(container, '[data-testid="mock-complete-button"]');
    await act(async () => {
      completeButton.click();
    });
    await settleCleanupVerdicts();
    const confirmButton = await waitForElement<HTMLButtonElement>(container, '.confirm-dialog-actions .btn-primary');
    await act(async () => {
      confirmButton.click();
    });

    expect(websocketMock.send).toHaveBeenCalledWith({ type: 'completeTask', taskId: 'task-1', cleanupWorktree: true });
    expect(useKookrStore.getState().selectedAgentId).toBe('agent-1');
  });

  test('top-bar bug report opens a live bundle preview with recorder state and note edits', async () => {
    recordReportableAlert({
      agentId: 'agent-1',
      severity: 'error',
      summary: 'Malformed WebSocket message',
      details: 'payload failed schema validation',
    });
    useKookrStore.setState({
      agents: [{
        agentId: 'agent-1',
        taskId: 'task-1',
        events: [],
        anomaly: null,
        cwd: '/home/user/customer/repo',
        startedAt: '2026-05-24T00:00:00.000Z',
        taskStatus: 'inProgress',
      }],
      selectedAgentId: 'agent-1',
    });

    await act(async () => {
      root.render(React.createElement(App));
    });

    // Bug report now lives in the command palette (top-bar declutter): open the
    // palette, then run the "Bug report" action.
    const paletteTrigger = await waitForElement<HTMLButtonElement>(container, '[data-testid="command-trigger"]');
    await act(async () => {
      paletteTrigger.click();
    });
    const bugReport = await waitForElement<HTMLButtonElement>(container, '[data-action-id="bug-report"]');
    await act(async () => {
      bugReport.click();
    });

    const preview = await waitForElement<HTMLTextAreaElement>(container, '#bug-report-preview');
    expect(preview.value).toContain('"trigger": "alert"');
    expect(preview.value).toContain('"selectedAgentId": "agent-1"');
    expect(preview.value).toContain('"summaryCategory": "malformed_websocket"');

    const note = await waitForElement<HTMLTextAreaElement>(container, 'textarea[placeholder="What did you expect to happen?"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(note, 'user-added note');
    await act(async () => {
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(await waitForElement<HTMLTextAreaElement>(container, '#bug-report-preview')).toHaveProperty(
      'value',
      expect.stringContaining('user-added note'),
    );
  });

  test('read-only command palette hides owner actions but keeps finding and project navigation', async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/auth/session')) {
        return Promise.resolve({
          status: 200,
          json: () => Promise.resolve({ actor: 'viewer', scope: { kind: 'all' } }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ configured: false }),
      } as Response);
    });
    sessionStorage.setItem('kookr.viewer.session', JSON.stringify({ isViewer: true, scope: { kind: 'all' } }));
    const findingAgent = makeAgent({
      agentId: 'finding-agent',
      taskId: 'finding-task',
      taskName: 'Investigate launch failure',
      projectId: 'github.com/kookr-ai/kookr',
      anomaly: {
        agentId: 'finding-agent',
        type: 'api_error',
        severity: 'critical',
        explanation: 'Launch dependency failed',
        detectedAt: new Date('2026-06-21T00:00:00.000Z'),
      },
    });
    useKookrStore.setState({
      agents: [findingAgent],
      agentsHydrated: true,
      projectSummariesHydrated: true,
    });
    useKookrStore.getState().handleProjectSummaries([
      {
        project: 'github.com/kookr-ai/kookr',
        displayName: 'kookr',
        color: 0,
        activeAgents: 1,
        findingCount: 1,
        todayPrCount: 0,
        weekPrCount: 0,
        openContributionAttempts: 0,
        recentTasks: [{ taskId: 'finding-task', name: 'Investigate launch failure', status: 'inProgress' }],
        tracked: true,
        localPath: '/workspace/kookr',
      },
      {
        project: 'github.com/example/openclaw',
        displayName: 'openclaw',
        color: 1,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openContributionAttempts: 0,
        recentTasks: [],
        tracked: true,
        localPath: '/workspace/openclaw',
      },
    ]);
    useKookrStore.getState().selectProject('github.com/example/openclaw');

    await act(async () => {
      root.render(React.createElement(App));
    });

    const paletteTrigger = await waitForElement<HTMLButtonElement>(container, '[data-testid="command-trigger"]');
    await act(async () => {
      paletteTrigger.click();
    });

    expect(container.querySelector('[data-action-id="share-viewer"]')).toBeNull();
    expect(container.querySelector('[data-action-id="settings"]')).toBeNull();
    expect(container.querySelector('[data-action-id="schedules"]')).toBeNull();
    expect(container.querySelector('[data-action-id="launch"]')).toBeNull();
    expect(container.querySelector('[data-action-id="playbooks"]')).toBeNull();
    expect(container.querySelector('[data-action-id="tour"]')).not.toBeNull();

    const input = await waitForElement<HTMLInputElement>(container, '[data-testid="command-palette-input"]');
    await act(async () => setInputValue(input, 'api error'));
    const findingRow = await waitForElement<HTMLButtonElement>(container, '[data-testid="command-palette-finding"]');
    expect(findingRow.textContent).toContain('critical · API Error');
    await act(async () => {
      findingRow.click();
    });
    expect(useKookrStore.getState().selectedAgentId).toBe('finding-agent');

    await act(async () => {
      paletteTrigger.click();
    });
    const projectInput = await waitForElement<HTMLInputElement>(container, '[data-testid="command-palette-input"]');
    await act(async () => setInputValue(projectInput, 'kookr-ai'));
    const projectRow = await waitForElement<HTMLButtonElement>(container, '[data-testid="command-palette-project"]');
    await act(async () => {
      projectRow.click();
    });
    expect(useKookrStore.getState().selectedProject).toBe('github.com/kookr-ai/kookr');
  });

  test('command palette exposes Launch and Playbooks actions for owners and opens the matching tab', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });

    const paletteTrigger = await waitForElement<HTMLButtonElement>(container, '[data-testid="command-trigger"]');
    await act(async () => {
      paletteTrigger.click();
    });

    const launch = await waitForElement<HTMLButtonElement>(container, '[data-action-id="launch"]');
    const playbooks = await waitForElement<HTMLButtonElement>(container, '[data-action-id="playbooks"]');
    expect(launch.textContent).toContain('Launch task');
    expect(playbooks.textContent).toContain('Browse playbooks');

    const paletteInput = await waitForElement<HTMLInputElement>(container, '[data-testid="command-palette-input"]');
    await act(async () => setInputValue(paletteInput, 'spawn'));
    const spawnHits = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="command-palette-action"]'))
      .map((row) => row.dataset.actionId);
    expect(spawnHits).toEqual(['launch', 'playbooks']);

    const launchAfterFilter = await waitForElement<HTMLButtonElement>(container, '[data-action-id="launch"]');
    await act(async () => {
      launchAfterFilter.click();
    });
    await waitForElement(container, '#launch-task-dialog-title');
    expect(container.querySelector('.dialog-tab.active')?.textContent).toBe('Manual');

    const close = await waitForElement<HTMLButtonElement>(container, '.dialog-close');
    await act(async () => {
      close.click();
    });
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5_000) {
      await flush();
      if (container.querySelector('#launch-task-dialog-title') === null) break;
    }
    expect(container.querySelector('#launch-task-dialog-title')).toBeNull();

    await act(async () => {
      paletteTrigger.click();
    });
    const playbooksAgain = await waitForElement<HTMLButtonElement>(container, '[data-action-id="playbooks"]');
    await act(async () => {
      playbooksAgain.click();
    });
    await waitForElement(container, '#launch-task-dialog-title');
    expect(container.querySelector('.dialog-tab.active')?.textContent).toBe('Playbooks');

    await act(async () => {
      paletteTrigger.click();
    });
    const launchAgain = await waitForElement<HTMLButtonElement>(container, '[data-action-id="launch"]');
    await act(async () => {
      launchAgain.click();
    });
    await waitForElement(container, '#launch-task-dialog-title');
    expect(container.querySelector('.dialog-tab.active')?.textContent).toBe('Manual');
  });

  test('command palette exposes Take the tour after tasks exist and opens the existing overlay', async () => {
    useKookrStore.setState({
      agents: [makeAgent({ agentId: 'agent-1', taskId: 'task-1' })],
      agentsHydrated: true,
    });

    await act(async () => {
      root.render(React.createElement(App));
    });

    expect(container.querySelector('[data-testid="onboarding-overlay"]')).toBeNull();

    const paletteTrigger = await waitForElement<HTMLButtonElement>(container, '[data-testid="command-trigger"]');
    await act(async () => {
      paletteTrigger.click();
    });

    const tour = await waitForElement<HTMLButtonElement>(container, '[data-action-id="tour"]');
    expect(tour.textContent).toContain('Take the tour');

    const paletteInput = await waitForElement<HTMLInputElement>(container, '[data-testid="command-palette-input"]');
    await act(async () => setInputValue(paletteInput, 'tour'));
    const tourHits = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="command-palette-action"]'))
      .map((row) => row.dataset.actionId);
    expect(tourHits).toContain('tour');

    const tourAfterFilter = await waitForElement<HTMLButtonElement>(container, '[data-action-id="tour"]');
    await act(async () => {
      tourAfterFilter.click();
    });
    await waitForElement(container, '[data-testid="onboarding-overlay"]');
    expect(container.querySelector('[data-testid="onboarding-overlay"]')).not.toBeNull();
    expect(container.textContent).toContain('Welcome to Kookr');
  });

  test('overview recent-playbook callback opens Launch on the Playbooks tab', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });

    const recent = await waitForElement<HTMLButtonElement>(container, '[data-testid="mock-launch-playbooks"]');
    await act(async () => {
      recent.click();
    });
    await waitForElement(container, '#launch-task-dialog-title');
    expect(container.querySelector('.dialog-tab.active')?.textContent).toBe('Playbooks');
  });

  test('overview next-schedule callback opens the existing Schedules dialog', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });

    const nextSchedule = await waitForElement<HTMLButtonElement>(container, '[data-testid="mock-open-schedules"]');
    await act(async () => {
      nextSchedule.click();
    });
    await waitForElement(container, '.schedules-dialog');
    expect(container.querySelector('.schedules-dialog-header')?.textContent).toContain('Schedules');
  });

  test('debug timeline export downloads a redacted bundle', async () => {
    setDebugTimelineEnabledForTests(true);
    recordOutbound({ type: 'respond', agentId: 'agent-1', input: 'proprietary design notes' });
    let downloadedBlob: Blob | null = null;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    class TestURL extends URL {
      static createObjectURL = vi.fn((blob: Blob) => {
        downloadedBlob = blob;
        return 'blob:debug-trace';
      });
      static revokeObjectURL = vi.fn();
    }
    vi.stubGlobal('URL', TestURL);

    await act(async () => {
      root.render(React.createElement(App));
    });

    const exportTrace = await waitForElement<HTMLButtonElement>(container, '.debug-timeline-actions .btn-primary');
    await act(async () => {
      exportTrace.click();
    });

    expect(clickSpy).toHaveBeenCalled();
    expect(downloadedBlob).not.toBeNull();
    const serialized = await downloadedBlob!.text();
    expect(serialized).toContain('"debugTimeline"');
    expect(serialized).toContain('"summary": "websocket outbound respond');
    expect(serialized).toContain('"wireObservations": []');
    expect(serialized).not.toContain('proprietary design notes');
    expect(serialized).not.toContain('"input"');
  });

  test('global shortcuts are suppressed while bug report dialog is open', async () => {
    useKookrStore.setState({
      agents: [
        {
          agentId: 'agent-1',
          taskId: 'task-1',
          taskName: 'First task',
          events: [],
          anomaly: null,
          cwd: '/tmp/kookr',
          startedAt: '2026-05-24T00:00:00.000Z',
          taskStatus: 'inProgress',
        },
        {
          agentId: 'agent-2',
          taskId: 'task-2',
          taskName: 'Second task',
          events: [],
          anomaly: null,
          cwd: '/tmp/kookr',
          startedAt: '2026-05-24T00:01:00.000Z',
          taskStatus: 'inProgress',
        },
      ],
      selectedAgentId: 'agent-1',
    });

    await act(async () => {
      root.render(React.createElement(App));
    });

    // Bug report now lives in the command palette (top-bar declutter): open the
    // palette, then run the "Bug report" action.
    const paletteTrigger = await waitForElement<HTMLButtonElement>(container, '[data-testid="command-trigger"]');
    await act(async () => {
      paletteTrigger.click();
    });
    const bugReport = await waitForElement<HTMLButtonElement>(container, '[data-action-id="bug-report"]');
    await act(async () => {
      bugReport.click();
    });
    await waitForElement<HTMLTextAreaElement>(container, '#bug-report-preview');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'j',
        bubbles: true,
        cancelable: true,
      }));
    });
    await flush();

    expect(useKookrStore.getState().selectedAgentId).toBe('agent-1');
  });
});
