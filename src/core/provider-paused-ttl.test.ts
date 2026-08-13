import { describe, it, expect } from 'vitest';
import type { Task } from './task-read-model.js';
import {
  DEFAULT_PROVIDER_PAUSED_HARD_TTL_MS,
  DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS,
  capacityAllowsProviderPausedEarlyReclaim,
  effectiveProviderPausedTtlMs,
  listExpiredProviderPausedTasks,
  selectExpiredProviderPausedTasks,
  summarizeProviderPausedOccupancy,
} from './provider-paused-ttl.js';
import { aSession, aTask } from './__fixtures__/task-builders.js';

const NOW = new Date('2026-08-05T12:00:00.000Z');
const TTL_MS = DEFAULT_PROVIDER_PAUSED_HARD_TTL_MS; // 2h

function pausedTask(overrides: Partial<Task> = {}): Task {
  return aTask({
    id: 'paused-1',
    status: 'inProgress',
    sessions: [aSession({ tmuxSession: 'kookr-paused', lastStatus: 'inProgress' })],
    ...overrides,
  });
}

describe('summarizeProviderPausedOccupancy (issue #2079)', () => {
  it('returns zero occupancy when nothing is paused', () => {
    const snap = summarizeProviderPausedOccupancy([pausedTask()], {
      now: NOW,
      isProviderPaused: () => false,
      getPauseStartedAtMs: () => undefined,
    });
    expect(snap).toEqual({ count: 0, oldestPauseAgeMs: null, taskIds: [] });
  });

  it('counts paused inProgress tasks and reports oldest pause age', () => {
    const older = pausedTask({ id: 'old' });
    const newer = pausedTask({ id: 'new' });
    const working = pausedTask({ id: 'working' });
    const snap = summarizeProviderPausedOccupancy([older, newer, working], {
      now: NOW,
      isProviderPaused: (t) => t.id !== 'working',
      getPauseStartedAtMs: (t) => {
        if (t.id === 'old') return NOW.getTime() - 90 * 60_000;
        if (t.id === 'new') return NOW.getTime() - 10 * 60_000;
        return undefined;
      },
    });
    expect(snap.count).toBe(2);
    expect(snap.oldestPauseAgeMs).toBe(90 * 60_000);
    expect(snap.taskIds).toEqual(['old', 'new']);
  });

  it('excludes finishedAwaitingAck and non-inProgress', () => {
    const faa = pausedTask({
      id: 'faa',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - 60_000).toISOString(),
      },
    });
    const done = pausedTask({ id: 'done', status: 'completed' });
    const snap = summarizeProviderPausedOccupancy([faa, done], {
      now: NOW,
      isProviderPaused: () => true,
      getPauseStartedAtMs: () => NOW.getTime() - 60_000,
    });
    expect(snap.count).toBe(0);
  });

  it('counts paused tasks with unknown start but leaves oldestPauseAgeMs null', () => {
    const snap = summarizeProviderPausedOccupancy([pausedTask()], {
      now: NOW,
      isProviderPaused: () => true,
      getPauseStartedAtMs: () => undefined,
    });
    expect(snap.count).toBe(1);
    expect(snap.oldestPauseAgeMs).toBeNull();
  });
});

