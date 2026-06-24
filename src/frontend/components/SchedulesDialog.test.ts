// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ScheduleResponse } from '../../shared/protocol.js';
import { createKookrStore, useKookrStore } from '../store/useStore.js';
import { SchedulesDialog } from './SchedulesDialog.js';

function syncGlobalStore() {
  const freshState = createKookrStore().getState();
  const nextData = Object.fromEntries(
    Object.entries(freshState).filter(([, value]) => typeof value !== 'function'),
  );
  useKookrStore.setState(nextData);
}

function makeSchedule(): ScheduleResponse {
  return {
    id: 'sched-1',
    name: 'Nightly sweep',
    enabled: true,
    cron: '0 3 * * *',
    maxTriggers: undefined,
    playbook: { path: 'sweep.md', parameters: {} },
    cwd: '/repo',
    agentType: 'claude-code',
    lastScheduledFor: '2026-01-01T03:00:00.000Z',
    lastCronEvaluatedAt: '2026-01-02T04:00:00.000Z',
    latestExecution: {
      executionToken: 'ledger-token',
      scheduledFor: '2026-01-01T03:00:00.000Z',
      evaluatedAt: '2026-01-02T04:00:00.000Z',
      trigger: 'cron',
      outcome: 'skipped_stale',
      reasonCode: 'stale_catch_up',
      message: 'Due run is outside the catch-up window',
    },
    executionLedger: [
      {
        id: 'sched-1:cron:2026-01-01T02:00:00.000Z',
        scheduleId: 'sched-1',
        trigger: 'cron',
        decision: 'manual_catch_up',
        scheduledFor: '2026-01-01T02:00:00.000Z',
        evaluatedAt: '2026-01-02T03:00:00.000Z',
        completedAt: '2026-01-02T03:00:00.000Z',
        outcome: 'skipped_manual',
        reasonCode: 'manual_catch_up_required',
        message: 'Run manually',
      },
      {
        id: 'sched-1:cron:2026-01-01T03:00:00.000Z',
        scheduleId: 'sched-1',
        trigger: 'cron',
        decision: 'stale_catch_up',
        scheduledFor: '2026-01-01T03:00:00.000Z',
        evaluatedAt: '2026-01-02T04:00:00.000Z',
        completedAt: '2026-01-02T04:00:00.000Z',
        outcome: 'skipped_stale',
        reasonCode: 'stale_catch_up',
        message: 'Due run is outside the catch-up window',
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T04:00:00.000Z',
    nextRunAt: '2026-01-03T03:00:00.000Z',
    cronDescription: 'Daily at 03:00',
  };
}

describe('SchedulesDialog execution ledger', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      const r = root;
      act(() => { r.unmount(); });
    }
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test('renders recent ledger entries with readable outcome and reason labels', async () => {
    const schedule = makeSchedule();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        revision: 1,
        schedules: [schedule],
        status: {
          timezone: 'UTC',
          catchUpMode: 'auto',
          catchUpEnabled: true,
          schedulerHealthy: true,
        },
      }),
    })));
    useKookrStore.setState({
      schedules: [schedule],
      scheduleRevision: 1,
      scheduleStatus: {
        timezone: 'UTC',
        catchUpMode: 'auto',
        catchUpEnabled: true,
        schedulerHealthy: true,
      },
      serverCwd: '/repo',
    });

    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SchedulesDialog, { onClose: () => {} }));
    });

    expect(container.querySelector('.schedule-ledger')?.textContent).toContain('Stale catch-up');
    expect(container.querySelector('.schedule-ledger')?.textContent).toContain('skipped: stale');
    expect(container.querySelector('.schedule-ledger')?.textContent).toContain('stale catch-up');
    expect(container.querySelector('.schedule-ledger')?.textContent).toContain('Missed run');
    expect(container.querySelector('.schedule-ledger')?.textContent).toContain('manual run available');
    expect(container.querySelector('.schedule-ledger')?.textContent).toContain('Run Now to recover');
    expect(container.querySelector('.schedule-ledger')?.textContent).not.toContain('skipped_stale');
    expect(container.querySelector('.schedule-ledger')?.textContent).not.toContain('stale_catch_up');
    expect(container.querySelector('.schedule-ledger')?.textContent).not.toContain('skipped_manual');
    expect(container.querySelector('.schedule-ledger')?.textContent).not.toContain('manual_catch_up_required');
    expect(container.querySelector('.schedule-manager-meta')?.textContent).toContain('Last: skipped: stale');
    expect(container.querySelector('.schedule-manager-meta')?.textContent).not.toContain('skipped_stale');
    expect(container.textContent).not.toContain('Automatic catch-up is off. Missed runs are recorded');
    expect(container.textContent).not.toContain('Startup catch-up is disabled for this session.');
  });

  test('uses distinct copy when startup catch-up is fully disabled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        revision: 1,
        schedules: [],
        status: {
          timezone: 'UTC',
          catchUpMode: 'off',
          catchUpEnabled: false,
          schedulerHealthy: true,
        },
      }),
    })));
    useKookrStore.setState({
      schedules: [],
      scheduleRevision: 1,
      scheduleStatus: {
        timezone: 'UTC',
        catchUpMode: 'off',
        catchUpEnabled: false,
        schedulerHealthy: true,
      },
      serverCwd: '/repo',
    });

    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SchedulesDialog, { onClose: () => {} }));
    });

    expect(container.textContent).toContain('Startup catch-up is disabled for this session.');
    expect(container.textContent).not.toContain('Missed runs are recorded');
  });

  test('uses manual recovery copy when automatic catch-up is off by default', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        revision: 1,
        schedules: [],
        status: {
          timezone: 'UTC',
          catchUpMode: 'manual',
          catchUpEnabled: false,
          schedulerHealthy: true,
        },
      }),
    })));
    useKookrStore.setState({
      schedules: [],
      scheduleRevision: 1,
      scheduleStatus: {
        timezone: 'UTC',
        catchUpMode: 'manual',
        catchUpEnabled: false,
        schedulerHealthy: true,
      },
      serverCwd: '/repo',
    });

    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SchedulesDialog, { onClose: () => {} }));
    });

    expect(container.textContent).toContain('Automatic catch-up is off. Missed runs are recorded and can be started with Run Now.');
    expect(container.textContent).not.toContain('Startup catch-up is disabled for this session.');
  });
});

