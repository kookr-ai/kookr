// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState } from '../../shared/contracts/agent-state.js';
import type { Playbook } from '../../shared/contracts/playbook.js';
import type { ScheduleResponse } from '../../shared/contracts/schedule.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { SchedulesDialog } from './SchedulesDialog.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

const TASK_ID = 'task-abcdef1234567890';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makePlaybook(id: string, name: string): Playbook {
  return {
    id,
    scope: 'project',
    name,
    description: `${name} description`,
    parameters: [],
    checklist: [],
    tags: [],
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function changeInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function makeSchedule(overrides: Partial<ScheduleResponse> = {}): ScheduleResponse {
  return {
    id: 'sched-1',
    name: 'Nightly triage',
    enabled: true,
    cron: '0 9 * * *',
    playbook: { path: 'triage.md', parameters: {} },
    cwd: '/repo',
    executionLedger: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    nextRunAt: '2026-01-02T09:00:00.000Z',
    cronDescription: 'At 09:00 every day',
    latestExecution: {
      executionToken: 'tok-1',
      evaluatedAt: '2026-01-01T09:00:00.000Z',
      triggeredAt: '2026-01-01T09:00:00.000Z',
      trigger: 'cron_due',
      taskId: TASK_ID,
      outcome: 'completed',
    },
    ...overrides,
  };
}

const EXPECTED_LABEL = `Task ${TASK_ID.slice(0, 8)}`;

function makeAgent(
  taskId: string,
  agentId = 'agent-1',
  taskStatus: AgentState['taskStatus'] = 'inProgress',
): AgentState {
  return { agentId, events: [], anomaly: null, taskId, taskStatus };
}

describe('R10.5: SchedulesDialog cwd playbook lookup ordering', () => {
  let container: HTMLDivElement;
  let root: Root;
  let lookups: Map<string, ReturnType<typeof deferred<Response>>>;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    lookups = new Map();

    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/playbooks?cwd=')) {
        const cwd = new URLSearchParams(url.split('?')[1]).get('cwd') ?? '';
        const lookup = deferred<Response>();
        lookups.set(cwd, lookup);
        return lookup.promise;
      }
      if (url === '/api/schedules') {
        return Promise.resolve(jsonResponse({
          revision: 0,
          schedules: [],
          status: {
            timezone: 'UTC',
            catchUpMode: 'auto',
            catchUpEnabled: true,
            schedulerHealthy: true,
          },
        }));
      }
      if (url === '/api/schedules/rollups') {
        return Promise.resolve(jsonResponse({ rollups: [] }));
      }
      if (url === '/api/schedules/preview') {
        return Promise.resolve(jsonResponse({
          cronDescription: 'At 09:00 every day',
          nextRuns: [],
          timezone: 'UTC',
        }));
      }
      throw new Error(`unexpected fetch ${url}`);
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  function renderWithPrefill() {
    act(() => {
      root.render(React.createElement(SchedulesDialog, {
        onClose: vi.fn(),
        prefill: { cwd: '/project-a' },
      }));
    });
  }

  function cwdInput(): HTMLInputElement {
    const field = Array.from(container.querySelectorAll<HTMLLabelElement>('.schedule-form-field'))
      .find((label) => label.querySelector('span')?.textContent === 'Working Directory');
    const input = field?.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error('Working Directory input not found');
    return input;
  }

  function playbookSelect(): HTMLSelectElement {
    const select = container.querySelector<HTMLSelectElement>('.schedule-form-field select');
    if (!select) throw new Error('Playbook select not found');
    return select;
  }

  async function startLookup(cwd: string): Promise<ReturnType<typeof deferred<Response>>> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    const lookup = lookups.get(cwd);
    if (!lookup) throw new Error(`Lookup for ${cwd} did not start`);
    return lookup;
  }

  async function changeCwd(cwd: string): Promise<ReturnType<typeof deferred<Response>>> {
    act(() => changeInput(cwdInput(), cwd));
    return startLookup(cwd);
  }

  async function settle(action: () => void): Promise<void> {
    await act(async () => {
      action();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  test('keeps the newer catalog when its response arrives before the stale response', async () => {
    renderWithPrefill();
    const projectA = await startLookup('/project-a');
    const projectB = await changeCwd('/project-b');

    await settle(() => projectB.resolve(jsonResponse([makePlaybook('shared.md', 'Project B job')])));
    expect(playbookSelect().textContent).toContain('Project B job');

    await settle(() => projectA.resolve(jsonResponse([makePlaybook('shared.md', 'Project A job')])));
    expect(playbookSelect().textContent).toContain('Project B job');
    expect(container.textContent).not.toContain('Project A job');
  });

  test('ignores the stale response when it arrives before the current response', async () => {
    renderWithPrefill();
    const projectA = await startLookup('/project-a');
    const projectB = await changeCwd('/project-b');

    await settle(() => projectA.resolve(jsonResponse([makePlaybook('shared.md', 'Project A job')])));
    expect(container.textContent).not.toContain('Project A job');
    expect(container.textContent).toContain('Loading playbooks…');

    await settle(() => projectB.resolve(jsonResponse([makePlaybook('shared.md', 'Project B job')])));
    expect(playbookSelect().textContent).toContain('Project B job');
  });

  test('ignores a stale failure after the current catalog succeeds', async () => {
    renderWithPrefill();
    const projectA = await startLookup('/project-a');
    const projectB = await changeCwd('/project-b');

    await settle(() => projectB.resolve(jsonResponse([makePlaybook('project-b.md', 'Project B job')])));
    await settle(() => projectA.reject(new Error('Project A lookup failed')));

    expect(playbookSelect().textContent).toContain('Project B job');
    expect(container.textContent).not.toContain('Couldn’t pre-select');
    expect(container.textContent).not.toContain('No playbooks found');
  });

  test('keeps loading visible when a stale request settles before the current request', async () => {
    renderWithPrefill();
    const projectA = await startLookup('/project-a');
    const projectB = await changeCwd('/project-b');

    await settle(() => projectA.resolve(jsonResponse([makePlaybook('shared.md', 'Project A job')])));
    expect(container.textContent).toContain('Loading playbooks…');

    await settle(() => projectB.resolve(jsonResponse([makePlaybook('shared.md', 'Project B job')])));
    expect(container.textContent).not.toContain('Loading playbooks…');
  });

  test('keeps the catalog empty when the directory is cleared during a request', async () => {
    renderWithPrefill();
    const projectA = await startLookup('/project-a');

    act(() => changeInput(cwdInput(), ''));
    expect(playbookSelect().value).toBe('');
    expect(container.textContent).not.toContain('Loading playbooks…');

    await settle(() => projectA.resolve(jsonResponse([makePlaybook('shared.md', 'Project A job')])));
    expect(playbookSelect().value).toBe('');
    expect(container.textContent).not.toContain('Project A job');
    expect(container.textContent).not.toContain('Loading playbooks…');
  });
});

describe('SchedulesDialog task reference', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  function render(onClose: () => void) {
    act(() => {
      root.render(React.createElement(SchedulesDialog, { onClose }));
    });
  }

  function taskRef(): HTMLElement | null {
    return container.querySelector<HTMLElement>('.schedule-task-ref');
  }

  test('clicking a live task reference selects that task and closes the dialog', () => {
    const selectAgent = vi.fn();
    act(() => {
      useKookrStore.setState({
        schedules: [makeSchedule()],
        agents: [makeAgent(TASK_ID)],
        selectAgent,
      });
    });
    const onClose = vi.fn();
    render(onClose);

    const ref = taskRef();
    expect(ref).not.toBeNull();
    expect(ref?.tagName).toBe('BUTTON');
    expect(ref?.textContent).toBe(EXPECTED_LABEL);

    act(() => {
      ref?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(selectAgent).toHaveBeenCalledTimes(1);
    expect(selectAgent).toHaveBeenCalledWith('agent-1', TASK_ID);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('a task absent from the snapshot renders a non-actionable reference and does not throw', () => {
    const selectAgent = vi.fn();
    act(() => {
      useKookrStore.setState({
        schedules: [makeSchedule()],
        agents: [], // produced task is terminal / not in the current snapshot
        selectAgent,
      });
    });
    const onClose = vi.fn();
    render(onClose);

    const ref = taskRef();
    expect(ref).not.toBeNull();
    expect(ref?.tagName).toBe('SPAN');
    expect(ref?.textContent).toBe(EXPECTED_LABEL);

    act(() => {
      ref?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(selectAgent).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('a matching but terminal task keeps the reference non-actionable', () => {
    const selectAgent = vi.fn();
    act(() => {
      useKookrStore.setState({
        schedules: [makeSchedule()],
        // The produced task matches by id but has already completed. Terminal
        // agents are retained in the snapshot as synthetic entries, so presence
        // alone must not make the reference clickable (issue #2721 AC).
        agents: [makeAgent(TASK_ID, 'agent-1', 'completed')],
        selectAgent,
      });
    });
    const onClose = vi.fn();
    render(onClose);

    const ref = taskRef();
    expect(ref).not.toBeNull();
    expect(ref?.tagName).toBe('SPAN');

    act(() => {
      ref?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(selectAgent).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('a present but non-matching task keeps the reference non-actionable', () => {
    const selectAgent = vi.fn();
    act(() => {
      useKookrStore.setState({
        schedules: [makeSchedule()],
        // An unrelated live agent — its taskId does not match the produced task,
        // so navigation must not be offered (proves the match keys on taskId,
        // not merely on "some agent exists").
        agents: [makeAgent('task-some-other-task', 'agent-other')],
        selectAgent,
      });
    });
    const onClose = vi.fn();
    render(onClose);

    const ref = taskRef();
    expect(ref).not.toBeNull();
    expect(ref?.tagName).toBe('SPAN');

    act(() => {
      ref?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(selectAgent).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('SchedulesDialog agent label', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
  });

  function render() {
    act(() => {
      root.render(React.createElement(SchedulesDialog, { onClose: vi.fn() }));
    });
  }

  function agentLabel(): HTMLElement | null {
    return container.querySelector<HTMLElement>('.schedule-manager-agent');
  }

  test('shows the pinned agent, effort, and model on the row', () => {
    act(() => {
      useKookrStore.setState({
        schedules: [makeSchedule({ agentType: 'codex-cli', effort: 'high', model: 'gpt-5' })],
        agents: [],
      });
    });
    render();

    const label = agentLabel();
    expect(label).not.toBeNull();
    expect(label?.textContent).toBe('codex-cli · high · gpt-5');
  });

  test('appends only the effort when the model is unset', () => {
    act(() => {
      useKookrStore.setState({
        schedules: [makeSchedule({ agentType: 'codex-cli', effort: 'high' })],
        agents: [],
      });
    });
    render();

    expect(agentLabel()?.textContent).toBe('codex-cli · high');
  });

  test('appends only the model when the effort is unset', () => {
    // Independent-conditional guard: a regression that nested the model append
    // inside the effort branch would silently drop the model here.
    act(() => {
      useKookrStore.setState({
        schedules: [makeSchedule({ agentType: 'codex-cli', model: 'gpt-5' })],
        agents: [],
      });
    });
    render();

    expect(agentLabel()?.textContent).toBe('codex-cli · gpt-5');
  });

  test('shows the bare agent when effort and model are unset', () => {
    act(() => {
      useKookrStore.setState({
        schedules: [makeSchedule({ agentType: 'round-robin' })],
        agents: [],
      });
    });
    render();

    expect(agentLabel()?.textContent).toBe('round-robin');
  });

  test('falls back to "default" when the schedule pins no agent', () => {
    act(() => {
      useKookrStore.setState({
        schedules: [makeSchedule({ agentType: undefined })],
        agents: [],
      });
    });
    render();

    expect(agentLabel()?.textContent).toBe('default');
  });
});
