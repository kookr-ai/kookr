import { describe, it, expect } from 'vitest';
import {
  listExpiredFinishedAwaitingAckTasks,
  selectExpiredFinishedAwaitingAckTasks,
  listMetaFinishedAwaitingAckAutoCompleteTasks,
  isMetaFaaAutoCompletePlaybook,
  isMetaFaaAutoCompleteEligible,
  taskHasLiveTurn,
  emptyFinishedAwaitingAckReclaimSkipCounts,
  capacityAllowsFinishedAwaitingAckEarlyReclaim,
  effectiveFinishedAwaitingAckSoftTtlMs,
  DEFAULT_FINISHED_AWAITING_ACK_TTL_MS,
  DEFAULT_FINISHED_AWAITING_ACK_SOFT_TTL_MS,
  DEFAULT_META_FAA_AUTO_COMPLETE_TTL_MS,
  MAX_FINISHED_AWAITING_ACK_TTL_MS,
  MIN_FINISHED_AWAITING_ACK_SOFT_TTL_MS,
} from './finished-awaiting-ack-ttl.js';
import type { Task } from './task-read-model.js';
import type { SessionInfo } from './session-read-model.js';

const NOW = new Date('2026-08-02T12:00:00Z');

function faaTask(overrides: Partial<Task> = {}): Task {
  const raisedAt = overrides.pendingSignal?.raisedAt ?? new Date(NOW.getTime() - 5 * 60_000).toISOString();
  return {
    id: overrides.id ?? `task-${Math.random().toString(36).slice(2)}`,
    prompt: 'do work',
    cwd: '/tmp',
    agentType: 'claude-code',
    status: 'inProgress',
    sessions: [],
    createdAt: new Date(NOW.getTime() - 60 * 60_000),
    updatedAt: NOW,
    pendingSignal: { kind: 'completion_ready', raisedAt },
    ...overrides,
  } as Task;
}

describe('listExpiredFinishedAwaitingAckTasks (issue #1884)', () => {
  const ttlMs = 15 * 60_000; // 15m default, readable offsets

  it('selects an aged finishedAwaitingAck task with no PR hold', () => {
    const stale = faaTask({
      id: 'stale',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW.getTime() - ttlMs - 60_000).toISOString() },
    });
    const expired = listExpiredFinishedAwaitingAckTasks([stale], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    expect(expired.map((e) => e.task.id)).toEqual(['stale']);
    expect(expired[0].ageMs).toBe(ttlMs + 60_000);
  });

  it('exempts an aged finishedAwaitingAck task that holds an open PR (stranded-PR / merge_required exemption)', () => {
    const stale = faaTask({
      id: 'stranded-pr',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW.getTime() - ttlMs - 60_000).toISOString() },
    });
    const expired = listExpiredFinishedAwaitingAckTasks([stale], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => true,
    });
    expect(expired).toEqual([]);
  });

  it('does not select a finishedAwaitingAck task younger than the TTL', () => {
    const fresh = faaTask({
      id: 'fresh',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW.getTime() - ttlMs + 60_000).toISOString() },
    });
    const expired = listExpiredFinishedAwaitingAckTasks([fresh], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    expect(expired).toEqual([]);
  });

  it('does not select a non-finishedAwaitingAck inProgress task (no completion_ready pendingSignal)', () => {
    const working = faaTask({
      id: 'working',
      pendingSignal: undefined,
      createdAt: new Date(NOW.getTime() - 10 * ttlMs),
    });
    const askFirst = faaTask({
      id: 'other-signal',
      pendingSignal: { kind: 'ask_first' as unknown as 'completion_ready', raisedAt: new Date(NOW.getTime() - 10 * ttlMs).toISOString() },
    });
    const expired = listExpiredFinishedAwaitingAckTasks([working, askFirst], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    expect(expired).toEqual([]);
  });

  it('exempts a task when PR-hold status is unknown/unavailable (fail-safe default)', () => {
    const stale = faaTask({
      id: 'unknown-pr-state',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW.getTime() - ttlMs - 60_000).toISOString() },
    });
    const expired = listExpiredFinishedAwaitingAckTasks([stale], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => undefined,
    });
    expect(expired).toEqual([]);
  });

  it('exempts every candidate when no isHoldingOpenPr predicate is wired at all (same fail-safe default)', () => {
    const stale = faaTask({
      id: 'no-predicate',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW.getTime() - ttlMs - 60_000).toISOString() },
    });
    const expired = listExpiredFinishedAwaitingAckTasks([stale], { now: NOW, ttlMs });
    expect(expired).toEqual([]);
  });

  it('ignores statuses other than inProgress regardless of a stray completion_ready-shaped signal', () => {
    const completed = faaTask({ id: 'completed', status: 'completed', createdAt: new Date(NOW.getTime() - 10 * ttlMs) });
    const cancelled = faaTask({ id: 'cancelled', status: 'cancelled', createdAt: new Date(NOW.getTime() - 10 * ttlMs) });
    const expired = listExpiredFinishedAwaitingAckTasks([completed, cancelled], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    expect(expired).toEqual([]);
  });

  it('boundary: exactly at the TTL reclaims (inclusive)', () => {
    const boundary = faaTask({
      id: 'boundary',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW.getTime() - ttlMs).toISOString() },
    });
    const justUnder = faaTask({
      id: 'under',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW.getTime() - ttlMs + 1).toISOString() },
    });
    const expired = listExpiredFinishedAwaitingAckTasks([boundary, justUnder], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    expect(expired.map((e) => e.task.id)).toEqual(['boundary']);
  });

  it('skips a task with a missing or unparseable raisedAt rather than surfacing a bogus age', () => {
    const bogus = faaTask({
      id: 'bogus',
      pendingSignal: { kind: 'completion_ready', raisedAt: 'not-a-date' },
    });
    const expired = listExpiredFinishedAwaitingAckTasks([bogus], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    expect(expired).toEqual([]);
  });

  it('returns oldest-first', () => {
    const older = faaTask({
      id: 'older',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW.getTime() - 3 * ttlMs).toISOString() },
    });
    const newer = faaTask({
      id: 'newer',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW.getTime() - 2 * ttlMs).toISOString() },
    });
    const expired = listExpiredFinishedAwaitingAckTasks([newer, older], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    expect(expired.map((e) => e.task.id)).toEqual(['older', 'newer']);
  });

  it('defaults the TTL to 15 minutes, hard-capped at 30 minutes', () => {
    expect(DEFAULT_FINISHED_AWAITING_ACK_TTL_MS).toBe(15 * 60_000);
    expect(MAX_FINISHED_AWAITING_ACK_TTL_MS).toBe(30 * 60_000);
    const justUnderDefault = faaTask({
      id: 'under-default',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - DEFAULT_FINISHED_AWAITING_ACK_TTL_MS + 1).toISOString(),
      },
    });
    const overDefault = faaTask({
      id: 'over-default',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - DEFAULT_FINISHED_AWAITING_ACK_TTL_MS).toISOString(),
      },
    });
    const expired = listExpiredFinishedAwaitingAckTasks([justUnderDefault, overDefault], {
      now: NOW,
      isHoldingOpenPr: () => false,
    });
    expect(expired.map((e) => e.task.id)).toEqual(['over-default']);
  });
});

