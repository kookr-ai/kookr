import { describe, expect, test } from 'vitest';
import {
  BATCH_KICK_COOLDOWN_MS,
  BATCH_OUTCOME_SCHEMA_VERSION,
  classifyStarvationLight,
  clearKickBatchPending,
  EMPTY_IDEATION_FREE_SLOTS_THRESHOLD,
  evaluatePipelineStarvationRefill,
  isBatchKickInCooldown,
  isIdeationSuccessEmptyQueue,
  isKickBatchPendingArmed,
  isParallelIssueBatchInFlightForRepo,
  isPipelineBatchKickEnabled,
  isScoutDedupBeltEmptyBypass,
  KICK_BATCH_PENDING_TTL_MS,
  looksLikeConcurrentBatchEmpty,
  nextPipelineStarvationState,
  parseBatchOutcomeRecord,
  REFILL_POSTCONDITION_MIN_CONSECUTIVE,
  repoToPlaybookSlug,
  resolveBatchEmptyClass,
  SCOUT_ANTI_THRASH_MS,
  STARVATION_ALERT_WINDOW_MS,
  STARVATION_SCOUT_DEDUP_MS,
  starvationScoutIdempotencyKey,
  summarizeDisqualifiers,
  type BatchOutcomeRecord,
  type PipelineStarvationRepoState,
} from './pipeline-starvation.js';

const NOW = Date.parse('2026-07-30T08:15:00.000Z');

