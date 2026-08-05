import { describe, it, expect } from 'vitest';
import type { Task } from './task-read-model.js';
import {
  DEFAULT_PROVIDER_PAUSED_HARD_TTL_MS,
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

  it('open-PR fail-safe skips even past TTL (no strand)', () => {
    const task = pausedTask();
    const sel = selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      isProviderPaused: alwaysPaused,
      getPauseStartedAtMs: startAgo(TTL_MS + 60_000),
      isHoldingOpenPr: () => true,
    });
    expect(sel.expired).toEqual([]);
    expect(sel.skips.skipped_open_pr_failsafe).toBe(1);
    expect(sel.outcomes[0].outcome).toBe('skipped_open_pr_failsafe');
  });

  it('unknown open-PR is fail-safe skip (undefined treated as hold)', () => {
    const task = pausedTask();
    const sel = selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      isProviderPaused: alwaysPaused,
      getPauseStartedAtMs: startAgo(TTL_MS + 60_000),
      isHoldingOpenPr: () => undefined,
    });
    expect(sel.expired).toEqual([]);
    expect(sel.skips.skipped_open_pr_failsafe).toBe(1);
  });

  it('omitted isHoldingOpenPr is fail-safe skip for every candidate', () => {
    const task = pausedTask();
    const sel = selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      isProviderPaused: alwaysPaused,
      getPauseStartedAtMs: startAgo(TTL_MS + 60_000),
      // isHoldingOpenPr omitted
    });
    expect(sel.expired).toEqual([]);
    expect(sel.skips.skipped_open_pr_failsafe).toBe(1);
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

  it('skips while awaiting provider reset (#1896 hold-for-resume)', () => {
    const task = pausedTask();
    const sel = selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      isProviderPaused: alwaysPaused,
      getPauseStartedAtMs: startAgo(TTL_MS + 60_000),
      isAwaitingProviderReset: () => true,
      isHoldingOpenPr: () => false,
    });
    expect(sel.expired).toEqual([]);
    expect(sel.skips.skipped_awaiting_provider_reset).toBe(1);
    expect(sel.outcomes[0].outcome).toBe('skipped_awaiting_provider_reset');
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