describe('selectExpiredFinishedAwaitingAckTasks skip-reason breakdown (issue #2084)', () => {
  const ttlMs = 15 * 60_000;

  function sumSkips(skips: ReturnType<typeof emptyFinishedAwaitingAckReclaimSkipCounts>): number {
    return Object.values(skips).reduce((a, b) => a + b, 0);
  }

  it('counts skipped_under_ttl for a finishedAwaitingAck younger than the TTL', () => {
    const fresh = faaTask({
      id: 'fresh',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - ttlMs + 60_000).toISOString(),
      },
    });
    const sel = selectExpiredFinishedAwaitingAckTasks([fresh], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    expect(sel.expired).toEqual([]);
    expect(sel.candidatesConsidered).toBe(1);
    expect(sel.skips).toEqual({
      ...emptyFinishedAwaitingAckReclaimSkipCounts(),
      skipped_under_ttl: 1,
    });
    expect(sel.outcomes).toEqual([
      { taskId: 'fresh', outcome: 'skipped_under_ttl', ageMs: ttlMs - 60_000 },
    ]);
    expect(sel.candidatesConsidered).toBe(sel.expired.length + sumSkips(sel.skips));
  });

  it('issue #2228: splits open-PR fail-safe into confirmed vs unknown (tri-state)', () => {
    const stranded = faaTask({
      id: 'stranded',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - ttlMs - 60_000).toISOString(),
      },
    });
    const unknown = faaTask({
      id: 'unknown',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - ttlMs - 60_000).toISOString(),
      },
    });
    const unwired = faaTask({
      id: 'unwired',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - ttlMs - 60_000).toISOString(),
      },
    });

    const holdTrue = selectExpiredFinishedAwaitingAckTasks([stranded], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => true,
    });
    expect(holdTrue.skips.skipped_open_pr_confirmed).toBe(1);
    expect(holdTrue.skips.skipped_open_pr_unknown).toBe(0);
    expect(holdTrue.outcomes[0]?.outcome).toBe('skipped_open_pr_confirmed');
    expect(holdTrue.candidatesConsidered).toBe(
      holdTrue.expired.length + sumSkips(holdTrue.skips),
    );

    const holdUnknown = selectExpiredFinishedAwaitingAckTasks([unknown], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => undefined,
    });
    expect(holdUnknown.skips.skipped_open_pr_unknown).toBe(1);
    expect(holdUnknown.skips.skipped_open_pr_confirmed).toBe(0);
    expect(holdUnknown.outcomes[0]?.outcome).toBe('skipped_open_pr_unknown');

    const noPredicate = selectExpiredFinishedAwaitingAckTasks([unwired], {
      now: NOW,
      ttlMs,
    });
    expect(noPredicate.skips.skipped_open_pr_unknown).toBe(1);
    expect(noPredicate.skips.skipped_open_pr_confirmed).toBe(0);
    expect(noPredicate.outcomes[0]?.outcome).toBe('skipped_open_pr_unknown');
    expect(noPredicate.candidatesConsidered).toBe(
      noPredicate.expired.length + sumSkips(noPredicate.skips),
    );
  });

  it('counts skipped_bad_raised_at for missing/unparseable raisedAt', () => {
    const bogus = faaTask({
      id: 'bogus',
      pendingSignal: { kind: 'completion_ready', raisedAt: 'not-a-date' },
    });
    const sel = selectExpiredFinishedAwaitingAckTasks([bogus], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    expect(sel.expired).toEqual([]);
    expect(sel.candidatesConsidered).toBe(1);
    expect(sel.skips.skipped_bad_raised_at).toBe(1);
    expect(sel.outcomes).toEqual([{ taskId: 'bogus', outcome: 'skipped_bad_raised_at' }]);
  });

  it('does not count non-FAA / non-inProgress tasks as candidates', () => {
    const working = faaTask({ id: 'working', pendingSignal: undefined });
    const completed = faaTask({ id: 'done', status: 'completed' });
    const sel = selectExpiredFinishedAwaitingAckTasks([working, completed], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    expect(sel.candidatesConsidered).toBe(0);
    expect(sel.skips).toEqual(emptyFinishedAwaitingAckReclaimSkipCounts());
    expect(sel.outcomes).toEqual([]);
  });

  it('mixed pass: selected + each skip path; candidates = selected + sum(skips)', () => {
    const reclaimable = faaTask({
      id: 'reclaim',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - ttlMs - 10_000).toISOString(),
      },
    });
    const under = faaTask({
      id: 'under',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - ttlMs + 10_000).toISOString(),
      },
    });
    const prHold = faaTask({
      id: 'pr',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - ttlMs - 10_000).toISOString(),
      },
    });
    const bogus = faaTask({
      id: 'bogus',
      pendingSignal: { kind: 'completion_ready', raisedAt: 'bad' },
    });
    const notFaa = faaTask({ id: 'working', pendingSignal: undefined });

    const sel = selectExpiredFinishedAwaitingAckTasks(
      [reclaimable, under, prHold, bogus, notFaa],
      {
        now: NOW,
        ttlMs,
        isHoldingOpenPr: (t) => (t.id === 'pr' ? true : false),
      },
    );

    expect(sel.candidatesConsidered).toBe(4);
    expect(sel.expired.map((e) => e.task.id)).toEqual(['reclaim']);
    expect(sel.skips).toEqual({
      skipped_bad_raised_at: 1,
      skipped_under_ttl: 1,
      skipped_open_pr_confirmed: 1,
      skipped_open_pr_unknown: 0,
    });
    expect(sel.candidatesConsidered).toBe(sel.expired.length + sumSkips(sel.skips));
    expect(sel.outcomes.find((o) => o.taskId === 'reclaim')?.outcome).toBe('selected');
    expect(sel.outcomes.find((o) => o.taskId === 'under')?.outcome).toBe('skipped_under_ttl');
    expect(sel.outcomes.find((o) => o.taskId === 'pr')?.outcome).toBe('skipped_open_pr_confirmed');
    expect(sel.outcomes.find((o) => o.taskId === 'bogus')?.outcome).toBe('skipped_bad_raised_at');
  });

  it('listExpiredFinishedAwaitingAckTasks stays a thin wrapper over select', () => {
    const stale = faaTask({
      id: 'stale',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - ttlMs - 60_000).toISOString(),
      },
    });
    const listed = listExpiredFinishedAwaitingAckTasks([stale], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    const selected = selectExpiredFinishedAwaitingAckTasks([stale], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    expect(listed.map((e) => e.task.id)).toEqual(selected.expired.map((e) => e.task.id));
  });
});