describe('selectExpiredProviderPausedTasks — skip vs escalate (issue #2079)', () => {
  const alwaysPaused = () => true;
  const startAgo = (ms: number) => () => NOW.getTime() - ms;

  it('skips under hard TTL (no escalate before bound)', () => {
    const task = pausedTask();
    const sel = selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      isProviderPaused: alwaysPaused,
      getPauseStartedAtMs: startAgo(TTL_MS - 1),
      isHoldingOpenPr: () => false,
    });
    expect(sel.expired).toEqual([]);
    expect(sel.skips.skipped_under_ttl).toBe(1);
    expect(sel.outcomes[0]).toMatchObject({
      taskId: 'paused-1',
      outcome: 'skipped_under_ttl',
    });
  });

  it('selects at inclusive hard-TTL boundary (escalate)', () => {
    const task = pausedTask();
    const expired = listExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      isProviderPaused: alwaysPaused,
      getPauseStartedAtMs: startAgo(TTL_MS),
      isHoldingOpenPr: () => false,
    });
    expect(expired.map((e) => e.task.id)).toEqual(['paused-1']);
    expect(expired[0].pausedForMs).toBe(TTL_MS);
  });

  it('selects past hard TTL (escalate)', () => {
    const task = pausedTask();
    const sel = selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      isProviderPaused: alwaysPaused,
      getPauseStartedAtMs: startAgo(TTL_MS + 60_000),
      isHoldingOpenPr: () => false,
    });
    expect(sel.expired).toHaveLength(1);
    expect(sel.outcomes[0].outcome).toBe('selected');
    expect(sel.skips.skipped_under_ttl).toBe(0);
  });

  it('issue #2228: confirmed open-PR increments confirmed only (fail-safe still holds)', () => {
    const task = pausedTask();
    const sel = selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      isProviderPaused: alwaysPaused,
      getPauseStartedAtMs: startAgo(TTL_MS + 60_000),
      isHoldingOpenPr: () => true,
    });
    expect(sel.expired).toEqual([]);
    expect(sel.skips.skipped_open_pr_confirmed).toBe(1);
    expect(sel.skips.skipped_open_pr_unknown).toBe(0);
    expect(sel.outcomes[0].outcome).toBe('skipped_open_pr_confirmed');
  });

  it('issue #2228: unknown open-PR increments unknown only (undefined treated as hold)', () => {
    const task = pausedTask();
    const sel = selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      isProviderPaused: alwaysPaused,
      getPauseStartedAtMs: startAgo(TTL_MS + 60_000),
      isHoldingOpenPr: () => undefined,
    });
    expect(sel.expired).toEqual([]);
    expect(sel.skips.skipped_open_pr_unknown).toBe(1);
    expect(sel.skips.skipped_open_pr_confirmed).toBe(0);
    expect(sel.outcomes[0].outcome).toBe('skipped_open_pr_unknown');
  });

  it('issue #2228: omitted isHoldingOpenPr is unknown fail-safe skip for every candidate', () => {
    const task = pausedTask();
    const sel = selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      isProviderPaused: alwaysPaused,
      getPauseStartedAtMs: startAgo(TTL_MS + 60_000),
      // isHoldingOpenPr omitted
    });
    expect(sel.expired).toEqual([]);
    expect(sel.skips.skipped_open_pr_unknown).toBe(1);
    expect(sel.skips.skipped_open_pr_confirmed).toBe(0);
    expect(sel.outcomes[0].outcome).toBe('skipped_open_pr_unknown');
  });

  it('missing pause start skips (never invent pause-since-epoch)', () => {
    const task = pausedTask();
    const sel = selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      isProviderPaused: alwaysPaused,
      getPauseStartedAtMs: () => undefined,
      isHoldingOpenPr: () => false,
    });
    expect(sel.expired).toEqual([]);
    expect(sel.skips.skipped_no_pause_start).toBe(1);
  });

  it('non-paused tasks are not candidates', () => {
    const task = pausedTask();
    const sel = selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      isProviderPaused: () => false,
      getPauseStartedAtMs: startAgo(TTL_MS + 60_000),
      isHoldingOpenPr: () => false,
    });
    expect(sel.candidatesConsidered).toBe(0);
    expect(sel.expired).toEqual([]);
  });

  it('orders selected by oldest-paused first', () => {
    const a = pausedTask({ id: 'a' });
    const b = pausedTask({ id: 'b' });
    const sel = selectExpiredProviderPausedTasks([a, b], {
      now: NOW,
      ttlMs: TTL_MS,
      isProviderPaused: alwaysPaused,
      getPauseStartedAtMs: (t) =>
        t.id === 'a' ? NOW.getTime() - (TTL_MS + 10_000) : NOW.getTime() - (TTL_MS + 60_000),
      isHoldingOpenPr: () => false,
    });
    expect(sel.expired.map((e) => e.task.id)).toEqual(['b', 'a']);
  });

  it('does not escalate when recent liveness advances effective pause start (sticky event)', () => {
    const task = pausedTask();
    const sel = selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      isProviderPaused: alwaysPaused,
      // Latch is ancient, but last activity is recent → under TTL.
      getPauseStartedAtMs: startAgo(TTL_MS + 60_000),
      getLastActivityAtMs: () => NOW.getTime() - 60_000,
      isHoldingOpenPr: () => false,
    });
    expect(sel.expired).toEqual([]);
    expect(sel.skips.skipped_under_ttl).toBe(1);
  });

  it('skips awaiting provider reset only while under hard TTL (#1896 / #2423)', () => {
    const task = pausedTask();
    const sel = selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      softTtlMs: DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS,
      capacityAllowsEarlyReclaim: true,
      isProviderPaused: alwaysPaused,
      // Past soft TTL (so not skipped_under_ttl) but still under hard TTL.
      getPauseStartedAtMs: startAgo(DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS + 60_000),
      isAwaitingProviderReset: () => true,
      isHoldingOpenPr: () => false,
    });
    expect(sel.expired).toEqual([]);
    expect(sel.skips.skipped_awaiting_provider_reset).toBe(1);
    expect(sel.outcomes[0].outcome).toBe('skipped_awaiting_provider_reset');
  });

  it('selects after hard TTL even when still awaiting provider reset (#2423)', () => {
    const task = pausedTask();
    const sel = selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      isProviderPaused: alwaysPaused,
      getPauseStartedAtMs: startAgo(TTL_MS),
      isAwaitingProviderReset: () => true,
      isHoldingOpenPr: () => false,
    });
    expect(sel.expired.map((e) => e.task.id)).toEqual(['paused-1']);
    expect(sel.outcomes[0].outcome).toBe('selected');
    expect(sel.outcomes[0].pausedForMs).toBe(TTL_MS);
    expect(sel.skips.skipped_awaiting_provider_reset).toBe(0);
  });

  it('preserves open-PR fail-safe after hard TTL while awaiting reset (#2423)', () => {
    const task = pausedTask();
    const sel = selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      isProviderPaused: alwaysPaused,
      getPauseStartedAtMs: startAgo(TTL_MS + 60_000),
      isAwaitingProviderReset: () => true,
      isHoldingOpenPr: () => true,
    });
    expect(sel.expired).toEqual([]);
    expect(sel.skips.skipped_awaiting_provider_reset).toBe(0);
    expect(sel.skips.skipped_open_pr_confirmed).toBe(1);
    expect(sel.outcomes[0].outcome).toBe('skipped_open_pr_confirmed');
  });

  it('escalates after provider reset elapsed (holdForResume false)', () => {
    const task = pausedTask();
    const sel = selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      isProviderPaused: alwaysPaused,
      getPauseStartedAtMs: startAgo(TTL_MS + 60_000),
      isAwaitingProviderReset: () => false,
      isHoldingOpenPr: () => false,
    });
    expect(sel.expired.map((e) => e.task.id)).toEqual(['paused-1']);
  });
});

