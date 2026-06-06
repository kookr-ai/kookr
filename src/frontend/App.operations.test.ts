// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';
import { createKookrStore, useKookrStore } from './store/useStore.js';
import { recordOutbound, recordReportableAlert, resetBugReportRecorderForTests } from './bug-report-recorder.js';
import { clearDebugTimeline, setDebugTimelineEnabledForTests } from './debug-timeline.js';
import type { AgentState } from '../shared/protocol.js';

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
  DetailPanel: (props: { onRequestComplete: () => void }) => React.createElement(
    'div',
    { 'data-testid': 'detail-panel' },
    React.createElement('button', { 'data-testid': 'mock-complete-button', onClick: props.onRequestComplete }, 'Complete'),
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
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/anomaly-stats')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ checks: {}, fires: {}, falsePositives: {} }),
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
    setDebugTimelineEnabledForTests(null);
    clearDebugTimeline();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

    expect(container.textContent).toContain('Complete Task');
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Thumbs up"]')).toBeInstanceOf(HTMLButtonElement);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Thumbs down"]')).toBeInstanceOf(HTMLButtonElement);
  });

  test('clear completed from a selected project panel sends project scope', async () => {
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
    await act(async () => {
      deleteButton.click();
    });

    expect(websocketMock.send).toHaveBeenCalledWith({
      type: 'clearCompleted',
      includeTerminated: false,
      projectId: 'github.com/acme/a',
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
    const confirmButton = await waitForElement<HTMLButtonElement>(container, '.confirm-dialog-actions .btn-primary');
    await act(async () => {
      confirmButton.click();
    });

    expect(websocketMock.send).toHaveBeenCalledWith({ type: 'completeTask', taskId: 'task-1' });
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
    await act(async () => {
      useKookrStore.getState().selectAgent('agent-3');
    });
    const confirmButton = await waitForElement<HTMLButtonElement>(container, '.confirm-dialog-actions .btn-primary');
    await act(async () => {
      confirmButton.click();
    });

    expect(websocketMock.send).toHaveBeenCalledWith({ type: 'completeTask', taskId: 'task-1' });
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
    const confirmButton = await waitForElement<HTMLButtonElement>(container, '.confirm-dialog-actions .btn-primary');
    await act(async () => {
      confirmButton.click();
    });

    expect(websocketMock.send).toHaveBeenCalledWith({ type: 'completeTask', taskId: 'task-1' });
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
