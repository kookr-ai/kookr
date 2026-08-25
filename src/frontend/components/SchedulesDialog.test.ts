// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ScheduleResponse, ScheduleRollup } from '../../shared/protocol.js';
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

describe('SchedulesDialog rollup ROI', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  const scheduleStatus = {
    timezone: 'UTC',
    catchUpMode: 'auto' as const,
    catchUpEnabled: true,
    schedulerHealthy: true,
  };

  function makeRollup(overrides: Partial<ScheduleRollup> = {}): ScheduleRollup {
    return {
      scheduleId: 'sched-1',
      fires: 5,
      outcomes: { completed: 3 },
      measuredFires: 3,
      costUsd: 1.25,
      tokens: 4000,
      artifacts: 2,
      updatedAt: '2026-08-18T00:00:00.000Z',
      ...overrides,
    };
  }

  function stubFetch(rollups: ScheduleRollup[], schedule = makeSchedule()) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/schedules/rollups') {
        return { ok: true, json: async () => ({ rollups }) };
      }
      return {
        ok: true,
        json: async () => ({
          revision: 1,
          schedules: [schedule],
          status: scheduleStatus,
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  async function renderWith(schedule = makeSchedule()) {
    useKookrStore.setState({
      schedules: [schedule],
      scheduleRevision: 1,
      scheduleStatus,
      serverCwd: '/repo',
    });
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SchedulesDialog, { onClose: () => {} }));
    });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
  }

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

  test('shows fires, measured cost, and artifact count when a rollup row exists', async () => {
    const fetchMock = stubFetch([makeRollup()]);
    await renderWith();

    const line = container.querySelector('.schedule-manager-roi');
    expect(line?.textContent).toBe('5 fires · $1.25 final closeout · 2 artifacts');
    expect(line?.getAttribute('title')).toContain('3 of 5 fires');
    expect(container.querySelector('.schedule-manager-meta')?.textContent).toContain('Last:');
    expect(container.querySelector('.schedule-ledger')).not.toBeNull();

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls).toContain('/api/schedules/rollups');
    expect(urls.some((url) => url.includes('tasks.json') || url.includes('/hooks'))).toBe(false);
  });

  test('omits the rollup line when that schedule has no rollup row', async () => {
    stubFetch([makeRollup({ scheduleId: 'other-sched' })]);
    await renderWith();

    expect(container.querySelector('.schedule-manager-roi')).toBeNull();
    expect(container.textContent).not.toContain('measured');
    expect(container.textContent).not.toContain('unmeasured');
    expect(container.querySelector('.schedule-manager-meta')?.textContent).toContain('Last:');
  });

  test('does not render unmeasured fires as $0', async () => {
    stubFetch([makeRollup({ fires: 4, measuredFires: 0, costUsd: 1.25, artifacts: 1 })]);
    await renderWith();

    const line = container.querySelector('.schedule-manager-roi');
    expect(line?.textContent).toBe('4 fires · unmeasured · 1 artifact');
    expect(line?.getAttribute('title')).toContain('0 of 4 fires');
    expect(line?.getAttribute('aria-description')).toContain('0 of 4 fires');
  });

  test('omits the glance line for a never-run zero-fire rollup row', async () => {
    stubFetch([makeRollup({ fires: 0, measuredFires: 0, costUsd: 0, artifacts: 0 })]);
    await renderWith();

    expect(container.querySelector('.schedule-manager-roi')).toBeNull();
    expect(container.textContent).not.toContain('unmeasured');
    expect(container.textContent).not.toMatch(/\$0/);
  });

  test('omits the glance line when the rollup request fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/schedules/rollups') {
        return { ok: false, json: async () => ({ error: 'Scheduling not configured' }) };
      }
      return {
        ok: true,
        json: async () => ({
          revision: 1,
          schedules: [makeSchedule()],
          status: scheduleStatus,
        }),
      };
    }));
    await renderWith();

    expect(container.querySelector('.schedule-manager-roi')).toBeNull();
    expect(container.textContent).not.toMatch(/\$0/);
    expect(container.querySelector('.schedule-manager-meta')?.textContent).toContain('Last:');
  });
});

describe('SchedulesDialog cron presets', () => {
  let container: HTMLDivElement;
  let root: Root | undefined;

  function stubFetch() {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/playbooks')) {
        return { ok: true, json: async () => [] };
      }
      if (url.startsWith('/api/schedules/preview')) {
        return { ok: true, json: async () => ({ cronDescription: 'Daily at 09:00', nextRuns: [], timezone: 'UTC' }) };
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
  }

  function presetButton(label: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>('.schedule-cron-preset'))
      .find((b) => b.textContent === label);
    if (!button) throw new Error(`preset button not found: ${label}`);
    return button;
  }

  function cronInput(): HTMLInputElement {
    const input = container.querySelector<HTMLInputElement>('.schedule-form-field input[placeholder="0 9 * * *"]');
    if (!input) throw new Error('cron input not found');
    return input;
  }

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    syncGlobalStore();
    useKookrStore.setState({ serverCwd: '/repo', schedules: [] });
    container = document.createElement('div');
    document.body.appendChild(container);
    stubFetch();
  });

  afterEach(() => {
    if (root) {
      const r = root;
      act(() => { r.unmount(); });
    }
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  test('clicking "Weekdays 9am" sets the cron field to 0 9 * * 1-5', async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SchedulesDialog, { onClose: () => {} }));
    });

    await act(async () => { presetButton('Weekdays 9am').click(); });

    expect(cronInput().value).toBe('0 9 * * 1-5');
  });

  test('the chip matching the current cron value renders as pressed', async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SchedulesDialog, { onClose: () => {} }));
    });

    // Default cron is "0 9 * * *" → the "Daily 9am" chip is pressed, others are not.
    expect(presetButton('Daily 9am').getAttribute('aria-pressed')).toBe('true');
    expect(presetButton('Hourly').getAttribute('aria-pressed')).toBe('false');

    await act(async () => { presetButton('Hourly').click(); });

    expect(presetButton('Hourly').getAttribute('aria-pressed')).toBe('true');
    expect(presetButton('Daily 9am').getAttribute('aria-pressed')).toBe('false');
  });

  test('typing a custom cron keeps the field and leaves every chip unpressed', async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SchedulesDialog, { onClose: () => {} }));
    });

    // Type a value that matches no preset — presets are additive, not a picker.
    const input = cronInput();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(input, '*/5 * * * *');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(cronInput().value).toBe('*/5 * * * *');
    const anyPressed = Array.from(container.querySelectorAll<HTMLButtonElement>('.schedule-cron-preset'))
      .some((b) => b.getAttribute('aria-pressed') === 'true');
    expect(anyPressed).toBe(false);
  });
});