describe('capacity-pressure soft TTL for awaiting_poll FAA (issue #2355)', () => {
  const hardTtlMs = 15 * 60_000;
  const softTtlMs = DEFAULT_FINISHED_AWAITING_ACK_SOFT_TTL_MS; // 5m
  // Stale threshold well above hard TTL so mid-age tasks stay awaiting_poll.
  const staleThresholdMs = 60 * 60_000;

  it('effectiveFinishedAwaitingAckSoftTtlMs clamps soft below hard and above min', () => {
    expect(
      effectiveFinishedAwaitingAckSoftTtlMs({
        ttlMs: hardTtlMs,
        softTtlMs,
      }),
    ).toBe(softTtlMs);
    expect(
      effectiveFinishedAwaitingAckSoftTtlMs({
        ttlMs: 3 * 60_000,
        softTtlMs: 10 * 60_000,
      }),
    ).toBe(3 * 60_000);
    expect(
      effectiveFinishedAwaitingAckSoftTtlMs({
        ttlMs: hardTtlMs,
        softTtlMs: 30_000,
      }),
    ).toBe(MIN_FINISHED_AWAITING_ACK_SOFT_TTL_MS);
  });

  it('capacityAllowsFinishedAwaitingAckEarlyReclaim requires empty queue + util or phantoms', () => {
    // Live shape from issue #2355: effective util 62.5%, phantoms 6, empty queue.
    expect(
      capacityAllowsFinishedAwaitingAckEarlyReclaim({
        effectiveUtilizationPct: 62.5,
        phantomActive: 6,
        pendingQueueDepth: 0,
      }),
    ).toBe(true);

    // Util-only branch: low effective util with no phantoms still fires.
    expect(
      capacityAllowsFinishedAwaitingAckEarlyReclaim({
        effectiveUtilizationPct: 62.5,
        phantomActive: 0,
        pendingQueueDepth: 0,
      }),
    ).toBe(true);

    // High effective util but phantom-bound still fires with empty queue.
    expect(
      capacityAllowsFinishedAwaitingAckEarlyReclaim({
        effectiveUtilizationPct: 90,
        phantomActive: 4,
        pendingQueueDepth: 0,
      }),
    ).toBe(true);

    // Boundary without idleEffectiveSlots: util at threshold + phantoms under
    // #2355 bound → false (legacy path alone).
    expect(
      capacityAllowsFinishedAwaitingAckEarlyReclaim({
        effectiveUtilizationPct: 75,
        phantomActive: 3,
        pendingQueueDepth: 0,
      }),
    ).toBe(false);

    // Issue #2357 residual: same util/phantom with idle_capacity headroom → true.
    expect(
      capacityAllowsFinishedAwaitingAckEarlyReclaim({
        effectiveUtilizationPct: 75,
        phantomActive: 3,
        pendingQueueDepth: 0,
        idleEffectiveSlots: 2,
      }),
    ).toBe(true);

    // Residual path still needs multi-slot phantom hold (bound ≥ 2).
    expect(
      capacityAllowsFinishedAwaitingAckEarlyReclaim({
        effectiveUtilizationPct: 90,
        phantomActive: 1,
        pendingQueueDepth: 0,
        idleEffectiveSlots: 4,
      }),
    ).toBe(false);

    // Non-empty pending queue blocks soft path even under low util.
    expect(
      capacityAllowsFinishedAwaitingAckEarlyReclaim({
        effectiveUtilizationPct: 40,
        phantomActive: 8,
        pendingQueueDepth: 2,
      }),
    ).toBe(false);

    // Healthy fleet: high util, few phantoms, empty queue.
    expect(
      capacityAllowsFinishedAwaitingAckEarlyReclaim({
        effectiveUtilizationPct: 90,
        phantomActive: 1,
        pendingQueueDepth: 0,
      }),
    ).toBe(false);
  });

  it('issue #2357: residual-only shape (util=75, phantom=3) soft-reclaims awaiting_poll', () => {
    // Residual-isolating inputs: #2355 alone rejects util=75 + phantom=3
    // (util not < 75, phantom under bound 4). With idleEffectiveSlots>0 the
    // residual path enables soft TTL; open-PR delivery stays held.
    const hardTtlMsLocal = 15 * 60_000;
    const softTtlMsLocal = DEFAULT_FINISHED_AWAITING_ACK_SOFT_TTL_MS; // 5m
    const staleThresholdMsLocal = 60 * 60_000;
    const softAgedRaisedAt = new Date(NOW.getTime() - softTtlMsLocal - 30_000).toISOString();

    const faaTasks = Array.from({ length: 3 }, (_, i) =>
      faaTask({
        id: `faa-res-${i}`,
        pendingSignal: { kind: 'completion_ready', raisedAt: softAgedRaisedAt },
      }),
    );
    const deliveryOpen = faaTask({
      id: 'delivery-open-res',
      pendingSignal: { kind: 'completion_ready', raisedAt: softAgedRaisedAt },
    });

    // Control: same util/phantom without idle residual → soft gate off.
    expect(
      capacityAllowsFinishedAwaitingAckEarlyReclaim({
        effectiveUtilizationPct: 75,
        phantomActive: 3,
        pendingQueueDepth: 0,
      }),
    ).toBe(false);
    expect(
      capacityAllowsFinishedAwaitingAckEarlyReclaim({
        effectiveUtilizationPct: 75,
        phantomActive: 3,
        pendingQueueDepth: 0,
        idleEffectiveSlots: 0,
      }),
    ).toBe(false);

    const gate = capacityAllowsFinishedAwaitingAckEarlyReclaim({
      effectiveUtilizationPct: 75,
      phantomActive: 3,
      pendingQueueDepth: 0,
      idleEffectiveSlots: 2,
    });
    expect(gate).toBe(true);

    const sel = selectExpiredFinishedAwaitingAckTasks([...faaTasks, deliveryOpen], {
      now: NOW,
      ttlMs: hardTtlMsLocal,
      softTtlMs: softTtlMsLocal,
      capacityAllowsEarlyReclaim: gate,
      staleThresholdMs: staleThresholdMsLocal,
      isHoldingOpenPr: (t) => (t.id === 'delivery-open-res' ? true : false),
    });

    expect(sel.expired.map((e) => e.task.id).sort()).toEqual(
      faaTasks.map((t) => t.id).sort(),
    );
    expect(sel.expired.every((e) => e.capacityPressureEarlyReclaim === true)).toBe(true);
    expect(sel.skips.skipped_open_pr_confirmed).toBe(1);
    expect(sel.outcomes.find((o) => o.taskId === 'delivery-open-res')?.outcome).toBe(
      'skipped_open_pr_confirmed',
    );
    // Without residual pressure the same ages all skip under hard TTL.
    const noPressure = selectExpiredFinishedAwaitingAckTasks(faaTasks, {
      now: NOW,
      ttlMs: hardTtlMsLocal,
      softTtlMs: softTtlMsLocal,
      capacityAllowsEarlyReclaim: false,
      staleThresholdMs: staleThresholdMsLocal,
      isHoldingOpenPr: () => false,
    });
    expect(noPressure.expired).toEqual([]);
    expect(noPressure.skips.skipped_under_ttl).toBe(3);
  });

  it('issue #2357: 16 active / 6 FAA awaiting_poll under idle_capacity reclaims at soft TTL', () => {
    // Live residual shape from the issue: nominal full, 6 poll/ack squatters,
    // idle_capacity with effective free — soft path must free them without
    // waiting the hard 15m bound, and open-PR delivery work stays held.
    const hardTtlMsLocal = 15 * 60_000;
    const softTtlMsLocal = DEFAULT_FINISHED_AWAITING_ACK_SOFT_TTL_MS; // 5m
    const staleThresholdMsLocal = 60 * 60_000;
    const softAgedRaisedAt = new Date(NOW.getTime() - softTtlMsLocal - 30_000).toISOString();

    const faaTasks = Array.from({ length: 6 }, (_, i) =>
      faaTask({
        id: `faa-${i}`,
        pendingSignal: { kind: 'completion_ready', raisedAt: softAgedRaisedAt },
      }),
    );
    // One delivery-open FAA past soft TTL must stay exempt (open-PR failsafe).
    const deliveryOpen = faaTask({
      id: 'delivery-open',
      pendingSignal: { kind: 'completion_ready', raisedAt: softAgedRaisedAt },
    });

    const gate = capacityAllowsFinishedAwaitingAckEarlyReclaim({
      effectiveUtilizationPct: 62.5,
      phantomActive: 6,
      pendingQueueDepth: 0,
      idleEffectiveSlots: 4,
    });
    expect(gate).toBe(true);

    const sel = selectExpiredFinishedAwaitingAckTasks([...faaTasks, deliveryOpen], {
      now: NOW,
      ttlMs: hardTtlMsLocal,
      softTtlMs: softTtlMsLocal,
      capacityAllowsEarlyReclaim: gate,
      staleThresholdMs: staleThresholdMsLocal,
      isHoldingOpenPr: (t) => (t.id === 'delivery-open' ? true : false),
    });

    expect(sel.expired.map((e) => e.task.id).sort()).toEqual(
      faaTasks.map((t) => t.id).sort(),
    );
    expect(sel.expired.every((e) => e.capacityPressureEarlyReclaim === true)).toBe(true);
    expect(sel.skips.skipped_open_pr_confirmed).toBe(1);
    expect(sel.outcomes.find((o) => o.taskId === 'delivery-open')?.outcome).toBe(
      'skipped_open_pr_confirmed',
    );
    // Without capacity pressure the same ages would all skip under hard TTL.
    const noPressure = selectExpiredFinishedAwaitingAckTasks(faaTasks, {
      now: NOW,
      ttlMs: hardTtlMsLocal,
      softTtlMs: softTtlMsLocal,
      capacityAllowsEarlyReclaim: false,
      staleThresholdMs: staleThresholdMsLocal,
      isHoldingOpenPr: () => false,
    });
    expect(noPressure.expired).toEqual([]);
    expect(noPressure.skips.skipped_under_ttl).toBe(6);
  });

  it('past soft TTL with capacity pressure + awaiting_poll → capacity_pressure_early_reclaim', () => {
    const softAged = faaTask({
      id: 'soft-aged',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - softTtlMs - 60_000).toISOString(),
      },
    });
    const sel = selectExpiredFinishedAwaitingAckTasks([softAged], {
      now: NOW,
      ttlMs: hardTtlMs,
      softTtlMs,
      capacityAllowsEarlyReclaim: true,
      staleThresholdMs,
      isHoldingOpenPr: () => false,
    });
    expect(sel.expired.map((e) => e.task.id)).toEqual(['soft-aged']);
    expect(sel.expired[0]?.capacityPressureEarlyReclaim).toBe(true);
    expect(sel.outcomes).toEqual([
      {
        taskId: 'soft-aged',
        outcome: 'capacity_pressure_early_reclaim',
        ageMs: softTtlMs + 60_000,
      },
    ]);
  });

  it('under soft TTL still skips even when capacity pressure allows early reclaim', () => {
    const young = faaTask({
      id: 'young',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - softTtlMs + 60_000).toISOString(),
      },
    });
    const sel = selectExpiredFinishedAwaitingAckTasks([young], {
      now: NOW,
      ttlMs: hardTtlMs,
      softTtlMs,
      capacityAllowsEarlyReclaim: true,
      staleThresholdMs,
      isHoldingOpenPr: () => false,
    });
    expect(sel.expired).toEqual([]);
    expect(sel.skips.skipped_under_ttl).toBe(1);
    expect(sel.outcomes[0]?.outcome).toBe('skipped_under_ttl');
  });

  it('past soft but under hard without capacity pressure still skips under_ttl', () => {
    const mid = faaTask({
      id: 'mid',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - softTtlMs - 60_000).toISOString(),
      },
    });
    const sel = selectExpiredFinishedAwaitingAckTasks([mid], {
      now: NOW,
      ttlMs: hardTtlMs,
      softTtlMs,
      capacityAllowsEarlyReclaim: false,
      staleThresholdMs,
      isHoldingOpenPr: () => false,
    });
    expect(sel.expired).toEqual([]);
    expect(sel.skips.skipped_under_ttl).toBe(1);
  });

  it('past hard TTL under pressure is hard-path selected (not capacity_pressure_early_reclaim)', () => {
    const hardAged = faaTask({
      id: 'hard-aged',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - hardTtlMs - 60_000).toISOString(),
      },
    });
    const sel = selectExpiredFinishedAwaitingAckTasks([hardAged], {
      now: NOW,
      ttlMs: hardTtlMs,
      softTtlMs,
      capacityAllowsEarlyReclaim: true,
      staleThresholdMs,
      isHoldingOpenPr: () => false,
    });
    expect(sel.expired.map((e) => e.task.id)).toEqual(['hard-aged']);
    expect(sel.expired[0]?.capacityPressureEarlyReclaim).toBe(false);
    expect(sel.outcomes[0]?.outcome).toBe('selected');
  });

  it('open-PR failsafe still blocks soft-path reclaim', () => {
    const softAged = faaTask({
      id: 'soft-pr',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - softTtlMs - 60_000).toISOString(),
      },
    });
    const confirmed = selectExpiredFinishedAwaitingAckTasks([softAged], {
      now: NOW,
      ttlMs: hardTtlMs,
      softTtlMs,
      capacityAllowsEarlyReclaim: true,
      staleThresholdMs,
      isHoldingOpenPr: () => true,
    });
    expect(confirmed.expired).toEqual([]);
    expect(confirmed.skips.skipped_open_pr_confirmed).toBe(1);
    expect(confirmed.outcomes[0]?.outcome).toBe('skipped_open_pr_confirmed');

    const unknown = selectExpiredFinishedAwaitingAckTasks([softAged], {
      now: NOW,
      ttlMs: hardTtlMs,
      softTtlMs,
      capacityAllowsEarlyReclaim: true,
      staleThresholdMs,
      isHoldingOpenPr: () => undefined,
    });
    expect(unknown.expired).toEqual([]);
    expect(unknown.skips.skipped_open_pr_unknown).toBe(1);
  });

  it('ask-first never uses soft TTL under production defaults (stays awaiting_poll until hard)', () => {
    // With default stale 60m and hard 15m, ask-first is still awaiting_poll at
    // soft+ε. Soft path must not collapse the human review hold — hard TTL and
    // open-PR failsafe remain the only automated reclaim for ask-first.
    const softAged = faaTask({
      id: 'ask-first-soft',
      deliveryAuthorization: 'ask-first',
      autoCloseOnSignal: false,
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - softTtlMs - 60_000).toISOString(),
      },
    });
    const sel = selectExpiredFinishedAwaitingAckTasks([softAged], {
      now: NOW,
      ttlMs: hardTtlMs,
      softTtlMs,
      capacityAllowsEarlyReclaim: true,
      // Omit staleThresholdMs → production default (60m).
      isHoldingOpenPr: () => false,
    });
    expect(sel.expired).toEqual([]);
    expect(sel.skips.skipped_under_ttl).toBe(1);
    expect(sel.outcomes[0]?.outcome).toBe('skipped_under_ttl');
  });

  it('manual_review_gate / auto_close_disabled never use soft TTL (cause filter)', () => {
    // Use a short stale threshold so age is past stale → stall cause (not
    // awaiting_poll), still under hard TTL so only soft path could select —
    // and must not.
    const shortStale = 10 * 60_000;
    const ageMs = 12 * 60_000; // past shortStale, under hardTtl

    const manualReview = faaTask({
      id: 'manual',
      deliveryAuthorization: 'ask-first',
      autoCloseOnSignal: false,
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - ageMs).toISOString(),
      },
    });
    const autoCloseOff = faaTask({
      id: 'auto-off',
      autoCloseOnSignal: false,
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - ageMs).toISOString(),
      },
    });

    const sel = selectExpiredFinishedAwaitingAckTasks([manualReview, autoCloseOff], {
      now: NOW,
      ttlMs: hardTtlMs,
      softTtlMs,
      capacityAllowsEarlyReclaim: true,
      staleThresholdMs: shortStale,
      isHoldingOpenPr: () => false,
    });
    // Both are past short stale → not awaiting_poll → hard TTL only → under hard → skip.
    expect(sel.expired).toEqual([]);
    expect(sel.skips.skipped_under_ttl).toBe(2);
    expect(sel.outcomes.every((o) => o.outcome === 'skipped_under_ttl')).toBe(true);
  });

  it('decision table: causes × age × open-PR × pressure', () => {
    type Outcome = ReturnType<
      typeof selectExpiredFinishedAwaitingAckTasks
    >['outcomes'][number]['outcome'];

    const shortStale = 10 * 60_000;
    const rows: Array<{
      id: string;
      ageMs: number;
      openPr: boolean | undefined;
      pressure: boolean;
      deliveryAuthorization?: 'ask-first';
      autoCloseOnSignal?: boolean;
      expectOutcome: Outcome;
    }> = [
      // awaiting_poll, soft-aged, pressure, no PR → early reclaim
      {
        id: 'poll-soft-pressure',
        ageMs: softTtlMs + 30_000,
        openPr: false,
        pressure: true,
        expectOutcome: 'capacity_pressure_early_reclaim',
      },
      // awaiting_poll, soft-aged, no pressure → under_ttl
      {
        id: 'poll-soft-nopressure',
        ageMs: softTtlMs + 30_000,
        openPr: false,
        pressure: false,
        expectOutcome: 'skipped_under_ttl',
      },
      // awaiting_poll, soft-aged, pressure, open PR → confirmed skip
      {
        id: 'poll-soft-pr',
        ageMs: softTtlMs + 30_000,
        openPr: true,
        pressure: true,
        expectOutcome: 'skipped_open_pr_confirmed',
      },
      // awaiting_poll, hard-aged, no pressure → selected
      {
        id: 'poll-hard',
        ageMs: hardTtlMs + 30_000,
        openPr: false,
        pressure: false,
        expectOutcome: 'selected',
      },
      // manual_review_gate past stale, under hard, pressure → under_ttl (no soft)
      {
        id: 'manual-mid-pressure',
        ageMs: 12 * 60_000,
        openPr: false,
        pressure: true,
        deliveryAuthorization: 'ask-first',
        autoCloseOnSignal: false,
        expectOutcome: 'skipped_under_ttl',
      },
      // young under soft even with pressure → under_ttl
      {
        id: 'young-pressure',
        ageMs: softTtlMs - 30_000,
        openPr: false,
        pressure: true,
        expectOutcome: 'skipped_under_ttl',
      },
    ];

    for (const row of rows) {
      const task = faaTask({
        id: row.id,
        deliveryAuthorization: row.deliveryAuthorization,
        autoCloseOnSignal: row.autoCloseOnSignal,
        pendingSignal: {
          kind: 'completion_ready',
          raisedAt: new Date(NOW.getTime() - row.ageMs).toISOString(),
        },
      });
      const sel = selectExpiredFinishedAwaitingAckTasks([task], {
        now: NOW,
        ttlMs: hardTtlMs,
        softTtlMs,
        capacityAllowsEarlyReclaim: row.pressure,
        staleThresholdMs: shortStale,
        isHoldingOpenPr: () => row.openPr,
      });
      expect(sel.outcomes[0]?.outcome, row.id).toBe(row.expectOutcome);
    }
  });
});

