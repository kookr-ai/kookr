import { describe, it, expect } from 'vitest';
import type { Task } from './task-read-model.js';
import {
  DEFAULT_PROVIDER_PAUSED_HARD_TTL_MS,
  DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS,
  capacityAllowsProviderPausedEarlyReclaim,
  effectiveProviderPausedTtlMs,
  listExpiredProviderPausedTasks,
  selectExpiredProviderPausedTasks,
  summarizeOpenPrFailsafeHoldAge,
  summarizeProviderPausedOccupancy,
  knownProviderResetHoldApplies,
  MAX_PROVIDER_PAUSED_HARD_TTL_MS,
  PROVIDER_RESET_HOLD_GRACE_MS,
  type ProviderPausedTtlCandidateOutcome,
  type ProviderResetState,
  isAccountLevelProviderPauseDetail,
  isFirstPartyProviderPauseDetail,
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

describe('summarizeOpenPrFailsafeHoldAge (issue #3115)', () => {
  const HARD_TTL = TTL_MS; // 2h

  function outcome(
    outcome: ProviderPausedTtlCandidateOutcome['outcome'],
    pausedForMs?: number,
  ): ProviderPausedTtlCandidateOutcome {
    return { taskId: `t-${outcome}-${pausedForMs ?? 'na'}`, outcome, pausedForMs };
  }

  it('returns null oldest / zero counts when no open-PR hold is present', () => {
    const summary = summarizeOpenPrFailsafeHoldAge(
      [
        outcome('selected', 3 * 60 * 60_000),
        outcome('skipped_under_ttl', 60_000),
        outcome('skipped_awaiting_provider_reset', 90 * 60_000),
        outcome('skipped_no_pause_start'),
      ],
      HARD_TTL,
    );
    expect(summary).toEqual({
      oldestHoldMs: null,
      holdCount: 0,
      overHardTtlCount: 0,
    });
  });

  it('takes the max pausedForMs across confirmed + unknown open-PR skips', () => {
    const summary = summarizeOpenPrFailsafeHoldAge(
      [
        outcome('skipped_open_pr_confirmed', 90 * 60_000), // 1.5h, under TTL
        outcome('skipped_open_pr_unknown', 5 * 60 * 60_000), // 5h, oldest
        outcome('skipped_open_pr_confirmed', 3 * 60 * 60_000), // 3h
        outcome('selected', 8 * 60 * 60_000), // ignored — not a hold
      ],
      HARD_TTL,
    );
    expect(summary.oldestHoldMs).toBe(5 * 60 * 60_000);
    expect(summary.holdCount).toBe(3);
    // 5h and 3h are over the 2h hard TTL; the 1.5h hold is not.
    expect(summary.overHardTtlCount).toBe(2);
  });

  it('counts a hold at exactly the hard TTL as over-TTL (inclusive)', () => {
    const summary = summarizeOpenPrFailsafeHoldAge(
      [outcome('skipped_open_pr_confirmed', HARD_TTL)],
      HARD_TTL,
    );
    expect(summary.oldestHoldMs).toBe(HARD_TTL);
    expect(summary.overHardTtlCount).toBe(1);
  });

  it('ignores holds without a usable pausedForMs', () => {
    const summary = summarizeOpenPrFailsafeHoldAge(
      [
        outcome('skipped_open_pr_confirmed'), // undefined
        { taskId: 'nan', outcome: 'skipped_open_pr_unknown', pausedForMs: NaN },
        { taskId: 'neg', outcome: 'skipped_open_pr_unknown', pausedForMs: -5 },
        outcome('skipped_open_pr_unknown', 4 * 60 * 60_000),
      ],
      HARD_TTL,
    );
    expect(summary.oldestHoldMs).toBe(4 * 60 * 60_000);
    expect(summary.holdCount).toBe(1);
    expect(summary.overHardTtlCount).toBe(1);
  });

  it('disables the over-TTL count when hardTtlMs is not positive, but still reports oldest', () => {
    const summary = summarizeOpenPrFailsafeHoldAge(
      [outcome('skipped_open_pr_confirmed', 3 * 60 * 60_000)],
      0,
    );
    expect(summary.oldestHoldMs).toBe(3 * 60 * 60_000);
    expect(summary.overHardTtlCount).toBe(0);
  });

  it('is computed from the real selection outcomes, not synthetic input', () => {
    // Two paused tasks holding an open PR: the pure selector emits skip
    // outcomes carrying pausedForMs; the summary reads them. A hold still under
    // the TTL is `skipped_under_ttl` (never reaches the open-PR branch), so only
    // held-a — past the hard TTL — is an open-PR fail-safe hold.
    const base = pausedTask({ id: 'held-a' });
    const other = pausedTask({ id: 'held-b' });
    const startFor: Record<string, number> = {
      'held-a': NOW.getTime() - 3 * 60 * 60_000, // 3h, past hard TTL
      'held-b': NOW.getTime() - 90 * 60_000, // 1.5h, under TTL
    };
    const sel = selectExpiredProviderPausedTasks([base, other], {
      now: NOW,
      isProviderPaused: () => true,
      getPauseStartedAtMs: (task) => startFor[task.id],
      isHoldingOpenPr: () => true, // confirmed open PR → exemption holds
    });
    expect(sel.expired).toEqual([]); // exemption unchanged: nothing reclaimed
    const summary = summarizeOpenPrFailsafeHoldAge(sel.outcomes, TTL_MS);
    expect(summary.oldestHoldMs).toBe(3 * 60 * 60_000);
    expect(summary.holdCount).toBe(1);
    expect(summary.overHardTtlCount).toBe(1);
  });
});

describe('provider reset holds (issue #3562)', () => {
  const nowMs = NOW.getTime();
  const MIN = 60_000;
  const SOFT = DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS;

  function select(opts: {
    pausedForMs: number;
    state: ProviderResetState | undefined;
    capacity?: boolean;
    task?: Task;
  }) {
    const task = opts.task ?? pausedTask();
    return selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      softTtlMs: SOFT,
      capacityAllowsEarlyReclaim: opts.capacity ?? true,
      isProviderPaused: () => true,
      getPauseStartedAtMs: () => nowMs - opts.pausedForMs,
      getProviderResetState: () => opts.state,
      isHoldingOpenPr: () => false,
    });
  }

  const knownIn = (ms: number): ProviderResetState => ({ kind: 'known', resetsAtMs: nowMs + ms });

  it('holds an unclaimed task past the soft TTL while a known reset is ahead', () => {
    // The 2026-11-09 shape: 40m into the pause, reset 3.4h away, no issueClaim.
    const sel = select({ pausedForMs: 41 * MIN, state: knownIn(204 * MIN) });
    expect(sel.expired).toEqual([]);
    expect(sel.outcomes[0].outcome).toBe('skipped_awaiting_provider_reset');
    expect(sel.skips.skipped_awaiting_provider_reset).toBe(1);
  });

  it('holds past the hard TTL too while the known reset is ahead (5h window)', () => {
    const sel = select({ pausedForMs: 3 * 60 * MIN, state: knownIn(90 * MIN), capacity: false });
    expect(sel.expired).toEqual([]);
    expect(sel.outcomes[0].outcome).toBe('skipped_awaiting_provider_reset');
  });

  it('keeps holding through the grace after the reset, then reclaims', () => {
    const inGrace = select({ pausedForMs: 3 * 60 * MIN, state: knownIn(-(PROVIDER_RESET_HOLD_GRACE_MS - MIN)) });
    expect(inGrace.outcomes[0].outcome).toBe('skipped_awaiting_provider_reset');

    const graceOver = select({ pausedForMs: 3 * 60 * MIN, state: knownIn(-PROVIDER_RESET_HOLD_GRACE_MS) });
    expect(graceOver.outcomes[0].outcome).toBe('selected');
  });

  it('caps the hold at the 6h max from pause start (inclusive)', () => {
    const pausedForMs = 60 * MIN;
    const atCap = MAX_PROVIDER_PAUSED_HARD_TTL_MS - pausedForMs - PROVIDER_RESET_HOLD_GRACE_MS;
    expect(select({ pausedForMs, state: knownIn(atCap) }).outcomes[0].outcome)
      .toBe('skipped_awaiting_provider_reset');
    // One ms further out: the hold could not end within 6h, so no hold at all.
    expect(select({ pausedForMs, state: knownIn(atCap + 1) }).outcomes[0].outcome)
      .toBe('selected');
  });

  it('gives no hold to a reset beyond the 6h ceiling (7-day window)', () => {
    const sel = select({ pausedForMs: 41 * MIN, state: knownIn(3 * 24 * 60 * MIN) });
    expect(sel.outcomes[0].outcome).toBe('selected');
  });

  it('does not soft-reclaim an unresolved reset, but the hard TTL still does (#2423)', () => {
    const soft = select({ pausedForMs: 41 * MIN, state: { kind: 'unresolved' } });
    expect(soft.expired).toEqual([]);
    expect(soft.outcomes[0].outcome).toBe('skipped_provider_reset_unresolved');
    expect(soft.skips.skipped_provider_reset_unresolved).toBe(1);
    expect(soft.skips.skipped_awaiting_provider_reset).toBe(0);

    const hard = select({ pausedForMs: TTL_MS, state: { kind: 'unresolved' } });
    expect(hard.outcomes[0].outcome).toBe('selected');
  });

  it('keeps today\'s soft reclaim when the reset is resolved as none', () => {
    expect(select({ pausedForMs: 41 * MIN, state: { kind: 'none' } }).outcomes[0].outcome)
      .toBe('selected');
    expect(select({ pausedForMs: 41 * MIN, state: undefined }).outcomes[0].outcome)
      .toBe('selected');
  });

  it('holds a healthy-quota pause on the soft AND hard path, up to the 6h max (issue #3574)', () => {
    const quotaHealthy: ProviderResetState = { kind: 'quota_healthy' };
    const soft = select({ pausedForMs: 41 * MIN, state: quotaHealthy });
    expect(soft.expired).toEqual([]);
    expect(soft.outcomes[0].outcome).toBe('skipped_provider_quota_healthy');
    expect(soft.skips.skipped_provider_quota_healthy).toBe(1);
    expect(soft.skips.skipped_provider_reset_unresolved).toBe(0);

    expect(select({ pausedForMs: TTL_MS, state: quotaHealthy, capacity: false }).outcomes[0].outcome)
      .toBe('skipped_provider_quota_healthy');
    expect(select({ pausedForMs: MAX_PROVIDER_PAUSED_HARD_TTL_MS - 1, state: quotaHealthy }).outcomes[0].outcome)
      .toBe('skipped_provider_quota_healthy');
    expect(select({ pausedForMs: MAX_PROVIDER_PAUSED_HARD_TTL_MS, state: quotaHealthy }).outcomes[0].outcome)
      .toBe('selected');
  });

  it('still honours the open-PR fail-safe when no reset hold applies', () => {
    const sel = selectExpiredProviderPausedTasks([pausedTask()], {
      now: NOW,
      ttlMs: TTL_MS,
      isProviderPaused: () => true,
      getPauseStartedAtMs: () => nowMs - TTL_MS,
      getProviderResetState: () => ({ kind: 'none' }),
      isHoldingOpenPr: () => true,
    });
    expect(sel.outcomes[0].outcome).toBe('skipped_open_pr_confirmed');
  });

  it('holds a claimed task past the hard TTL on a known reset, where the #1896 hold no longer applies', () => {
    const task = pausedTask({ issueClaim: { repo: 'kookr-ai/kookr', number: 3562 } });
    const sel = selectExpiredProviderPausedTasks([task], {
      now: NOW,
      ttlMs: TTL_MS,
      isProviderPaused: () => true,
      getPauseStartedAtMs: () => nowMs - 3 * 60 * MIN,
      isAwaitingProviderReset: () => true,
      getProviderResetState: () => knownIn(90 * MIN),
      isHoldingOpenPr: () => false,
    });
    expect(sel.outcomes[0].outcome).toBe('skipped_awaiting_provider_reset');
  });

  it('measures the 6h cap from the effective (activity-advanced) pause start', () => {
    // Raw latch 7h ago, last activity 1h ago: effective pause age is 1h, so a
    // reset 4h ahead ends the hold 5h15m after the effective start — within 6h.
    const sel = selectExpiredProviderPausedTasks([pausedTask()], {
      now: NOW,
      ttlMs: TTL_MS,
      softTtlMs: SOFT,
      capacityAllowsEarlyReclaim: true,
      isProviderPaused: () => true,
      getPauseStartedAtMs: () => nowMs - 7 * 60 * MIN,
      getLastActivityAtMs: () => nowMs - 60 * MIN,
      getProviderResetState: () => knownIn(4 * 60 * MIN),
      isHoldingOpenPr: () => false,
    });
    expect(sel.outcomes[0].outcome).toBe('skipped_awaiting_provider_reset');
  });

  it('knownProviderResetHoldApplies measures the cap from the effective pause start', () => {
    const start = nowMs - 30 * MIN;
    expect(knownProviderResetHoldApplies({
      resetsAtMs: start + MAX_PROVIDER_PAUSED_HARD_TTL_MS - PROVIDER_RESET_HOLD_GRACE_MS,
      nowMs,
      effectivePauseStartMs: start,
    })).toBe(true);
    expect(knownProviderResetHoldApplies({
      resetsAtMs: Number.NaN,
      nowMs,
      effectivePauseStartMs: start,
    })).toBe(false);
  });
});