describe('SchedulesDialog prefill', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  function stubFetch(playbooks: Array<{ id: string; name: string; scope: string; parameters: unknown[] }>) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/playbooks')) {
        return { ok: true, json: async () => playbooks };
      }
      if (url.startsWith('/api/schedules/preview')) {
        return { ok: true, json: async () => ({ cronDescription: 'Daily at 09:00', nextRuns: [], timezone: 'UTC' }) };
      }
      // /api/schedules list
      return {
        ok: true,
        json: async () => ({
          revision: 1,
          schedules: [],
          status: { timezone: 'UTC', catchUpMode: 'auto', catchUpEnabled: true, schedulerHealthy: true },
        }),
      };
    }));
  }

  async function settle() {
    // Playbook + schedules fetches are debounced (200ms) then async-resolved.
    await act(async () => { await new Promise((r) => setTimeout(r, 260)); });
    await act(async () => { await Promise.resolve(); });
  }

  function selectPlaybook(value: string) {
    const select = container.querySelector<HTMLSelectElement>('.schedule-form-field select');
    if (!select) throw new Error('playbook select not found');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  async function submitCreate() {
    const save = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => b.textContent === 'Save Schedule');
    if (!save) throw new Error('Save button not found');
    await act(async () => { save.click(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    useKookrStore.setState({ serverCwd: '/server-default', schedules: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      const r = root;
      act(() => { r.unmount(); });
    }
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test('opens the create form seeded with the prefill cwd/name and pre-selects the playbook', async () => {
    stubFetch([{ id: 'triage.md', name: 'Triage', scope: 'project', parameters: [] }]);
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SchedulesDialog, {
        onClose: () => {},
        prefill: { cwd: '/repo', playbookId: 'triage.md', name: 'My nightly triage' },
      }));
    });
    await settle();

    const form = container.querySelector('.schedule-create-form');
    expect(form).not.toBeNull();
    const cwdInput = Array.from(container.querySelectorAll<HTMLInputElement>('.schedule-form-field input'))
      .find((el) => el.value === '/repo');
    expect(cwdInput).toBeTruthy();
    const nameInput = Array.from(container.querySelectorAll<HTMLInputElement>('.schedule-form-field input'))
      .find((el) => el.value === 'My nightly triage');
    expect(nameInput).toBeTruthy();
    // Playbook resolved → Save button enabled, no "couldn't pre-select" note.
    const save = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => b.textContent === 'Save Schedule');
    expect(save?.disabled).toBe(false);
    expect(container.querySelector('.schedule-prefill-note')).toBeNull();
  });

  test('shows a degradation note when the prefilled playbook is not project-scoped', async () => {
    // The playbook the task ran isn't in the project list (e.g. user-scoped).
    stubFetch([{ id: 'other.md', name: 'Other', scope: 'project', parameters: [] }]);
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SchedulesDialog, {
        onClose: () => {},
        prefill: { cwd: '/repo', playbookId: 'user-only.md', name: 'User playbook' },
      }));
    });
    await settle();

    const note = container.querySelector('.schedule-prefill-note');
    expect(note?.textContent).toContain('Couldn’t pre-select');
    const save = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => b.textContent === 'Save Schedule');
    expect(save?.disabled).toBe(true);
  });

  test('creating from the seeded flow calls onCreated(true)', async () => {
    stubFetch([{ id: 'triage.md', name: 'Triage', scope: 'project', parameters: [] }]);
    const onCreated = vi.fn();
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SchedulesDialog, {
        onClose: () => {},
        prefill: { cwd: '/repo', playbookId: 'triage.md', name: 'Seeded' },
        onCreated,
      }));
    });
    await settle();

    await submitCreate();

    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith(true);
  });

  test('lists a plugin-scoped playbook and round-trips its scope on create (R8)', async () => {
    const createBodies: Array<{ playbook?: { path?: string; scope?: string } }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/playbooks')) {
        // A plugin-tier playbook — would have been filtered out before R8.
        return { ok: true, json: async () => [{ id: 'plug.md', name: 'Plugin Job', scope: 'plugin', parameters: [] }] };
      }
      if (url.startsWith('/api/schedules/preview')) {
        return { ok: true, json: async () => ({ cronDescription: 'Daily at 09:00', nextRuns: [], timezone: 'UTC' }) };
      }
      if (url === '/api/schedules' && init?.method === 'POST') {
        createBodies.push(JSON.parse(init.body as string));
        return { ok: true, json: async () => ({ id: 'new', name: 'Plugin Job' }) };
      }
      return {
        ok: true,
        json: async () => ({
          revision: 1,
          schedules: [],
          status: { timezone: 'UTC', catchUpMode: 'auto', catchUpEnabled: true, schedulerHealthy: true },
        }),
      };
    }));
    useKookrStore.setState({ serverCwd: '/repo', schedules: [] });
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SchedulesDialog, { onClose: () => {} }));
    });
    await settle();

    // The plugin playbook is offered in the picker (no project-only filter).
    const option = Array.from(container.querySelectorAll<HTMLOptionElement>('.schedule-form-field select option'))
      .find((o) => o.value === 'plug.md');
    expect(option).toBeTruthy();

    selectPlaybook('plug.md');
    await act(async () => { await Promise.resolve(); });
    await submitCreate();

    expect(createBodies).toHaveLength(1);
    expect(createBodies[0].playbook).toMatchObject({ path: 'plug.md', scope: 'plugin' });
  });

  test('a manual create (no prefill) calls onCreated(false) — does not trigger the hint', async () => {
    stubFetch([{ id: 'triage.md', name: 'Triage', scope: 'project', parameters: [] }]);
    useKookrStore.setState({ serverCwd: '/repo', schedules: [] });
    const onCreated = vi.fn();
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SchedulesDialog, { onClose: () => {}, onCreated }));
    });
    await settle();
    // No prefill → user picks the playbook manually.
    selectPlaybook('triage.md');
    await act(async () => { await Promise.resolve(); });

    await submitCreate();

    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith(false);
  });
});
