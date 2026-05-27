// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';
import { createKookrStore, useKookrStore } from './store/useStore.js';
import { recordReportableAlert, resetBugReportRecorderForTests } from './bug-report-recorder.js';

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

describe('App operations modal shortcuts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('kookr:onboarding:seen-v2', 'true');
    websocketMock.send.mockClear();
    resetBugReportRecorderForTests();
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
    vi.restoreAllMocks();
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

  test('complete confirmation keeps the task selected when the dialog opened', async () => {
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
      useKookrStore.getState().selectAgent('agent-2');
    });
    const confirmButton = await waitForElement<HTMLButtonElement>(container, '.confirm-dialog-actions .btn-primary');
    await act(async () => {
      confirmButton.click();
    });

    expect(websocketMock.send).toHaveBeenCalledWith({ type: 'completeTask', taskId: 'task-1' });
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

    const bugReport = await waitForElement<HTMLButtonElement>(container, 'button[aria-label="Bug report"]');
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

    const bugReport = await waitForElement<HTMLButtonElement>(container, 'button[aria-label="Bug report"]');
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