describe('isAccountLevelProviderPauseDetail (issue #4050)', () => {
  it.each([
    'stop_failure:billing_error',
    'stop_failure:authentication_failed',
    'stop_failure:quota_exceeded',
  ])('is true for first-party %s', (detail) => {
    expect(isAccountLevelProviderPauseDetail(detail)).toBe(true);
  });

  it.each([
    'stop_failure:rate_limit',
    'stop_failure:rate_limit_error',
    // Text matched in the stop_failure message, not the error code.
    'stop_failure_message:billing_error',
    'stop_failure_message:quota_exceeded',
    'error_event',
    'text_surface',
    'tool_result',
    'anomaly:api_error',
    'stop_failure:',
    'stop_failure:billing_error_extra',
    'xstop_failure:billing_error',
    '',
    undefined,
  ])('is false for %s', (detail) => {
    expect(isAccountLevelProviderPauseDetail(detail)).toBe(false);
  });
});

describe('isFirstPartyProviderPauseDetail (issues #4050, #4082)', () => {
  it.each([
    'stop_failure:billing_error',
    'stop_failure:authentication_failed',
    'stop_failure:quota_exceeded',
    'stop_failure:rate_limit',
    'stop_failure:rate_limit_error',
  ])('is true for first-party %s', (detail) => {
    expect(isFirstPartyProviderPauseDetail(detail)).toBe(true);
  });

  it.each([
    // Text matched in the stop_failure message, not the error code.
    'stop_failure_message:rate_limit',
    'stop_failure_message:billing_error',
    'error_event',
    'text_surface',
    'tool_result',
    'anomaly:api_error',
    'stop_failure:',
    'stop_failure:rate_limit_extra',
    'stop_failure:rate',
    'xstop_failure:rate_limit',
    '',
    undefined,
  ])('is false for %s', (detail) => {
    expect(isFirstPartyProviderPauseDetail(detail)).toBe(false);
  });
});