describe('capacity-aware soft TTL (issue #2225)', () => {
  const alwaysPaused = () => true;
  const startAgo = (ms: number) => () => NOW.getTime() - ms;
  const SOFT = DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS; // 40m

  it('effectiveProviderPausedTtlMs uses soft bound only when capacity allows', () => {
    expect(
      effectiveProviderPausedTtlMs({
        ttlMs: TTL_MS,
        softTtlMs: SOFT,
        capacityAllowsEarlyReclaim: false,
      }),
    ).toBe(TTL_MS);
    expect(
      effectiveProviderPausedTtlMs({
        ttlMs: TTL_MS,
        softTtlMs: SOFT,
        capacityAllowsEarlyReclaim: true,
      }),
    ).toBe(SOFT);
  });

  it('capacityAllowsProviderPausedEarlyReclaim requires free slots + occupancy', () => {
    expect(
      capacityAllowsProviderPausedEarlyReclaim({
        phantomActive: 4,
        providerPausedCount: 0,
        freeForGeneralSources: 3,
      }),
    ).toBe(true);
    expect(
      capacityAllowsProviderPausedEarlyReclaim({
        phantomActive: 0,
        providerPausedCount: 5,
        freeForGeneralSources: 3,
      }),
    ).toBe(true);
    // Issue #2357 residual: free=2 with multi-slot hold now fires (was false under #2225 freeBound=3).
    expect(
      capacityAllowsProviderPausedEarlyReclaim({
        phantomActive: 7,
        providerPausedCount: 5,
        freeForGeneralSources: 2,
      }),
    ).toBe(true);
    // Live residual shape: free=2, phantom=3, paused=5 under idle_capacity.
    expect(
      capacityAllowsProviderPausedEarlyReclaim({
        phantomActive: 3,
        providerPausedCount: 5,
        freeForGeneralSources: 2,
        pendingQueueDepth: 0,
      }),
    ).toBe(true);
    // Occupancy under residual bound (phantom+paused < 2) still false.
    expect(
      capacityAllowsProviderPausedEarlyReclaim({
        phantomActive: 0,
        providerPausedCount: 1,
        freeForGeneralSources: 2,
      }),
    ).toBe(false);
    // Pending queue blocks residual path even with multi-slot hold.
    expect(
      capacityAllowsProviderPausedEarlyReclaim({
        phantomActive: 3,
        providerPausedCount: 5,
        freeForGeneralSources: 2,
        pendingQueueDepth: 1,
      }),
    ).toBe(false);
    // Residual path (#2357): free≥1 + occupancy≥2 fires even when under the
    // #2225 occupancyBound of 4 (was false under freeBound/occupancyBound alone).
    expect(
      capacityAllowsProviderPausedEarlyReclaim({
        phantomActive: 1,
        providerPausedCount: 1,
        freeForGeneralSources: 7,
      }),
    ).toBe(true);
    // Still false with zero free headroom (healthy full productive fleet).
    expect(
      capacityAllowsProviderPausedEarlyReclaim({
        phantomActive: 1,
        providerPausedCount: 1,
        freeForGeneralSources: 0,
      }),
    ).toBe(false);
  });

  it('AC3: past soft TTL with capacity gate selects (reclaimAttempted path)', () => {
    const task = pausedTask({ id: 'soft-aged' });
    const sel = selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      softTtlMs: SOFT,
      capacityAllowsEarlyReclaim: true,
      isProviderPaused: alwaysPaused,
      getPauseStartedAtMs: startAgo(SOFT + 60_000),
      isHoldingOpenPr: () => false,
    });
    expect(sel.expired.map((e) => e.task.id)).toEqual(['soft-aged']);
    expect(sel.candidatesConsidered).toBe(1);
  });

  it('under soft TTL still skips even when capacity allows early reclaim', () => {
    const task = pausedTask({ id: 'young' });
    const sel = selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      softTtlMs: SOFT,
      capacityAllowsEarlyReclaim: true,
      isProviderPaused: alwaysPaused,
      getPauseStartedAtMs: startAgo(SOFT - 60_000),
      isHoldingOpenPr: () => false,
    });
    expect(sel.expired).toEqual([]);
    expect(sel.skips.skipped_under_ttl).toBe(1);
  });

  it('past soft but under hard without capacity gate still skips under_ttl', () => {
    const task = pausedTask({ id: 'mid' });
    const sel = selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      softTtlMs: SOFT,
      capacityAllowsEarlyReclaim: false,
      isProviderPaused: alwaysPaused,
      getPauseStartedAtMs: startAgo(SOFT + 60_000),
      isHoldingOpenPr: () => false,
    });
    expect(sel.expired).toEqual([]);
    expect(sel.skips.skipped_under_ttl).toBe(1);
  });
});
