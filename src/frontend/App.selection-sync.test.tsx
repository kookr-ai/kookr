// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState } from '../shared/protocol.js';
import { App } from './App.js';
import { createKookrStore, useKookrStore } from './store/useStore.js';
import { __resetViewerSessionForTests } from './viewer-session.js';

const sendMock = vi.hoisted(() => vi.fn(() => true));

vi.mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: () => ({ send: sendMock }),
}));

vi.mock('./hooks/useNotifications.js', () => ({
  useNotifications: () => {},
}));

vi.mock('./hooks/useTabAttentionBadge.js', () => ({
  useTabAttentionBadge: () => {},
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
  DetailPanel: () => React.createElement('div', { 'data-testid': 'detail-panel' }),
}));

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: overrides.agentId ?? 'agent-1',
    taskId: overrides.taskId ?? 'task-1',
    taskName: overrides.taskName ?? 'Example task',
    events: [],
    anomaly: null,
    cwd: '/tmp/kookr',
    startedAt: '2026-06-30T00:00:00.000Z',
    taskStatus: 'inProgress',
    ...overrides,
  } as AgentState;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function selectionChangedMessages() {
  return sendMock.mock.calls
    .map(([message]) => message)
    .filter((message) => message?.type === 'selectionChanged');
}

describe('App dashboard selection sync', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('kookr:onboarding:seen-v2', 'true');
    sendMock.mockClear();
    __resetViewerSessionForTests();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ configured: false }),
    } as Response)));
    syncGlobalStore();
    useKookrStore.setState({
      agents: [makeAgent()],
      agentsHydrated: true,
      projectSummariesHydrated: true,
      sttUrl: '',
    });
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetViewerSessionForTests();
  });

  test('sends the selected task when local selection differs from server dashboard selection', async () => {
    useKookrStore.setState({ selectedAgentId: 'agent-1' });

    await act(async () => {
      root.render(React.createElement(App));
    });
    await flush();

    expect(selectionChangedMessages()).toEqual([{
      type: 'selectionChanged',
      selectedTaskId: 'task-1',
      selectedSessionId: 'agent-1',
    }]);
  });

  test('does not echo a live server-applied dashboard selection back to the server', async () => {
    await act(async () => {
      root.render(React.createElement(App));
    });
    await flush();
    sendMock.mockClear();

    await act(async () => {
      useKookrStore.getState().handleDashboardSelection({
        selectedTaskId: 'task-1',
        selectedSessionId: 'agent-1',
        selectionVersion: 42,
      });
    });
    await flush();

    expect(selectionChangedMessages()).toEqual([]);
  });
});