function blockedEmpty(overrides: Partial<BatchOutcomeRecord> = {}): BatchOutcomeRecord {
  return {
    schemaVersion: BATCH_OUTCOME_SCHEMA_VERSION,
    outcome: 'blocked-empty',
    repo: 'jeanibarz/lucy',
    runKey: 'run-1',
    reason: 'No safe, unblocked, single-PR issue remains',
    openIssueCount: 24,
    disqualified: [
      { issue: 1, title: 'a', reason: 'already has open PR' },
      { issue: 2, title: 'b', reason: 'already has open PR' },
      { issue: 3, title: 'c', reason: 'label:blocked' },
    ],
    generatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function prior(partial: Partial<PipelineStarvationRepoState> = {}): PipelineStarvationRepoState {
  return {
    schemaVersion: 1,
    repo: 'jeanibarz/lucy',
    blockedEmptyAt: [],
    handledRunKeys: [],
    updatedAt: new Date(NOW - 60_000).toISOString(),
    ...partial,
  };
}

describe('pipeline-starvation pure decision (#1715)', () => {
  test('repo slug replaces slash and dots', () => {
    expect(repoToPlaybookSlug('jeanibarz/lucy')).toBe('jeanibarz-lucy');
    expect(repoToPlaybookSlug('kookr-ai/kookr')).toBe('kookr-ai-kookr');
  });

  test('summarizeDisqualifiers ranks by count', () => {
    const summary = summarizeDisqualifiers(blockedEmpty().disqualified);
    expect(summary).toContain('already has open PR×2');
    expect(summary).toContain('label:blocked×1');
  });

  test('first blocked-empty with clear queue spawns scout and does NOT alert', () => {
    const decision = evaluatePipelineStarvationRefill(blockedEmpty(), {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: null,
      scoutInFlight: false,
      prior: null,
    });
    expect(decision.applicable).toBe(true);
    expect(decision.spawnScout).toBe(true);
    expect(decision.emitStarvationAlert).toBe(false);
    expect(decision.alertSkipReason).toMatch(/first blocked-empty/i);
    expect(decision.consecutiveBlockedEmpty).toBe(1);
  });

  test('second consecutive blocked-empty within 12h emits starvation alert', () => {
    const firstAt = new Date(NOW - 3 * 60 * 60 * 1000).toISOString(); // 3h ago
    const decision = evaluatePipelineStarvationRefill(blockedEmpty({ runKey: 'run-2' }), {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: null,
      scoutInFlight: false,
      // First event already recorded a scout; second must still alert.
      prior: prior({
        blockedEmptyAt: [firstAt],
        lastStarvationScoutAt: firstAt,
        lastStarvationScoutTaskId: 'scout-task-1',
      }),
    });
    expect(decision.consecutiveBlockedEmpty).toBe(2);
    expect(decision.emitStarvationAlert).toBe(true);
    // Scout still deduped within 4h of the first starvation spawn.
    expect(decision.spawnScout).toBe(false);
    expect(decision.spawnSkipReason).toMatch(/already spawned/i);
  });

  test('first of two does not alert — only the second does (AC)', () => {
    const first = evaluatePipelineStarvationRefill(blockedEmpty(), {
      nowMs: NOW - 60_000,
      recentSuccessfulIdeationAtMs: null,
      scoutInFlight: false,
      prior: null,
    });
    expect(first.emitStarvationAlert).toBe(false);
    expect(first.spawnScout).toBe(true);

    const afterFirst = nextPipelineStarvationState('jeanibarz/lucy', null, first, {
      nowMs: NOW - 60_000,
      spawnedTaskId: 't-scout',
    });

    const second = evaluatePipelineStarvationRefill(blockedEmpty({ runKey: 'run-2' }), {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: null,
      scoutInFlight: false,
      prior: afterFirst,
    });
    expect(second.emitStarvationAlert).toBe(true);
    expect(second.spawnScout).toBe(false); // still inside 4h dedup
  });

  test('does not re-alert for third empty inside the same episode', () => {
    const t1 = new Date(NOW - 6 * 60 * 60 * 1000).toISOString();
    const t2 = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();
    const decision = evaluatePipelineStarvationRefill(blockedEmpty({ runKey: 'run-3' }), {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: null,
      scoutInFlight: false,
      prior: prior({
        blockedEmptyAt: [t1, t2],
        lastStarvationAlertAt: t2,
      }),
    });
    expect(decision.consecutiveBlockedEmpty).toBe(3);
    expect(decision.emitStarvationAlert).toBe(false);
    expect(decision.alertSkipReason).toMatch(/already emitted/i);
  });

  test('skips spawn when a scout is in flight', () => {
    const decision = evaluatePipelineStarvationRefill(blockedEmpty(), {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: null,
      scoutInFlight: true,
      prior: null,
    });
    expect(decision.spawnScout).toBe(false);
    expect(decision.spawnSkipReason).toMatch(/already running/i);
  });

  test('skips spawn when successful ideation ran recently', () => {
    const decision = evaluatePipelineStarvationRefill(blockedEmpty(), {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: NOW - 30 * 60 * 1000, // 30m ago
      scoutInFlight: false,
      prior: null,
    });
    expect(decision.spawnScout).toBe(false);
    expect(decision.spawnSkipReason).toMatch(/successful ideation/i);
    expect(decision.ideationSuccessEmptyQueue).toBeUndefined();
  });

  test('skips spawn on successful ideation when queue still has work (4h dedup holds)', () => {
    // Issue #2043: capacity busy / non-empty queue → ideation was a real refill.
    const decision = evaluatePipelineStarvationRefill(blockedEmpty(), {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: NOW - 30 * 60 * 1000,
      scoutInFlight: false,
      prior: null,
      capacity: { free: 7, pendingQueueDepth: 3 },
    });
    expect(decision.spawnScout).toBe(false);
    expect(decision.followOnAction).toBe('batch_kick_only');
    expect(decision.spawnSkipReason).toMatch(/successful ideation/i);
    expect(decision.ideationSuccessEmptyQueue).toBeUndefined();
  });

  test('does NOT 4h-suppress on successful ideation when free≥3 and queue empty (#2043)', () => {
    // Lucy 2026-08-04: ideation "success" left zero implementable leaves;
    // free=7/16 idle while lastSpawnSkipReason stayed "successful ideation".
    const decision = evaluatePipelineStarvationRefill(blockedEmpty({ runKey: 'empty-ideation' }), {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: NOW - 45 * 60 * 1000,
      scoutInFlight: false,
      prior: null,
      capacity: { free: 7, pendingQueueDepth: 0 },
    });
    expect(decision.spawnScout).toBe(true);
    expect(decision.followOnAction).toBe('idea_scout');
    expect(decision.ideationSuccessEmptyQueue).toBe(true);
    expect(decision.spawnSkipReason).toBeUndefined();
  });

  test('empty-queue ideation + belt empty bypasses 4h scout dedup after thrash floor (#2068)', () => {
    // Prior: empty-queue ideation still re-opened scout path (#2043), but the
    // 4h starvation-scout spawn gate blocked re-fire. #2068: after anti-thrash
    // floor, free≥3 + pending=0 allows refill even inside the 4h window.
    const decision = evaluatePipelineStarvationRefill(blockedEmpty({ runKey: 'after-scout' }), {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: NOW - 30 * 60 * 1000,
      scoutInFlight: false,
      prior: prior({
        blockedEmptyAt: [new Date(NOW - 90 * 60 * 1000).toISOString()],
        handledRunKeys: ['prior-empty'],
        lastStarvationScoutAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
        lastStarvationScoutTaskId: 'recent-scout',
      }),
      capacity: { free: EMPTY_IDEATION_FREE_SLOTS_THRESHOLD, pendingQueueDepth: 0 },
    });
    expect(decision.ideationSuccessEmptyQueue).toBe(true);
    expect(decision.spawnScout).toBe(true);
    expect(decision.followOnAction).toBe('idea_scout');
    expect(decision.scoutDedupBypassedForBeltEmpty).toBe(true);
    expect(decision.starvationRefillPostcondition).toBe('pass');
    expect(decision.spawnSkipReason).toBeUndefined();
  });

  test('isIdeationSuccessEmptyQueue gate', () => {
    expect(isIdeationSuccessEmptyQueue(null)).toBe(false);
    expect(isIdeationSuccessEmptyQueue(undefined)).toBe(false);
    expect(isIdeationSuccessEmptyQueue({ free: 2, pendingQueueDepth: 0 })).toBe(false);
    expect(isIdeationSuccessEmptyQueue({ free: 3, pendingQueueDepth: 1 })).toBe(false);
    expect(isIdeationSuccessEmptyQueue({ free: 3, pendingQueueDepth: 0 })).toBe(true);
    expect(isIdeationSuccessEmptyQueue({ free: 7, pendingQueueDepth: 0 })).toBe(true);
  });

  test('skips spawn when starvation scout already fired inside 4h window', () => {
    // No capacity snapshot → legacy 4h gate holds (missing capacity preserves suppress).
    const decision = evaluatePipelineStarvationRefill(blockedEmpty(), {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: null,
      scoutInFlight: false,
      prior: prior({
        lastStarvationScoutAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
        lastStarvationScoutTaskId: 'prior-scout',
      }),
    });
    expect(decision.spawnScout).toBe(false);
    expect(decision.spawnSkipReason).toMatch(/already spawned/i);
    expect(decision.starvationRefillPostcondition).toBeUndefined();
  });

  test('allows a new scout after the 4h dedup window', () => {
    const decision = evaluatePipelineStarvationRefill(blockedEmpty(), {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: null,
      scoutInFlight: false,
      prior: prior({
        lastStarvationScoutAt: new Date(NOW - STARVATION_SCOUT_DEDUP_MS - 1).toISOString(),
        lastStarvationScoutTaskId: 'old-scout',
        // Prior empty is outside the 12h alert window so this is a fresh episode.
        blockedEmptyAt: [new Date(NOW - STARVATION_ALERT_WINDOW_MS - 1).toISOString()],
      }),
    });
    expect(decision.spawnScout).toBe(true);
    expect(decision.consecutiveBlockedEmpty).toBe(1);
    expect(decision.emitStarvationAlert).toBe(false);
  });

  describe('belt-empty residual scout cooldown bypass (#2068 / #2071)', () => {
    test('scout completed + belt empty + free slots → refill allowed inside 4h', () => {
      // Live residual: scout at T-90m filed shallow leaves that burned; free=7,
      // queue=0, consecutiveBlockedEmpty climbing under 4h "already spawned".
      const decision = evaluatePipelineStarvationRefill(
        blockedEmpty({ runKey: 'belt-empty-refill' }),
        {
          nowMs: NOW,
          recentSuccessfulIdeationAtMs: null,
          scoutInFlight: false,
          prior: prior({
            blockedEmptyAt: [
              new Date(NOW - 3 * 60 * 60 * 1000).toISOString(),
              new Date(NOW - 90 * 60 * 1000).toISOString(),
            ],
            handledRunKeys: ['e1', 'e2'],
            lastStarvationScoutAt: new Date(NOW - 90 * 60 * 1000).toISOString(),
            lastStarvationScoutTaskId: 'scout-4e935500',
            lastSpawnSkipReason:
              'starvation-triggered scout already spawned within last 4h',
          }),
          capacity: { free: 7, pendingQueueDepth: 0 },
        },
      );
      expect(decision.spawnScout).toBe(true);
      expect(decision.followOnAction).toBe('idea_scout');
      expect(decision.scoutDedupBypassedForBeltEmpty).toBe(true);
      expect(decision.starvationRefillPostcondition).toBe('pass');
      expect(decision.scoutCooldownSkipWhileBeltEmpty).toBeUndefined();
      expect(decision.consecutiveBlockedEmpty).toBe(3);
    });

    test('anti-thrash floor still blocks double-fire within N minutes', () => {
      const lastScoutAt = NOW - (SCOUT_ANTI_THRASH_MS - 60_000); // 1m inside thrash floor
      const decision = evaluatePipelineStarvationRefill(
        blockedEmpty({ runKey: 'thrash-floor' }),
        {
          nowMs: NOW,
          recentSuccessfulIdeationAtMs: null,
          scoutInFlight: false,
          prior: prior({
            blockedEmptyAt: [new Date(NOW - 30 * 60 * 1000).toISOString()],
            handledRunKeys: ['e1'],
            lastStarvationScoutAt: new Date(lastScoutAt).toISOString(),
            lastStarvationScoutTaskId: 'just-spawned',
          }),
          capacity: { free: 7, pendingQueueDepth: 0 },
        },
      );
      expect(decision.spawnScout).toBe(false);
      expect(decision.spawnSkipReason).toMatch(/already spawned/i);
      expect(decision.scoutCooldownSkipWhileBeltEmpty).toBe(true);
      expect(decision.starvationRefillPostcondition).toBe('fail');
      expect(decision.scoutDedupBypassedForBeltEmpty).toBeUndefined();

      const state = nextPipelineStarvationState('jeanibarz/lucy', prior({
        blockedEmptyAt: [new Date(NOW - 30 * 60 * 1000).toISOString()],
        handledRunKeys: ['e1'],
        lastStarvationScoutAt: new Date(lastScoutAt).toISOString(),
        scoutCooldownSkipsWhileBeltEmpty: 2,
      }), decision, { nowMs: NOW });
      expect(state.scoutCooldownSkipsWhileBeltEmpty).toBe(3);
    });

    test('free≥5 + empty queue + consecutive≥2 cannot stay on 4h skip (#2071)', () => {
      // Three consecutive feeder/starvation ticks with free≥5 must not all end
      // in "scout skipped within 4h" once thrash floor elapsed — emit attempt.
      const lastScoutAt = NOW - 40 * 60 * 1000; // past 25m thrash, inside 4h
      const decision = evaluatePipelineStarvationRefill(
        blockedEmpty({ runKey: 'postcondition-tick' }),
        {
          nowMs: NOW,
          recentSuccessfulIdeationAtMs: null,
          scoutInFlight: false,
          prior: prior({
            blockedEmptyAt: [
              new Date(NOW - 2 * 60 * 60 * 1000).toISOString(),
              new Date(NOW - 50 * 60 * 1000).toISOString(),
            ],
            handledRunKeys: ['t1', 't2'],
            lastStarvationScoutAt: new Date(lastScoutAt).toISOString(),
            lastStarvationScoutTaskId: 'prior-scout',
          }),
          capacity: { free: 5, pendingQueueDepth: 0 },
        },
      );
      expect(decision.consecutiveBlockedEmpty).toBeGreaterThanOrEqual(
        REFILL_POSTCONDITION_MIN_CONSECUTIVE,
      );
      expect(decision.spawnScout).toBe(true);
      expect(decision.starvationRefillPostcondition).toBe('pass');
      expect(decision.scoutDedupBypassedForBeltEmpty).toBe(true);
    });

    test('4h gate still holds when free slots idle but queue has work', () => {
      const decision = evaluatePipelineStarvationRefill(
        blockedEmpty({ runKey: 'queued-work' }),
        {
          nowMs: NOW,
          recentSuccessfulIdeationAtMs: null,
          scoutInFlight: false,
          prior: prior({
            blockedEmptyAt: [new Date(NOW - 60 * 60 * 1000).toISOString()],
            handledRunKeys: ['e1'],
            lastStarvationScoutAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
          }),
          capacity: { free: 7, pendingQueueDepth: 2 },
        },
      );
      expect(decision.spawnScout).toBe(false);
      expect(decision.spawnSkipReason).toMatch(/already spawned/i);
      expect(decision.starvationRefillPostcondition).toBeUndefined();
      expect(decision.scoutCooldownSkipWhileBeltEmpty).toBeUndefined();
    });

    test('isScoutDedupBeltEmptyBypass helper edges', () => {
      expect(isScoutDedupBeltEmptyBypass(null, {
        nowMs: NOW,
        lastStarvationScoutAtMs: NOW - 60 * 60 * 1000,
        consecutiveBlockedEmpty: 3,
      })).toBe(false);
      expect(isScoutDedupBeltEmptyBypass({ free: 7, pendingQueueDepth: 0 }, {
        nowMs: NOW,
        lastStarvationScoutAtMs: NOW - 10 * 60 * 1000, // inside thrash
        consecutiveBlockedEmpty: 3,
      })).toBe(false);
      expect(isScoutDedupBeltEmptyBypass({ free: 7, pendingQueueDepth: 0 }, {
        nowMs: NOW,
        lastStarvationScoutAtMs: NOW - 60 * 60 * 1000,
        consecutiveBlockedEmpty: 1, // below min consecutive
      })).toBe(false);
      expect(isScoutDedupBeltEmptyBypass({ free: 7, pendingQueueDepth: 0 }, {
        nowMs: NOW,
        lastStarvationScoutAtMs: NOW - 60 * 60 * 1000,
        consecutiveBlockedEmpty: 2,
      })).toBe(true);
    });
  });

  test('ignores non-blocked-empty outcomes', () => {
    const decision = evaluatePipelineStarvationRefill(blockedEmpty({ outcome: 'done' }), {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: null,
      scoutInFlight: false,
      prior: null,
    });
    expect(decision.applicable).toBe(false);
    expect(decision.spawnScout).toBe(false);
    expect(decision.emitStarvationAlert).toBe(false);
  });

  test('08:07 empty spawns on-demand scout (2026-07-30 timeline replay trigger)', () => {
    // The 08:00 cron scout died silently (#1712). The 08:07 batch emptied.
    // With this trigger, the 08:07 blocked-empty would spawn an on-demand scout
    // instead of waiting for the 16:00 cron (~08:45 refill is operational,
    // outside unit scope once the scout is launched).
    const t0807 = Date.parse('2026-07-30T06:07:00.000Z'); // 08:07 CEST
    const decision = evaluatePipelineStarvationRefill(
      blockedEmpty({ generatedAt: new Date(t0807).toISOString(), runKey: '8dc20d0c' }),
      {
        nowMs: t0807,
        recentSuccessfulIdeationAtMs: null, // 08:00 scout produced nothing / died
        scoutInFlight: false,
        prior: null,
      },
    );
    expect(decision.spawnScout).toBe(true);
    expect(decision.emitStarvationAlert).toBe(false);
    expect(decision.alreadyHandled).toBe(false);
  });

  test('replaying the same runKey is a no-op (no false second-empty alert)', () => {
    const first = evaluatePipelineStarvationRefill(blockedEmpty({ runKey: 'same-run' }), {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: null,
      scoutInFlight: false,
      prior: null,
    });
    expect(first.spawnScout).toBe(true);
    expect(first.consecutiveBlockedEmpty).toBe(1);
    const after = nextPipelineStarvationState('jeanibarz/lucy', null, first, {
      nowMs: NOW,
      spawnedTaskId: 't1',
    });
    expect(after.handledRunKeys).toEqual(['same-run']);

    const replay = evaluatePipelineStarvationRefill(blockedEmpty({ runKey: 'same-run' }), {
      nowMs: NOW + 60_000,
      recentSuccessfulIdeationAtMs: null,
      scoutInFlight: false,
      prior: after,
    });
    expect(replay.alreadyHandled).toBe(true);
    expect(replay.spawnScout).toBe(false);
    expect(replay.emitStarvationAlert).toBe(false);
    expect(replay.consecutiveBlockedEmpty).toBe(1);
  });

  test('idempotency key is stable inside a 4h bucket', () => {
    const a = starvationScoutIdempotencyKey('jeanibarz/lucy', NOW);
    const b = starvationScoutIdempotencyKey('jeanibarz/lucy', NOW + 60_000);
    const c = starvationScoutIdempotencyKey('jeanibarz/lucy', NOW + STARVATION_SCOUT_DEDUP_MS);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^starvation-scout:jeanibarz-lucy:\d+$/);
  });
});

describe('parseBatchOutcomeRecord', () => {
  test('accepts a well-formed blocked-empty record', () => {
    const parsed = parseBatchOutcomeRecord(blockedEmpty());
    expect(parsed?.outcome).toBe('blocked-empty');
    expect(parsed?.repo).toBe('jeanibarz/lucy');
    expect(parsed?.disqualified).toHaveLength(3);
  });

  test('accepts optional emptyClass concurrent|product', () => {
    expect(parseBatchOutcomeRecord(blockedEmpty({ emptyClass: 'concurrent' }) )?.emptyClass).toBe('concurrent');
    expect(parseBatchOutcomeRecord(blockedEmpty({ emptyClass: 'product' }) )?.emptyClass).toBe('product');
    expect(parseBatchOutcomeRecord(blockedEmpty())?.emptyClass).toBeUndefined();
  });

  test('rejects wrong schema or missing fields', () => {
    expect(parseBatchOutcomeRecord({ schemaVersion: 2, outcome: 'blocked-empty' })).toBeNull();
    expect(parseBatchOutcomeRecord({ schemaVersion: 1, outcome: 'blocked-empty', repo: 'x' })).toBeNull();
    expect(parseBatchOutcomeRecord(null)).toBeNull();
  });
});

describe('emptyClass concurrent vs product (PR2)', () => {
  test('explicit emptyClass=concurrent does not spawn or inflate consecutive', () => {
    const firstAt = new Date(NOW - 3 * 60 * 60 * 1000).toISOString();
    const decision = evaluatePipelineStarvationRefill(
      blockedEmpty({
        runKey: 'concurrent-1',
        emptyClass: 'concurrent',
        reason: 'NO-OP: another inProgress Parallel Issue Batch already exists',
      }),
      {
        nowMs: NOW,
        recentSuccessfulIdeationAtMs: null,
        scoutInFlight: false,
        prior: prior({
          blockedEmptyAt: [firstAt],
          handledRunKeys: ['product-prior'],
        }),
      },
    );
    expect(decision.applicable).toBe(false);
    expect(decision.emptyClass).toBe('concurrent');
    expect(decision.spawnScout).toBe(false);
    expect(decision.emitStarvationAlert).toBe(false);
    // Prior product empties preserved; concurrent does not append.
    expect(decision.consecutiveBlockedEmpty).toBe(1);
    expect(decision.blockedEmptyAtAfter).toEqual([firstAt]);
    expect(decision.handledRunKeysAfter).toEqual(['product-prior']);
  });

  test('legacy concurrent reason without emptyClass is classified concurrent', () => {
    const reason =
      'NO-OP: another inProgress Parallel Issue Batch for jeanibarz/lucy already exists '
      + '(sibling 07f6550f-889c-4390-ad7e-edfc9a351552); user-note guard';
    expect(looksLikeConcurrentBatchEmpty(blockedEmpty({ reason }))).toBe(true);
    expect(resolveBatchEmptyClass(blockedEmpty({ reason }))).toBe('concurrent');

    const decision = evaluatePipelineStarvationRefill(blockedEmpty({ reason, runKey: 'legacy-c' }), {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: null,
      scoutInFlight: false,
      prior: null,
    });
    expect(decision.applicable).toBe(false);
    expect(decision.spawnScout).toBe(false);
    expect(decision.consecutiveBlockedEmpty).toBe(0);
  });

  test('product blocked-empty without emptyClass still spawns (legacy #1715)', () => {
    const decision = evaluatePipelineStarvationRefill(blockedEmpty({ runKey: 'product-legacy' }), {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: null,
      scoutInFlight: false,
      prior: null,
    });
    expect(decision.applicable).toBe(true);
    expect(decision.emptyClass).toBe('product');
    expect(decision.spawnScout).toBe(true);
    expect(decision.consecutiveBlockedEmpty).toBe(1);
  });

  test('explicit emptyClass=product still works when reason mentions batch', () => {
    // Explicit product wins over concurrent-looking prose.
    const decision = evaluatePipelineStarvationRefill(
      blockedEmpty({
        emptyClass: 'product',
        reason: 'No safe issue remains after concurrent selection rules',
      }),
      {
        nowMs: NOW,
        recentSuccessfulIdeationAtMs: null,
        scoutInFlight: false,
        prior: null,
      },
    );
    expect(decision.applicable).toBe(true);
    expect(decision.emptyClass).toBe('product');
    expect(decision.spawnScout).toBe(true);
  });
});


describe('nextPipelineStarvationState skip reason (PR1)', () => {
  test('records lastSpawnSkipReason when scout is skipped', () => {
    const decision = evaluatePipelineStarvationRefill(blockedEmpty(), {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: NOW - 60_000,
      scoutInFlight: false,
      prior: null,
    });
    expect(decision.spawnScout).toBe(false);
    const state = nextPipelineStarvationState('jeanibarz/lucy', null, decision, { nowMs: NOW });
    expect(state.lastSpawnSkipReason).toMatch(/successful ideation/i);
    expect(state.lastSpawnSkipAt).toBe(new Date(NOW).toISOString());
  });

  test('clears lastSpawnSkipReason when scout is spawned', () => {
    const decision = evaluatePipelineStarvationRefill(blockedEmpty(), {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: null,
      scoutInFlight: false,
      prior: prior({
        lastSpawnSkipReason: 'scout already running or queued for this repo',
        lastSpawnSkipAt: new Date(NOW - 1000).toISOString(),
      }),
    });
    expect(decision.spawnScout).toBe(true);
    const state = nextPipelineStarvationState(
      'jeanibarz/lucy',
      prior({ lastSpawnSkipReason: 'old', lastSpawnSkipAt: new Date(NOW - 1000).toISOString() }),
      decision,
      { nowMs: NOW, spawnedTaskId: 'scout-1' },
    );
    expect(state.lastSpawnSkipReason).toBeUndefined();
    expect(state.lastStarvationScoutTaskId).toBe('scout-1');
  });
});

describe('classifyStarvationLight + waiting_on_open_prs (PR3)', () => {
  test('all open-PR disqualifiers → waiting_on_open_prs and no spawn', () => {
    const o = blockedEmpty({
      disqualified: [
        { issue: 1, reason: 'already has open PR #10' },
        { issue: 2, reason: 'already has open PR #11' },
      ],
    });
    expect(classifyStarvationLight(o)).toBe('waiting_on_open_prs');
    const decision = evaluatePipelineStarvationRefill(o, {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: null,
      scoutInFlight: false,
      prior: null,
    });
    expect(decision.spawnScout).toBe(false);
    expect(decision.followOnAction).toBe('cannot_refill');
    expect(decision.emitStarvationAlert).toBe(false);
    expect(decision.spawnSkipReason).toMatch(/waiting_on_open_prs/);
  });

  test('umbrella-only disqualifiers → umbrella_only but still may spawn', () => {
    const o = blockedEmpty({
      disqualified: [
        { issue: 1, reason: 'umbrella/tracking/meta — not a single-PR work unit' },
        { issue: 2, reason: 'label:umbrella' },
      ],
    });
    expect(classifyStarvationLight(o)).toBe('umbrella_only');
    const decision = evaluatePipelineStarvationRefill(o, {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: null,
      scoutInFlight: false,
      prior: null,
    });
    expect(decision.spawnScout).toBe(true);
    expect(decision.followOnAction).toBe('idea_scout');
  });

  test('successful ideation skip sets followOnAction batch_kick_only', () => {
    const decision = evaluatePipelineStarvationRefill(blockedEmpty(), {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: NOW - 60_000,
      scoutInFlight: false,
      prior: null,
      // Non-empty queue: real refill — keep batch_kick_only.
      capacity: { free: 1, pendingQueueDepth: 2 },
    });
    expect(decision.spawnScout).toBe(false);
    expect(decision.followOnAction).toBe('batch_kick_only');
  });
});

describe('PR4 batch kick helpers', () => {
  test('isPipelineBatchKickEnabled defaults off', () => {
    expect(isPipelineBatchKickEnabled({})).toBe(false);
    expect(isPipelineBatchKickEnabled({ KOOKR_PIPELINE_BATCH_KICK: '0' })).toBe(false);
    expect(isPipelineBatchKickEnabled({ KOOKR_PIPELINE_BATCH_KICK: 'false' })).toBe(false);
    expect(isPipelineBatchKickEnabled({ KOOKR_PIPELINE_BATCH_KICK: '1' })).toBe(true);
    expect(isPipelineBatchKickEnabled({ KOOKR_PIPELINE_BATCH_KICK: 'true' })).toBe(true);
    expect(isPipelineBatchKickEnabled({ KOOKR_PIPELINE_BATCH_KICK: 'on' })).toBe(true);
  });

  test('isParallelIssueBatchInFlightForRepo detects non-terminal batch', () => {
    const tasks = [
      {
        status: 'inProgress',
        playbookId: 'parallel-issue-batch.md',
        playbookParameterValues: { repoFullName: 'jeanibarz/lucy' },
      },
      {
        status: 'completed',
        playbookId: 'parallel-issue-batch.md',
        playbookParameterValues: { repoFullName: 'other/repo' },
      },
    ];
    expect(isParallelIssueBatchInFlightForRepo('jeanibarz/lucy', tasks)).toBe(true);
    expect(isParallelIssueBatchInFlightForRepo('other/repo', tasks)).toBe(false);
    expect(isParallelIssueBatchInFlightForRepo('kookr-ai/kookr', tasks)).toBe(false);
  });

  test('nextState arms kickBatchWhenScoutCompletes on scout spawn', () => {
    const decision = evaluatePipelineStarvationRefill(blockedEmpty(), {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: null,
      scoutInFlight: false,
      prior: null,
    });
    const state = nextPipelineStarvationState('jeanibarz/lucy', null, decision, {
      nowMs: NOW,
      spawnedTaskId: 'scout-xyz',
    });
    expect(state.kickBatchWhenScoutCompletes).toBe(true);
    expect(state.kickBatchWhenScoutCompletesAt).toBe(new Date(NOW).toISOString());
    expect(state.lastStarvationScoutTaskId).toBe('scout-xyz');
  });

  test('nextState stamps lastBatchKickAt when batchKicked', () => {
    const decision = evaluatePipelineStarvationRefill(blockedEmpty(), {
      nowMs: NOW,
      recentSuccessfulIdeationAtMs: NOW - 60_000,
      scoutInFlight: false,
      prior: null,
    });
    expect(decision.followOnAction).toBe('batch_kick_only');
    const state = nextPipelineStarvationState('jeanibarz/lucy', null, decision, {
      nowMs: NOW,
      batchKicked: true,
    });
    expect(state.lastBatchKickAt).toBe(new Date(NOW).toISOString());
    expect(state.kickBatchWhenScoutCompletes).toBeUndefined();
  });

  test('isKickBatchPendingArmed respects TTL', () => {
    const armed = prior({
      kickBatchWhenScoutCompletes: true,
      kickBatchWhenScoutCompletesAt: new Date(NOW - 60_000).toISOString(),
    });
    expect(isKickBatchPendingArmed(armed, NOW)).toBe(true);
    const expired = prior({
      kickBatchWhenScoutCompletes: true,
      kickBatchWhenScoutCompletesAt: new Date(NOW - KICK_BATCH_PENDING_TTL_MS - 1).toISOString(),
    });
    expect(isKickBatchPendingArmed(expired, NOW)).toBe(false);
  });

  test('isBatchKickInCooldown', () => {
    expect(isBatchKickInCooldown(prior(), NOW)).toBe(false);
    expect(isBatchKickInCooldown(
      prior({ lastBatchKickAt: new Date(NOW - 60_000).toISOString() }),
      NOW,
    )).toBe(true);
    expect(isBatchKickInCooldown(
      prior({ lastBatchKickAt: new Date(NOW - BATCH_KICK_COOLDOWN_MS - 1).toISOString() }),
      NOW,
    )).toBe(false);
  });

  test('clearKickBatchPending clears flag and optionally stamps kick', () => {
    const s = prior({
      kickBatchWhenScoutCompletes: true,
      kickBatchWhenScoutCompletesAt: new Date(NOW).toISOString(),
    });
    const cleared = clearKickBatchPending(s, { nowMs: NOW + 1000 });
    expect(cleared.kickBatchWhenScoutCompletes).toBeUndefined();
    expect(cleared.kickBatchWhenScoutCompletesAt).toBeUndefined();
    const kicked = clearKickBatchPending(s, { nowMs: NOW + 1000, batchKicked: true });
    expect(kicked.lastBatchKickAt).toBe(new Date(NOW + 1000).toISOString());
  });
});
