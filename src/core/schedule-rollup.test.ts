import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScheduleStore, type Schedule, type ScheduleExecutionLedgerEntry, type ScheduleExecutionOutcome } from './schedule.js';
import { computeScheduleRollup, rollupsEqual, type ScheduleRollup } from './schedule-rollup.js';

// ---------------------------------------------------------------------------
// Invariant gate (issue #1584 / #1539). The materialized rollup touches durable
// state; this suite ships one property/contention test per enumerated invariant:
//
//   I1  Rollup ≡ ledger recount     — for ANY sequence of ledger writes, the
//                                      materialized rollup equals a fresh recount.
//   I2  Boot reconciliation         — a missing/deleted/corrupt/stale durable
//                                      store self-heals from the ledger on load.
//   I3  Bounded write path          — one ledger write recomputes exactly ONE
//                                      schedule, never a full-fleet rescan.
//   I4  Restart durability          — after persist→reload the rollup survives.
// ---------------------------------------------------------------------------

let seed = 0x1234_5678;
/** Deterministic PRNG so the "property" test is reproducible across CI runs. */
function rand(): number {
  seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff;
  return seed / 0x7fff_ffff;
}
function pick<T>(items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

const OUTCOMES: ScheduleExecutionOutcome[] = [
  'running', 'completed', 'cancelled', 'dispatch_failed',
  'skipped_active', 'skipped_stale', 'queued_capacity', 'deduplicated',
];

/** Independent recount of a schedule's ledger — the oracle the rollup must match. */
function recount(schedule: Pick<Schedule, 'id' | 'executionLedger'>): Omit<ScheduleRollup, 'updatedAt'> {
  const outcomes: Partial<Record<ScheduleExecutionOutcome, number>> = {};
  let measuredFires = 0;
  let costUsd = 0;
  let tokens = 0;
  let artifacts = 0;
  let windowStart: string | undefined;
  let windowEnd: string | undefined;
  for (const e of schedule.executionLedger) {
    outcomes[e.outcome] = (outcomes[e.outcome] ?? 0) + 1;
    if (e.tokenUsage) {
      measuredFires += 1;
      costUsd += e.tokenUsage.costUsd;
      tokens += e.tokenUsage.inputTokens + e.tokenUsage.outputTokens + e.tokenUsage.cacheReadTokens + e.tokenUsage.cacheWriteTokens;
    }
    if (e.artifacts) artifacts += e.artifacts.length;
    if (windowStart === undefined || e.evaluatedAt < windowStart) windowStart = e.evaluatedAt;
    const end = e.completedAt ?? e.evaluatedAt;
    if (windowEnd === undefined || end > windowEnd) windowEnd = end;
  }
  return {
    scheduleId: schedule.id,
    fires: schedule.executionLedger.length,
    outcomes,
    measuredFires,
    costUsd,
    tokens,
    artifacts,
    ...(windowStart ? { windowStart } : {}),
    ...(windowEnd ? { windowEnd } : {}),
  };
}

function stripTimestamp(rollup: ScheduleRollup): Omit<ScheduleRollup, 'updatedAt'> {
  const { updatedAt, ...rest } = rollup;
  return rest;
}

function makeEntry(scheduleId: string, index: number, measured: boolean, artifactCount: number): ScheduleExecutionLedgerEntry {
  const minute = String(index % 60).padStart(2, '0');
  const evaluatedAt = `2026-02-0${(index % 9) + 1}T10:${minute}:00.000Z`;
  return {
    id: `${scheduleId}:cron:${evaluatedAt}`,
    scheduleId,
    trigger: 'cron',
    decision: 'cron_due',
    evaluatedAt,
    completedAt: evaluatedAt,
    outcome: pick(OUTCOMES),
    ...(measured ? {
      tokenUsage: {
        inputTokens: 100 + index,
        outputTokens: 50 + index,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        costUsd: 0.01 * (index + 1),
      },
    } : {}),
    ...(artifactCount > 0 ? { artifacts: Array.from({ length: artifactCount }, (_, i) => `https://pr/${index}-${i}`) } : {}),
  };
}

describe('computeScheduleRollup (pure recount)', () => {
  test('empty ledger yields zeroed rollup with no window', () => {
    const rollup = computeScheduleRollup({ id: 's1', executionLedger: [] }, '2026-02-01T00:00:00.000Z');
    expect(rollup).toEqual({
      scheduleId: 's1',
      fires: 0,
      outcomes: {},
      measuredFires: 0,
      costUsd: 0,
      tokens: 0,
      artifacts: 0,
      updatedAt: '2026-02-01T00:00:00.000Z',
    });
  });

  test('sums measured cost/tokens/artifacts and window boundaries; unmeasured fires excluded from cost', () => {
    const ledger: ScheduleExecutionLedgerEntry[] = [
      {
        id: 's1:cron:a', scheduleId: 's1', trigger: 'cron', decision: 'cron_due',
        evaluatedAt: '2026-02-01T09:00:00.000Z', completedAt: '2026-02-01T09:05:00.000Z',
        outcome: 'completed',
        tokenUsage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 0, costUsd: 0.25 },
        artifacts: ['https://github.com/o/r/pull/1'],
      },
      {
        id: 's1:cron:b', scheduleId: 's1', trigger: 'cron', decision: 'cron_due',
        evaluatedAt: '2026-02-01T10:00:00.000Z', completedAt: '2026-02-01T10:02:00.000Z',
        outcome: 'completed',
        tokenUsage: { inputTokens: 200, outputTokens: 60, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.50 },
      },
      {
        // Unmeasured (dispatch_failed) — must NOT add a fabricated $0 to measuredFires.
        id: 's1:cron:c', scheduleId: 's1', trigger: 'cron', decision: 'cron_due',
        evaluatedAt: '2026-02-01T08:00:00.000Z', completedAt: '2026-02-01T08:00:00.000Z',
        outcome: 'dispatch_failed',
      },
    ];
    const rollup = computeScheduleRollup({ id: 's1', executionLedger: ledger }, '2026-02-02T00:00:00.000Z');
    expect(rollup.fires).toBe(3);
    expect(rollup.outcomes).toEqual({ completed: 2, dispatch_failed: 1 });
    expect(rollup.measuredFires).toBe(2);
    expect(rollup.costUsd).toBeCloseTo(0.75, 10);
    expect(rollup.tokens).toBe(100 + 40 + 10 + 0 + 200 + 60);
    expect(rollup.artifacts).toBe(1);
    expect(rollup.windowStart).toBe('2026-02-01T08:00:00.000Z');
    expect(rollup.windowEnd).toBe('2026-02-01T10:02:00.000Z');
  });
});

