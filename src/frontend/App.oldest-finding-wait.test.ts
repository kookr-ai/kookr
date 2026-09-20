// @vitest-environment jsdom

/**
 * App wiring for the oldest-finding-wait chip (issue #3343). StatusBar tests
 * inject a click handler; this file checks that the live findings list
 * identifies the oldest unanswered finding and that clicking the chip
 * selects that agent — not a completed or healthy row.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';
import { createKookrStore, useKookrStore } from './store/useStore.js';
import { __resetViewerSessionForTests } from './viewer-session.js';
import type { AgentState } from '../shared/protocol.js';
import type { Anomaly } from '../shared/contracts/anomalies.js';

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

function makeAnomaly(agentId: string, detectedAt: Date, explanation: string): Anomaly {
  return {
    agentId,
    type: 'needs_input',
    severity: 'warning',
    explanation,
    detectedAt,
  };
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

describe('App oldest-finding-wait chip wiring (issue #3343)', () => {
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

  test('clicking the chip selects the older of two live findings', async () => {
    const now = Date.now();
    useKookrStore.setState({
      agents: [
        makeAgent({
          agentId: 'newer',
          taskId: 'task-newer',
          anomaly: makeAnomaly('newer', new Date(now - 4 * 60_000), 'newer wait'),
        }),
        makeAgent({
          agentId: 'older',
          taskId: 'task-older',
          anomaly: makeAnomaly('older', new Date(now - 12 * 60_000), 'older wait'),
        }),
        makeAgent({
          agentId: 'healthy',
          taskId: 'task-healthy',
          anomaly: null,
        }),
        makeAgent({
          agentId: 'done',
          taskId: 'task-done',
          taskStatus: 'completed',
          finishedAt: new Date(now - 60 * 60 * 1000).toISOString(),
          anomaly: makeAnomaly('done', new Date(now - 60 * 60_000), 'stale leftover'),
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

    const chip = container.querySelector<HTMLButtonElement>('[data-testid="oldest-finding-wait-chip"]');
    expect(chip?.tagName).toBe('BUTTON');
    expect(chip?.textContent).toBe('oldest 12m');

    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(useKookrStore.getState().selectedAgentId).toBe('older');
    expect(useKookrStore.getState().selectedTaskId).toBe('task-older');
  });

  test('completed-count chip stays a separate click-through next to oldest wait', async () => {
    const now = Date.now();
    useKookrStore.setState({
      agents: [
        makeAgent({
          agentId: 'waiting',
          taskId: 'task-waiting',
          anomaly: makeAnomaly('waiting', new Date(now - 12 * 60_000), 'waiting'),
        }),
        makeAgent({
          agentId: 'done-1',
          taskId: 't1',
          taskStatus: 'completed',
          finishedAt: new Date(now - 60 * 60 * 1000).toISOString(),
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

    const oldestChip = container.querySelector('[data-testid="oldest-finding-wait-chip"]');
    const completedChip = container.querySelector('[data-testid="completed-24h-chip"]');
    expect(oldestChip?.tagName).toBe('BUTTON');
    expect(completedChip?.tagName).toBe('BUTTON');

    await act(async () => {
      completedChip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(useKookrStore.getState().selectedAgentId).toBeNull();
  });
});
