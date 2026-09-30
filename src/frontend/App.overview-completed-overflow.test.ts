// @vitest-environment jsdom

/**
 * App wiring for the overview "+N more in Completed" overflow (issue #3392).
 * OverviewEmptyState tests inject the opener; this file checks that App
 * threads expandCompletedRail through DetailPanel so clicking the overflow
 * bumps the FindingsPanel expand nonce — the same opener the status-bar
 * 24h chip already uses (#3333).
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { App } from './App.js';
import { createKookrStore, useKookrStore } from './store/useStore.js';
import { __resetViewerSessionForTests } from './viewer-session.js';
import type { AgentState } from '../shared/protocol.js';

const { findingsPanelProps } = vi.hoisted(() => ({
  findingsPanelProps: { current: null as { expandCompletedNonce?: number } | null },
}));

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

vi.mock('./components/DetailPanel.js', async () => {
  const { OverviewEmptyState } = await import('./components/OverviewEmptyState.js');
  return {
    DetailPanel: (props: {
      onExpandCompleted?: () => void;
      overview?: { waiting: AgentState[]; running: AgentState[]; completed: AgentState[] };
    }) => React.createElement(OverviewEmptyState, {
      waiting: props.overview?.waiting ?? [],
      running: props.overview?.running ?? [],
      completed: props.overview?.completed ?? [],
      onLaunch: () => {},
      onExpandCompleted: props.onExpandCompleted,
    }),
  };
});

vi.mock('./components/FindingsPanel.js', () => ({
  FindingsPanel: (props: { expandCompletedNonce?: number }) => {
    findingsPanelProps.current = props;
    return React.createElement('div', { 'data-testid': 'findings-panel' });
  },
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

function seedCompleted(count: number): void {
  const now = Date.now();
  useKookrStore.setState({
    agents: Array.from({ length: count }, (_, i) => makeAgent({
      agentId: `done-${i}`,
      taskId: `t${i}`,
      taskName: `Done ${i}`,
      taskStatus: 'completed',
      finishedAt: new Date(now - (i + 1) * 60 * 60 * 1000).toISOString(),
    })),
    agentsHydrated: true,
    projectSummariesHydrated: true,
    sttUrl: '',
  });
}

describe('App overview completed overflow wiring (issue #3392)', () => {
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

  test('clicking the overview overflow bumps the Completed-rail expand nonce', async () => {
    seedCompleted(4);

    await act(async () => {
      root.render(React.createElement(App));
    });
    await flush();

    const before = findingsPanelProps.current?.expandCompletedNonce ?? 0;
    const overflow = container.querySelector<HTMLButtonElement>('[data-testid="overview-completed-overflow"]');
    expect(overflow?.tagName).toBe('BUTTON');
    expect(overflow?.textContent).toBe('+1 more in Completed');

    await act(async () => {
      overflow!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(findingsPanelProps.current?.expandCompletedNonce).toBe(before + 1);
  });

  test('the status-bar 24h chip still bumps the same nonce (unchanged from #3333)', async () => {
    seedCompleted(4);

    await act(async () => {
      root.render(React.createElement(App));
    });
    await flush();

    const before = findingsPanelProps.current?.expandCompletedNonce ?? 0;
    const chip = container.querySelector<HTMLButtonElement>('[data-testid="completed-24h-chip"]');
    expect(chip?.tagName).toBe('BUTTON');

    await act(async () => {
      chip!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(findingsPanelProps.current?.expandCompletedNonce).toBe(before + 1);
    expect(container.querySelector('[data-testid="overview-completed-overflow"]')).not.toBeNull();
  });

  test('hides the overflow control when three or fewer completed tasks exist', async () => {
    seedCompleted(3);

    await act(async () => {
      root.render(React.createElement(App));
    });
    await flush();

    expect(container.querySelector('[data-testid="overview-completed-overflow"]')).toBeNull();
    expect(container.textContent).not.toContain('more in Completed');
    expect(container.querySelector('[data-testid="completed-24h-chip"]')).not.toBeNull();
  });
});
