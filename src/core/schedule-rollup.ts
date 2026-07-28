import { randomUUID } from 'node:crypto';
import { open, readFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Schedule, ScheduleExecutionOutcome } from './schedule.js';

/**
 * Materialized per-schedule ROI rollup (issue #1584, umbrella #1549).
 *
 * A durable, incrementally-maintained aggregate of a schedule's execution
 * ledger so schedule ROI is readable in O(1) at request time. The lesson that
 * spawned this (two hung endpoints — `/api/health` historically, and
 * `GET /api/diagnostics/lesson-yield`): **never scan tasks.json / hook logs on
 * request**. Every field here is derived from the schedule's own
 * `executionLedger`, which the scheduler already holds in memory and persists
 * durably — so the rollup carries no dependency on any on-request scan.
 *
 * The cost/token/artifact fields are the "joined" ROI inputs the ledger picks
 * up at ledger-write time (issue #1582): `tokenUsage` and `artifacts`. A fire
 * without a `tokenUsage` measurement contributes nothing to the sums and is not
 * counted in {@link measuredFires} — so `costUsd` is a sum over MEASURED fires,
 * never a fabricated $0 for an unmeasured one.
 */
export interface ScheduleRollup {
  scheduleId: string;
  /** Total ledger fires counted for this schedule. */
  fires: number;
  /** Fires grouped by outcome. Only non-zero outcomes appear as keys. */
  outcomes: Partial<Record<ScheduleExecutionOutcome, number>>;
  /** Fires that carried a joined `tokenUsage` measurement — the denominator for cost/token averages. */
  measuredFires: number;
  /** Summed joined cost (USD) over measured fires. */
  costUsd: number;
  /** Summed joined tokens (input + output + cache-read + cache-write) over measured fires. */
  tokens: number;
  /** Total joined artifact links produced across the ledger. */
  artifacts: number;
  /** Earliest `evaluatedAt` across the ledger (window lower boundary). */
  windowStart?: string;
  /** Latest `completedAt ?? evaluatedAt` across the ledger (window upper boundary). */
  windowEnd?: string;
  /** Wall-clock this rollup was last materialized. */
  updatedAt: string;
}

/**
 * Recount a schedule's rollup from its ledger. Pure — the single source of
 * truth for what a rollup *should* be, used both on the write path (per
 * schedule) and to reconcile a missing/stale durable store on boot.
 */
export function computeScheduleRollup(
  schedule: Pick<Schedule, 'id' | 'executionLedger'>,
  now: string,
): ScheduleRollup {
  const outcomes: Partial<Record<ScheduleExecutionOutcome, number>> = {};
  let measuredFires = 0;
  let costUsd = 0;
  let tokens = 0;
  let artifacts = 0;
  let windowStart: string | undefined;
  let windowEnd: string | undefined;

  for (const entry of schedule.executionLedger) {
    outcomes[entry.outcome] = (outcomes[entry.outcome] ?? 0) + 1;

    if (entry.tokenUsage) {
      measuredFires += 1;
      costUsd += entry.tokenUsage.costUsd;
      tokens += entry.tokenUsage.inputTokens
        + entry.tokenUsage.outputTokens
        + entry.tokenUsage.cacheReadTokens
        + entry.tokenUsage.cacheWriteTokens;
    }
    if (entry.artifacts) artifacts += entry.artifacts.length;

    // ISO-8601 UTC timestamps compare correctly lexicographically.
    if (entry.evaluatedAt && (windowStart === undefined || entry.evaluatedAt < windowStart)) {
      windowStart = entry.evaluatedAt;
    }
    const end = entry.completedAt ?? entry.evaluatedAt;
    if (end && (windowEnd === undefined || end > windowEnd)) {
      windowEnd = end;
    }
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
    updatedAt: now,
  };
}

/**
 * Value-equality of two rollups, ignoring `updatedAt` (a fresh recompute always
 * carries a newer timestamp; that alone must not read as "stale"). Used to
 * decide whether a persisted rollup can be trusted or must be reconciled.
 */
export function rollupsEqual(a: ScheduleRollup, b: ScheduleRollup): boolean {
  if (
    a.scheduleId !== b.scheduleId
    || a.fires !== b.fires
    || a.measuredFires !== b.measuredFires
    || a.costUsd !== b.costUsd
    || a.tokens !== b.tokens
    || a.artifacts !== b.artifacts
    || a.windowStart !== b.windowStart
    || a.windowEnd !== b.windowEnd
  ) {
    return false;
  }
  const aKeys = Object.keys(a.outcomes);
  const bKeys = Object.keys(b.outcomes);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a.outcomes[key as ScheduleExecutionOutcome] !== b.outcomes[key as ScheduleExecutionOutcome]) {
      return false;
    }
  }
  return true;
}