describe('ScheduleStore rollup invariants', () => {
  let tempDir: string;
  let store: ScheduleStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sched-rollup-test-'));
    store = new ScheduleStore(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedSchedule(id = 'sched-a'): Schedule {
    const now = '2026-02-01T00:00:00.000Z';
    const schedule: Schedule = {
      id,
      name: id,
      enabled: true,
      cron: '0 9 * * *',
      playbook: { path: 'daily.md', parameters: {} },
      cwd: tempDir,
      agentType: 'claude',
      executionLedger: [],
      createdAt: now,
      updatedAt: now,
    };
    store.replace(schedule);
    return store.get(id)!;
  }

  // I1 — property test: random ledger-write sequences keep rollup ≡ recount.
  test('I1: materialized rollup equals a fresh ledger recount after any write sequence', () => {
    const schedule = seedSchedule();
    const ledger: ScheduleExecutionLedgerEntry[] = [];
    for (let step = 0; step < 200; step++) {
      if (ledger.length > 0 && rand() < 0.3) {
        // Mutate an existing entry's outcome (running -> completed upsert path).
        const idx = Math.floor(rand() * ledger.length);
        ledger[idx] = { ...ledger[idx]!, outcome: pick(OUTCOMES) };
      } else {
        ledger.push(makeEntry(schedule.id, ledger.length, rand() < 0.7, Math.floor(rand() * 3)));
      }
      store.replace({ ...schedule, executionLedger: [...ledger] });

      const rollup = store.getRollup(schedule.id);
      expect(rollup).toBeDefined();
      expect(stripTimestamp(rollup!)).toEqual(recount({ id: schedule.id, executionLedger: ledger }));
    }
  });

  // I3 — contention/bounded test: one write recomputes exactly one schedule.
  test('I3: a single ledger write recomputes only the mutated schedule, not the fleet', () => {
    const schedules = Array.from({ length: 25 }, (_, i) => seedSchedule(`sched-${i}`));
    // An interleaved burst of writes across many schedules: each store.replace
    // must re-materialize ONLY its own rollup. A full-fleet rescan would
    // rebuild every rollup object; a bounded write leaves the others' rollup
    // objects untouched (same reference).
    for (const s of schedules) {
      const before = new Map(store.listRollups().map((r) => [r.scheduleId, r]));
      store.replace({ ...s, executionLedger: [makeEntry(s.id, 0, true, 1)] });
      const after = new Map(store.listRollups().map((r) => [r.scheduleId, r]));

      for (const [id, priorRollup] of before) {
        if (id === s.id) continue;
        // Untouched schedules keep the exact same rollup object — not recomputed.
        expect(after.get(id)).toBe(priorRollup);
      }
      // The mutated schedule advanced to one fire.
      expect(after.get(s.id)!.fires).toBe(1);
    }
  });

  // I2 + I4 — durability + boot reconciliation.
  test('I4: rollup survives persist -> reload from the durable store', async () => {
    const schedule = seedSchedule();
    store.replace({ ...schedule, executionLedger: [makeEntry(schedule.id, 0, true, 2), makeEntry(schedule.id, 1, false, 0)] });
    await store.persist();
    expect(existsSync(join(tempDir, 'schedule-rollups.json'))).toBe(true);
    const expected = stripTimestamp(store.getRollup(schedule.id)!);

    const reloaded = new ScheduleStore(tempDir);
    await reloaded.load();
    expect(stripTimestamp(reloaded.getRollup(schedule.id)!)).toEqual(expected);
  });

  test('I2: reconciles from the ledger when the durable store is deleted', async () => {
    const schedule = seedSchedule();
    store.replace({ ...schedule, executionLedger: [makeEntry(schedule.id, 0, true, 1)] });
    await store.persist();
    const expected = stripTimestamp(store.getRollup(schedule.id)!);

    // Delete the durable rollup store — schedules.json (the ledger) remains.
    unlinkSync(join(tempDir, 'schedule-rollups.json'));

    const reloaded = new ScheduleStore(tempDir);
    await reloaded.load();
    expect(stripTimestamp(reloaded.getRollup(schedule.id)!)).toEqual(expected);
    expect(reloaded.getRollup(schedule.id)!.fires).toBe(1);
  });

  test('I2: reconciles from the ledger when the durable store is corrupt/stale', async () => {
    const schedule = seedSchedule();
    store.replace({ ...schedule, executionLedger: [makeEntry(schedule.id, 0, true, 1), makeEntry(schedule.id, 1, true, 0)] });
    await store.persist();
    const expected = stripTimestamp(store.getRollup(schedule.id)!);

    // Tamper: a stale rollup claiming the wrong fire count. Boot must not trust it.
    writeFileSync(
      join(tempDir, 'schedule-rollups.json'),
      JSON.stringify([{ scheduleId: schedule.id, fires: 999, outcomes: { completed: 999 }, measuredFires: 999, costUsd: 12345, tokens: 1, artifacts: 1, updatedAt: '2020-01-01T00:00:00.000Z' }]),
    );

    const reloaded = new ScheduleStore(tempDir);
    await reloaded.load();
    expect(stripTimestamp(reloaded.getRollup(schedule.id)!)).toEqual(expected);
    expect(reloaded.getRollup(schedule.id)!.fires).toBe(2);
  });

  test('deleting a schedule removes its rollup', () => {
    const schedule = seedSchedule();
    expect(store.getRollup(schedule.id)).toBeDefined();
    store.delete(schedule.id);
    expect(store.getRollup(schedule.id)).toBeUndefined();
  });
});

describe('rollupsEqual', () => {
  const base: ScheduleRollup = {
    scheduleId: 's', fires: 2, outcomes: { completed: 2 }, measuredFires: 1,
    costUsd: 0.5, tokens: 10, artifacts: 1, windowStart: 'a', windowEnd: 'b', updatedAt: 'x',
  };
  test('ignores updatedAt', () => {
    expect(rollupsEqual(base, { ...base, updatedAt: 'y' })).toBe(true);
  });
  test('detects an outcome-count divergence', () => {
    expect(rollupsEqual(base, { ...base, outcomes: { completed: 1, cancelled: 1 } })).toBe(false);
  });
  test('detects a cost divergence', () => {
    expect(rollupsEqual(base, { ...base, costUsd: 0.6 })).toBe(false);
  });
});
