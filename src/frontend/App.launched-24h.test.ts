// @vitest-environment jsdom

/**
 * App wiring for the 24-hour launched-task chip (issue #2632). StatusBar
 * tests inject a number; this file checks that live agents with startedAt
 * actually produce that number, and that the completed chip is unchanged.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';
import { createKookrStore, useKookrStore } from './store/useStore.js';
import { __resetViewerSessionForTests } from './viewer-session.js';
import type { AgentState } from '../shared/protocol.js';

vi.mock('./hooks/useWebSocket.js', () => ({
  useWebSocket: () => ({ send: () => true }),
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

vi.mock('./components/TopBar.js', () => ({
  TopBar: () => React.createElement('div', { 'data-testid': 'top-bar' }),
}));

vi.mock('./components/DetailPanel.js', () => ({
  DetailPanel: () => React.createElement('div', { 'data-testid': 'detail-panel' }),
}));

vi.mock('./components/FindingsPanel.js', () => ({
  FindingsPanel: () => React.createElement('div', { 'data-testid': 'findings-panel' }),
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

function makeAgent(overrides: Partial<AgentState>): AgentState {
  return {
    agentId: overrides.agentId ?? 'agent-1',
    taskId: overrides.taskId ?? 'task-1',
    taskName: overrides.taskName ?? 'Example task',
    events: [],
    anomaly: null,
    cwd: overrides.cwd ?? '/tmp/kookr',
    startedAt: '2026-08-17T00:00:00.000Z',
    taskStatus: overrides.taskStatus ?? 'inProgress',
    ...overrides,
  } as AgentState;
}

describe('App launched-task 24h chip wiring (issue #2632)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('kookr:onboarding:seen-v2', 'true');
    __resetViewerSessionForTests();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ configured: false }),
    } as Response)));
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetViewerSessionForTests();
  });

  test('shows 3 launched / 24h from live agents that started in the window', async () => {
    const now = Date.now();
    useKookrStore.setState({
      agents: [
        makeAgent({
          agentId: 'new-1', taskId: 't1',
          startedAt: new Date(now - 60 * 60 * 1000).toISOString(),
        }),
        makeAgent({
          agentId: 'new-2', taskId: 't2', taskStatus: 'completed',
          startedAt: new Date(now - 8 * 60 * 60 * 1000).toISOString(),
          finishedAt: new Date(now - 7 * 60 * 60 * 1000).toISOString(),
        }),
        makeAgent({
          agentId: 'new-3', taskId: 't3', taskStatus: 'pending',
          startedAt: new Date(now - 23 * 60 * 60 * 1000).toISOString(),
        }),
        makeAgent({
          agentId: 'old', taskId: 't-old',
          startedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
        }),
        makeAgent({
          agentId: 'no-start', taskId: 't-none',
          startedAt: undefined,
          finishedAt: new Date(now - 10 * 60 * 1000).toISOString(),
          taskStatus: 'completed',
        }),
      ],
      agentsHydrated: true,
      projectSummariesHydrated: true,
      sttUrl: '',
    });

    await act(async () => {
      root.render(React.createElement(App));
    });
    await flush();

    const chip = container.querySelector('[data-testid="launched-24h-chip"]');
    expect(chip?.textContent).toBe('3 launched / 24h');
  });

  test('hides the chip when no live agent started in the window', async () => {
    const now = Date.now();
    useKookrStore.setState({
      agents: [
        makeAgent({
          agentId: 'old', taskId: 't-old',
          startedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
        }),
        makeAgent({
          agentId: 'no-start', taskId: 't-none',
          startedAt: undefined,
        }),
      ],
      agentsHydrated: true,
      projectSummariesHydrated: true,
      sttUrl: '',
    });

    await act(async () => {
      root.render(React.createElement(App));
    });
    await flush();

    expect(container.querySelector('[data-testid="launched-24h-chip"]')).toBeNull();
    expect(container.textContent).not.toContain('launched /');
  });

  test('still shows the completed chip when a recent finish has no start time', async () => {
    const now = Date.now();
    useKookrStore.setState({
      agents: [
        makeAgent({
          agentId: 'done-no-start', taskId: 't-done', taskStatus: 'completed',
          startedAt: undefined,
          finishedAt: new Date(now - 30 * 60 * 1000).toISOString(),
        }),
        makeAgent({
          agentId: 'fresh-start', taskId: 't-fresh',
          startedAt: new Date(now - 20 * 60 * 1000).toISOString(),
        }),
      ],
      agentsHydrated: true,
      projectSummariesHydrated: true,
      sttUrl: '',
    });

    await act(async () => {
      root.render(React.createElement(App));
    });
    await flush();

    expect(container.querySelector('[data-testid="launched-24h-chip"]')?.textContent)
      .toBe('1 launched / 24h');
    expect(container.querySelector('[data-testid="completed-24h-chip"]')?.textContent)
      .toBe('1 completed / 24h');
  });
});