/**
 * Durable per-schedule rollup store (issue #1584).
 *
 * Materialized read model over the execution ledger:
 * - Updated incrementally at ledger-write time via {@link updateFromSchedule},
 *   which recounts exactly ONE schedule — never a full-fleet rescan.
 * - Persisted to `schedule-rollups.json` so it survives a restart without
 *   re-deriving on the request path.
 * - Reconciled against the authoritative ledger on {@link load}: a missing,
 *   deleted, corrupt, or stale durable store self-heals by recomputing from the
 *   ledger. The ledger (schedules.json) is always the source of truth; the
 *   durable rollup is only a fast-read cache of it.
 */
export class ScheduleRollupStore {
  private rollups = new Map<string, ScheduleRollup>();
  private filePath: string;
  private persistChain: Promise<void> = Promise.resolve();
  /**
   * Count of per-schedule recomputations performed via
   * {@link updateFromSchedule}. Exposed so the "bounded write-path overhead"
   * invariant is directly testable — one ledger write must recompute exactly
   * one schedule, not the whole fleet.
   */
  recomputes = 0;

  constructor(kookrDir: string) {
    this.filePath = join(kookrDir, 'schedule-rollups.json');
  }

  /**
   * Rebuild/reconcile the in-memory rollups from the durable store + ledger.
   * Returns the ids that had to be reconciled (persisted value missing or
   * disagreeing with the ledger recount) so callers can observe self-healing.
   */
  async load(schedules: Schedule[]): Promise<{ reconciled: string[] }> {
    const persisted = await this.readPersisted();
    const now = new Date().toISOString();
    const reconciled: string[] = [];
    this.rollups.clear();
    for (const schedule of schedules) {
      const fresh = computeScheduleRollup(schedule, now);
      const prior = persisted?.get(schedule.id);
      if (prior && rollupsEqual(prior, fresh)) {
        // Durable value agrees with the ledger — trust it (keeps its timestamp).
        this.rollups.set(schedule.id, prior);
      } else {
        // Missing / deleted / corrupt / stale — self-heal from the ledger.
        this.rollups.set(schedule.id, fresh);
        reconciled.push(schedule.id);
      }
    }
    return { reconciled };
  }

  /** Recompute a single schedule's rollup from its ledger (bounded write path). */
  updateFromSchedule(schedule: Pick<Schedule, 'id' | 'executionLedger'>): void {
    this.recomputes += 1;
    this.rollups.set(schedule.id, computeScheduleRollup(schedule, new Date().toISOString()));
  }

  remove(scheduleId: string): void {
    this.rollups.delete(scheduleId);
  }

  get(scheduleId: string): ScheduleRollup | undefined {
    return this.rollups.get(scheduleId);
  }

  list(): ScheduleRollup[] {
    return Array.from(this.rollups.values());
  }

  async persist(): Promise<void> {
    const write = this.persistChain.then(() => this.writeRollups());
    this.persistChain = write.catch(() => {});
    return write;
  }

  private async readPersisted(): Promise<Map<string, ScheduleRollup> | null> {
    try {
      const content = await readFile(this.filePath, 'utf-8');
      const data = JSON.parse(content);
      if (!Array.isArray(data)) return null;
      const map = new Map<string, ScheduleRollup>();
      for (const raw of data) {
        const rollup = normalizeRollup(raw);
        if (rollup) map.set(rollup.scheduleId, rollup);
      }
      return map;
    } catch {
      // ENOENT (never written / deleted) or a corrupt file both degrade to
      // "no durable state" — load() then rebuilds every rollup from the ledger.
      return null;
    }
  }

  private async writeRollups(): Promise<void> {
    const data = JSON.stringify(this.list(), null, 2);
    const tmpPath = join(dirname(this.filePath), `.schedule-rollups-${randomUUID()}.tmp`);
    await mkdir(dirname(this.filePath), { recursive: true });
    const fh = await open(tmpPath, 'w');
    try {
      await fh.writeFile(data, 'utf-8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, this.filePath);
  }
}

/** Defensive normalization of a persisted rollup row (corrupt rows dropped). */
function normalizeRollup(raw: unknown): ScheduleRollup | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<ScheduleRollup>;
  if (typeof candidate.scheduleId !== 'string' || typeof candidate.fires !== 'number') return null;
  const outcomes: Partial<Record<ScheduleExecutionOutcome, number>> = {};
  if (candidate.outcomes && typeof candidate.outcomes === 'object') {
    for (const [key, value] of Object.entries(candidate.outcomes)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        outcomes[key as ScheduleExecutionOutcome] = value;
      }
    }
  }
  return {
    scheduleId: candidate.scheduleId,
    fires: candidate.fires,
    outcomes,
    measuredFires: typeof candidate.measuredFires === 'number' ? candidate.measuredFires : 0,
    costUsd: typeof candidate.costUsd === 'number' ? candidate.costUsd : 0,
    tokens: typeof candidate.tokens === 'number' ? candidate.tokens : 0,
    artifacts: typeof candidate.artifacts === 'number' ? candidate.artifacts : 0,
    ...(typeof candidate.windowStart === 'string' ? { windowStart: candidate.windowStart } : {}),
    ...(typeof candidate.windowEnd === 'string' ? { windowEnd: candidate.windowEnd } : {}),
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date().toISOString(),
  };
}
