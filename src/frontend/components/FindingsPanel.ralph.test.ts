// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FindingsPanel } from './FindingsPanel.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import type { AgentState, ClientMessage } from '../../shared/protocol.js';

type AgentWithRalphOverrides = Omit<Partial<AgentState>, 'ralphLoop'> & {
  ralphLoop?: Partial<NonNullable<AgentState['ralphLoop']>>;
};

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

async function flush() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function stubAttachFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/anomaly-stats') {
      return {
        ok: true,
        json: async () => ({ checks: {}, fires: {}, falsePositives: {} }),
      };
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function agentWithRalph(
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' = 'running',
  overrides: AgentWithRalphOverrides = {},
): AgentState {
  return {
    agentId: overrides.agentId ?? 'agent-1',
    taskId: overrides.taskId ?? 'task-1',
    taskName: 'Loop task',
    description: 'Working',
    events: [],
    anomaly: null,
    taskStatus: 'inProgress',
    cwd: '/tmp/project',
    tokenUsage: overrides.tokenUsage,
    ralphLoop: {
      prompt: 'go',
      iterationCap: 5,
      currentIteration: 2,
      status,
      lastIterationStartedAt: overrides.ralphLoop?.lastIterationStartedAt ?? 0,
      cumulativeIterations: 2,
      ...overrides.ralphLoop,
    },
    ...overrides,
  } as AgentState;
}

function agentWithoutRalph(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: overrides.agentId ?? 'agent-plain',
    taskId: overrides.taskId ?? 'task-plain',
    taskName: overrides.taskName ?? 'Plain task',
    description: 'Working',
    events: [],
    anomaly: null,
    taskStatus: 'inProgress',
    cwd: '/tmp/project',
    ...overrides,
  } as AgentState;
}

function renderPanel(container: HTMLElement, agent: AgentState, send: (msg: ClientMessage) => void = vi.fn()): Root {
  return renderPanelWithLists(container, { healthy: [agent] }, send);
}

function renderPanelWithLists(
  container: HTMLElement,
  lists: Partial<Pick<React.ComponentProps<typeof FindingsPanel>, 'findings' | 'healthy' | 'pending' | 'completed' | 'snoozed'>>,
  send: (msg: ClientMessage) => void = vi.fn(),
  selectedAgentId: string | null = null,
): Root {
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(FindingsPanel, {
      findings: lists.findings ?? [],
      healthy: lists.healthy ?? [],
      pending: lists.pending ?? [],
      completed: lists.completed ?? [],
      snoozed: lists.snoozed ?? [],
      selectedAgentId,
      send,
      clearCompletedFinishedCount: 0,
      clearCompletedTerminatedCount: 0,
    }));
  });
  return root;
}