describe('meta FAA auto-complete eligibility (issue #2070)', () => {
  it('matches allowlisted meta/playbook ids and name-only fallback', () => {
    expect(isMetaFaaAutoCompletePlaybook({ playbookId: 'cross-repo-orchestrator.md' })).toBe(true);
    expect(isMetaFaaAutoCompletePlaybook({ playbookId: 'parallel-issue-batch.md' })).toBe(true);
    expect(isMetaFaaAutoCompletePlaybook({ playbookId: 'lucy-workflow-incident-sentinel.md' })).toBe(true);
    expect(isMetaFaaAutoCompletePlaybook({ playbookId: 'lucy-workflow-reflection.md' })).toBe(true);
    expect(isMetaFaaAutoCompletePlaybook({ playbookId: 'repository-idea-scout.md' })).toBe(true);
    expect(isMetaFaaAutoCompletePlaybook({ playbookId: 'pr-merge-rebase-watchdog.md' })).toBe(true);
    // Name fallback only when playbookId is absent.
    expect(isMetaFaaAutoCompletePlaybook({ name: 'Lucy Progress Watchdog' })).toBe(true);
    // Implementers must NOT match.
    expect(isMetaFaaAutoCompletePlaybook({ playbookId: 'implement-github-issue.md' })).toBe(false);
    expect(isMetaFaaAutoCompletePlaybook({ playbookId: 'oss-bug-fix.md' })).toBe(false);
  });

  it('does not relax PR fail-safe when an implementer name contains a meta substring', () => {
    // Regression for reviewer B1: playbookId wins; name is ignored when set.
    expect(
      isMetaFaaAutoCompletePlaybook({
        playbookId: 'implement-github-issue.md',
        name: 'Fix orchestrator race in sentinel reflection',
      }),
    ).toBe(false);
    expect(
      isMetaFaaAutoCompleteEligible({
        playbookId: 'implement-github-issue.md',
        name: 'Fix orchestrator race in sentinel reflection',
        pendingSignal: {
          kind: 'completion_ready',
          raisedAt: NOW.toISOString(),
          source: 'http',
        },
      }),
    ).toBe(false);
  });

  it('does not treat bare source=http as meta-eligible without an allowlist match', () => {
    expect(
      isMetaFaaAutoCompleteEligible({
        pendingSignal: {
          kind: 'completion_ready',
          raisedAt: NOW.toISOString(),
          source: 'http',
        },
      }),
    ).toBe(false);
  });

  it('taskHasLiveTurn detects running / waiting_for_input / blocked sessions', () => {
    const running: SessionInfo = {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/tmp',
      createdAt: NOW,
      lastTurnState: 'running',
    };
    const waiting: SessionInfo = {
      tmuxSession: 's3',
      agentType: 'claude-code',
      cwd: '/tmp',
      createdAt: NOW,
      lastTurnState: 'waiting_for_input',
    };
    const blocked: SessionInfo = {
      tmuxSession: 's4',
      agentType: 'claude-code',
      cwd: '/tmp',
      createdAt: NOW,
      lastTurnState: 'blocked',
    };
    const idle: SessionInfo = {
      tmuxSession: 's2',
      agentType: 'claude-code',
      cwd: '/tmp',
      createdAt: NOW,
      lastTurnState: 'completed_turn',
    };
    expect(taskHasLiveTurn({ sessions: [running] })).toBe(true);
    expect(taskHasLiveTurn({ sessions: [waiting] })).toBe(true);
    expect(taskHasLiveTurn({ sessions: [blocked] })).toBe(true);
    expect(taskHasLiveTurn({ sessions: [idle] })).toBe(false);
    expect(
      taskHasLiveTurn({
        sessions: [{ ...running, lastStatus: 'completed' }],
      }),
    ).toBe(false);
  });
});

