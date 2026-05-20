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
    expect(container.querySelector('.schedule-ledger')?.textContent).not.toContain('skipped_stale');
    expect(container.querySelector('.schedule-ledger')?.textContent).not.toContain('stale_catch_up');
  });
});