describe('FindingsPanel Ralph controls', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    syncGlobalStore();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      text: async () => JSON.stringify({ ok: true, status: 'paused' }),
    })));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test('running Ralph loop renders pause and cancel controls and calls pause endpoint', async () => {
    root = renderPanel(container, agentWithRalph('running'));

    expect(container.textContent).toContain('2/5');
    const pause = container.querySelector<HTMLButtonElement>('button[aria-label="Pause Ralph loop"]');
    const cancel = container.querySelector<HTMLButtonElement>('button[aria-label="Cancel Ralph loop"]');
    expect(pause).toBeTruthy();
    expect(cancel).toBeTruthy();

    await act(async () => {
      pause!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(fetch).toHaveBeenCalledWith('/api/tasks/task-1/ralph-loop/pause', { method: 'POST' });
  });

  test('paused Ralph loop renders resume and cancel controls and calls resume endpoint', async () => {
    root = renderPanel(container, agentWithRalph('paused'));

    const resume = container.querySelector<HTMLButtonElement>('button[aria-label="Resume Ralph loop"]');
    expect(resume).toBeTruthy();
    expect(container.querySelector('button[aria-label="Pause Ralph loop"]')).toBeNull();

    await act(async () => {
      resume!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(fetch).toHaveBeenCalledWith('/api/tasks/task-1/ralph-loop/resume', { method: 'POST' });
  });

  test('terminal Ralph loop shows the badge without controls', () => {
    root = renderPanel(container, agentWithRalph('completed'));

    expect(container.textContent).toContain('2/5');
    expect(container.querySelector('button[aria-label="Pause Ralph loop"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Resume Ralph loop"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Cancel Ralph loop"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Attach Ralph loop"]')).toBeNull();
  });

  test('finding cards keep Ralph controls out of the constrained context row', () => {
    root = renderPanelWithLists(container, {
      findings: [agentWithRalph('running', {
        anomaly: {
          type: 'needs_input',
          severity: 'info',
          explanation: 'waiting for guidance',
          detectedAt: '2026-04-06T10:00:00.000Z',
        },
      })],
    });

    expect(container.querySelector('.finding-context .ralph-loop-controls')).toBeNull();
    const loopRow = container.querySelector('.finding-loop-row');
    expect(loopRow?.querySelector('.ralph-loop-controls')).toBeTruthy();
    expect(loopRow?.querySelector('button[aria-label="Pause Ralph loop"]')).toBeTruthy();
    expect(loopRow?.querySelector('.ralph-loop-badge')?.textContent).toContain('2/5');
  });

  test('completed Ralph loops keep the iteration badge in the completed section', () => {
    root = renderPanelWithLists(container, {
      completed: [agentWithRalph('completed', {
        agentId: 'agent-completed',
        taskId: 'task-completed',
        taskName: 'Wrapped-up loop',
        taskStatus: 'completed',
      })],
    });

    // The completed section starts collapsed by default; expand it first.
    act(() => {
      const sectionHeader = container.querySelector('.completed-section .section-header') as HTMLElement | null;
      sectionHeader?.click();
    });

    const completedBadge = container.querySelector('.completed-row .ralph-loop-badge');
    expect(completedBadge?.textContent).toContain('2/5');
  });

  test('healthy rows give the task name its own full-width line', () => {
    root = renderPanel(container, agentWithRalph('running', {
      taskName: 'A very long Ralph-controlled task name that still needs visible room',
      gitBranch: 'feature/long-running-ralph-loop-controls',
    }));

    const row = container.querySelector('.healthy-row');
    // Title Lead: the name is a direct, full-width line of the row — it does not
    // share a line with badges, controls, or the branch.
    const name = row?.querySelector(':scope > .healthy-row-name');
    expect(name?.textContent).toContain('A very long Ralph-controlled task name');
    expect(name?.querySelector('[data-testid="reply-button"]')).toBeNull();
    expect(name?.querySelector('.ralph-loop-controls')).toBeNull();

    // Branch / worktree is intentionally no longer rendered on the card — it now
    // lives only in the detail panel.
    expect(row?.querySelector('.branch-label')).toBeNull();

    // The action rail (reply + Ralph controls) lives in the info row below the
    // name. Reply is icon-only now, so assert on its data-testid, not its text.
    const info = row?.querySelector(':scope > .healthy-row-info');
    expect(info?.querySelector('[data-testid="reply-button"]')).toBeTruthy();
    expect(info?.querySelector('.healthy-row-controls .ralph-loop-controls')).toBeTruthy();
  });

  test('Ralph tasks appear in their normal section without a dedicated overview', () => {
    root = renderPanel(container, agentWithRalph('running'));

    expect(container.querySelector('.ralph-overview-section')).toBeNull();
    expect(container.querySelector('.ralph-overview-row')).toBeNull();

    const healthy = container.querySelector('.healthy-row');
    expect(healthy).toBeTruthy();
    expect(healthy?.querySelector('.ralph-loop-controls')).toBeTruthy();
    expect(healthy?.querySelector('.ralph-loop-badge')?.textContent).toContain('2/5');
  });

  test('does not advertise legacy Ralph attach for non-loop tasks', async () => {
    const fetchMock = stubAttachFetch({ ok: true, ralphLoop: { status: 'running' } });
    root = renderPanel(container, agentWithoutRalph({ taskId: 'task-attach', agentId: 'agent-attach' }));

    const attach = container.querySelector<HTMLButtonElement>('button[aria-label="Attach Ralph loop"]');
    expect(attach).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/ralph-loop'))).toBe(false);
  });

  test('hides attach action for active loops', async () => {
    root = renderPanel(container, agentWithRalph('running'));
    expect(container.querySelector('button[aria-label="Attach Ralph loop"]')).toBeNull();
  });

});
