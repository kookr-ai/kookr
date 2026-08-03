import { describe, expect, test } from 'vitest';
import {
  BATCH_OUTCOME_SCHEMA_VERSION,
  evaluatePipelineStarvationRefill,
  nextPipelineStarvationState,
  parseBatchOutcomeRecord,
  repoToPlaybookSlug,
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
  });

  test('skips spawn when starvation scout already fired inside 4h window', () => {
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

  test('rejects wrong schema or missing fields', () => {
    expect(parseBatchOutcomeRecord({ schemaVersion: 2, outcome: 'blocked-empty' })).toBeNull();
    expect(parseBatchOutcomeRecord({ schemaVersion: 1, outcome: 'blocked-empty', repo: 'x' })).toBeNull();
    expect(parseBatchOutcomeRecord(null)).toBeNull();
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
