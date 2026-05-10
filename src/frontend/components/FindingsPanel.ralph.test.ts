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
    autonomy: 'supervised',
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
    autonomy: 'supervised',
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
      globalFinishedCount: 0,
      globalTerminatedCount: 0,
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

  test('healthy rows reserve a dedicated row for the task name', () => {
    root = renderPanel(container, agentWithRalph('running', {
      taskName: 'A very long Ralph-controlled task name that still needs visible room',
      gitBranch: 'feature/long-running-ralph-loop-controls',
    }));

    const statusRow = container.querySelector('.healthy-row-status');
    expect(statusRow?.querySelector('.branch-label')?.textContent).toContain('feature/');
    expect(statusRow?.querySelector('.healthy-row-name')).toBeNull();

    const titleRow = container.querySelector('.healthy-row-title-line');
    expect(titleRow?.querySelector('.healthy-row-name')?.textContent).toContain('A very long Ralph-controlled task name');
    expect(titleRow?.querySelector('[data-testid="reply-button"]')).toBeNull();
    expect(titleRow?.querySelector('.ralph-loop-controls')).toBeNull();

    const footer = container.querySelector('.healthy-row-footer');
    expect(footer?.querySelector('[data-testid="reply-button"]')?.textContent).toBe('Reply');
    expect(footer?.querySelector('.healthy-row-controls .ralph-loop-controls')).toBeTruthy();
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

  test('attaches a Ralph loop to an existing task from the dashboard', async () => {
    const fetchMock = stubAttachFetch({ ok: true, ralphLoop: { status: 'running' } });
    root = renderPanel(container, agentWithoutRalph({ taskId: 'task-attach', agentId: 'agent-attach' }));

    const attach = container.querySelector<HTMLButtonElement>('button[aria-label="Attach Ralph loop"]');
    expect(attach).toBeTruthy();

    await act(async () => {
      attach!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Attach Ralph loop');
    const prompt = container.querySelector<HTMLTextAreaElement>('#ralph-attach-prompt-task-attach');
    const cap = container.querySelector<HTMLInputElement>('input[name="ralph-attach-iteration-cap"]');
    const predicate = container.querySelector<HTMLInputElement>('input[name="ralph-attach-stop-predicate"]');
    const zeroDiff = container.querySelector<HTMLInputElement>('input[name="ralph-attach-zero-diff-threshold"]');
    const cost = container.querySelector<HTMLInputElement>('input[name="ralph-attach-cost-cap"]');
    expect(prompt).toBeTruthy();
    expect(cap).toBeTruthy();

    await act(async () => {
      setInputValue(prompt!, 'Keep going');
      setInputValue(cap!, '7');
      setInputValue(predicate!, 'test -f DONE');
      setInputValue(zeroDiff!, '2');
      setInputValue(cost!, '1.5');
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledWith('/api/tasks/task-attach/ralph-loop', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }));
    const attachCall = fetchMock.mock.calls.find(([input]) => String(input) === '/api/tasks/task-attach/ralph-loop');
    const [, init] = attachCall!;
    expect(JSON.parse(String(init?.body))).toEqual({
      prompt: 'Keep going',
      iterationCap: 7,
      stopPredicate: 'test -f DONE',
      zeroDiffConvergence: { consecutiveIterations: 2 },
      costCapUsd: 1.5,
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(useKookrStore.getState().alerts[0]?.summary).toContain('Ralph loop attached');
  });

  test('shows server validation errors while keeping the attach dialog open', async () => {
    stubAttachFetch({ error: 'iterationCap is required and must be a positive integer' }, 400);
    root = renderPanel(container, agentWithoutRalph({ taskId: 'task-invalid' }));

    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Attach Ralph loop"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      setInputValue(container.querySelector<HTMLTextAreaElement>('#ralph-attach-prompt-task-invalid')!, 'Go');
      setInputValue(container.querySelector<HTMLInputElement>('input[name="ralph-attach-iteration-cap"]')!, '0');
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('iterationCap is required');
  });

  test('hides attach action for active loops and surfaces stale already-active responses', async () => {
    root = renderPanel(container, agentWithRalph('running'));
    expect(container.querySelector('button[aria-label="Attach Ralph loop"]')).toBeNull();
    act(() => root?.unmount());

    stubAttachFetch({ error: 'task already has an active Ralph loop' }, 409);
    root = renderPanel(container, agentWithoutRalph({ taskId: 'task-stale' }));
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Attach Ralph loop"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      setInputValue(container.querySelector<HTMLTextAreaElement>('#ralph-attach-prompt-task-stale')!, 'Go');
    });
    await act(async () => {
      container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('active Ralph loop');
  });

});