describe('listMetaFinishedAwaitingAckAutoCompleteTasks (issue #2070)', () => {
  const ttlMs = DEFAULT_META_FAA_AUTO_COMPLETE_TTL_MS;

  it('selects an aged meta playbook FAA task even when PR-hold is unknown (relaxed fail-safe)', () => {
    const stale = faaTask({
      id: 'orchestrator',
      playbookId: 'cross-repo-orchestrator.md',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - ttlMs - 60_000).toISOString(),
        source: 'http',
      },
      sessions: [
        {
          tmuxSession: 's',
          agentType: 'grok-build',
          cwd: '/tmp',
          createdAt: new Date(NOW.getTime() - 30 * 60_000),
          lastTurnState: 'completed_turn',
        } as SessionInfo,
      ],
    });
    // Strict path would skip (undefined ≠ false).
    expect(
      listExpiredFinishedAwaitingAckTasks([stale], {
        now: NOW,
        ttlMs,
        isHoldingOpenPr: () => undefined,
      }),
    ).toEqual([]);

    const selected = listMetaFinishedAwaitingAckAutoCompleteTasks([stale], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => undefined,
    });
    expect(selected.map((e) => e.task.id)).toEqual(['orchestrator']);
  });

  it('still blocks meta tasks with a confirmed-open PR', () => {
    const stranded = faaTask({
      id: 'meta-with-pr',
      playbookId: 'parallel-issue-batch.md',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - ttlMs - 60_000).toISOString(),
        source: 'http',
      },
    });
    const selected = listMetaFinishedAwaitingAckAutoCompleteTasks([stranded], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => true,
    });
    expect(selected).toEqual([]);
  });

  it('still selects a live-turn task at pure select time (TOCTOU defer is the sweep\'s job)', () => {
    const live = faaTask({
      id: 'live-turn',
      playbookId: 'lucy-workflow-reflection.md',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - ttlMs - 60_000).toISOString(),
        source: 'http',
      },
      sessions: [
        {
          tmuxSession: 's',
          agentType: 'claude-code',
          cwd: '/tmp',
          createdAt: new Date(NOW.getTime() - 30 * 60_000),
          lastTurnState: 'running',
        } as SessionInfo,
      ],
    });
    // Pure selector leaves live-turn veto to the sweep so deferrals are countable.
    const selected = listMetaFinishedAwaitingAckAutoCompleteTasks([live], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => undefined,
    });
    expect(selected.map((e) => e.task.id)).toEqual(['live-turn']);
    expect(taskHasLiveTurn(live)).toBe(true);
  });

  it('does not select an implementer playbook under the relaxed path (even with clear PR)', () => {
    const implementer = faaTask({
      id: 'implementer',
      playbookId: 'implement-github-issue.md',
      name: 'Fix orchestrator race',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - ttlMs - 60_000).toISOString(),
        source: 'http',
      },
    });
    // Not allowlisted — stays on the strict #1884 path only.
    const selected = listMetaFinishedAwaitingAckAutoCompleteTasks([implementer], {
      now: NOW,
      ttlMs,
      isHoldingOpenPr: () => false,
    });
    expect(selected).toEqual([]);
  });

  it('does not select younger than the meta TTL', () => {
    const fresh = faaTask({
      id: 'fresh-meta',
      playbookId: 'cross-repo-orchestrator.md',
      pendingSignal: {
        kind: 'completion_ready',
        raisedAt: new Date(NOW.getTime() - ttlMs + 60_000).toISOString(),
        source: 'http',
      },
    });
    expect(
      listMetaFinishedAwaitingAckAutoCompleteTasks([fresh], {
        now: NOW,
        ttlMs,
        isHoldingOpenPr: () => undefined,
      }),
    ).toEqual([]);
  });
});
