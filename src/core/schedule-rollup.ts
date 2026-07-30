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
 *
 * WINDOWED, not lifetime (issue #1392): every count/sum below is recomputed from
 * the schedule's CURRENT execution ledger, which is bounded to the newest
 * {@link MAX_LEDGER_ENTRIES} rows (plus any live pending row). A fire that ages
 * out of that retention window stops contributing — so on a high-cadence
 * schedule these are totals over the retained window (`windowStart`..`windowEnd`),
 * not since-creation lifetime figures. The window spans the ledger cap: effectively
 * unbounded for the hourly/daily cadences that produce delivery units, narrowing
 * only for sub-hourly schedules.
 */
export interface ScheduleRollup {
  scheduleId: string;
  /** Ledger fires counted over the retained window (see the windowing note above). */
  fires: number;
  /** Fires grouped by outcome. Only non-zero outcomes appear as keys. */
  outcomes: Partial<Record<ScheduleExecutionOutcome, number>>;
  /** Fires that carried a joined `tokenUsage` measurement — the denominator for cost/token averages. */
  measuredFires: number;
  /**
   * Merged delivery units: ledger fires that carried a joined `mergeCommit`
   * (issue #1596). A merged PR counts here the moment its merge commit is joined
   * onto the fire — regardless of whether that commit has reached prod. Counted
   * over the retained window (see the windowing note above): a merge fire that
   * ages past the ledger cap drops out of this count. In practice delivery-unit
   * schedules run at cadences whose {@link MAX_LEDGER_ENTRIES} window spans
   * weeks-plus, so merged units remain counted well beyond deploy-verification.
   */
  merged: number;
  /**
   * Live-verified delivery units (issue #1596): the subset of {@link merged}
   * whose merge commit is contained in the last prod SHA that PASSED its
   * post-deploy smoke gate. The gap `merged - liveVerified` is exactly the
   * merged-but-not-live inflation the #1653 incident surfaced (65 PRs merged,
   * prod still serving a SHA behind them → merged=65, liveVerified=0). Flips
   * mechanically via {@link ScheduleRollupStore.applyDeployVerification}; never a
   * manual bookkeeping step.
   */
  liveVerified: number;
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

/** Shared empty set for the common "no deploy verified yet" case (no per-call alloc). */
const EMPTY_LIVE_SET: ReadonlySet<string> = new Set<string>();

/**
 * Recount a schedule's rollup from its ledger. Pure — the single source of
 * truth for what a rollup *should* be, used both on the write path (per
 * schedule) and to reconcile a missing/stale durable store on boot.
 */
export function computeScheduleRollup(
  schedule: Pick<Schedule, 'id' | 'executionLedger'>,
  now: string,
  /**
   * Merge commits confirmed live — contained in the last smoke-gate-passed prod
   * SHA. A merged unit flips to live-verified only when its `mergeCommit` is in
   * this set. Absent/empty ⇒ nothing is live-verified yet (the #1653 default:
   * merged units accumulate while `liveVerified` stays 0 until a deploy lands).
   */
  liveVerifiedCommits: ReadonlySet<string> = EMPTY_LIVE_SET,
): ScheduleRollup {
  const outcomes: Partial<Record<ScheduleExecutionOutcome, number>> = {};
  let measuredFires = 0;
  let costUsd = 0;
  let tokens = 0;
  let artifacts = 0;
  let merged = 0;
  let liveVerified = 0;
  let windowStart: string | undefined;
  let windowEnd: string | undefined;

  for (const entry of schedule.executionLedger) {
    outcomes[entry.outcome] = (outcomes[entry.outcome] ?? 0) + 1;

    if (entry.mergeCommit) {
      merged += 1;
      if (liveVerifiedCommits.has(entry.mergeCommit)) liveVerified += 1;
    }

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
    merged,
    liveVerified,
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
    || a.merged !== b.merged
    || a.liveVerified !== b.liveVerified
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
   * Merge commits confirmed live on the last smoke-gate-passed prod SHA (issue
   * #1596). Held as durable store state — NOT re-derived on the request path —
   * so `liveVerified` counts are readable in O(1) and survive a restart. Flips
   * only via {@link applyDeployVerification} (a deploy whose smoke gate passed);
   * a failed smoke gate never calls it, so a failed deploy attempt leaves this
   * set — and therefore every rollup's `liveVerified` — exactly as it was.
   */
  private liveVerifiedCommits = new Set<string>();
  /** The prod SHA whose smoke-gate pass produced {@link liveVerifiedCommits}, for observability. */
  private lastVerifiedSha?: string;
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
    // Restore the live-verification state BEFORE recomputing, so a reload
    // reconciles each rollup against the same live set that produced its
    // persisted `liveVerified` — the flip survives a restart with no re-deploy.
    this.liveVerifiedCommits = new Set(persisted?.liveVerifiedCommits ?? []);
    this.lastVerifiedSha = persisted?.lastVerifiedSha;
    this.rollups.clear();
    for (const schedule of schedules) {
      const fresh = computeScheduleRollup(schedule, now, this.liveVerifiedCommits);
      const prior = persisted?.rollups.get(schedule.id);
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
    this.rollups.set(
      schedule.id,
      computeScheduleRollup(schedule, new Date().toISOString(), this.liveVerifiedCommits),
    );
  }

  /**
   * Record a passed post-deploy smoke gate (issue #1596): the deployed prod SHA
   * plus the set of merge commits it contains, which the caller resolves off the
   * request path (git ancestry against the deployed SHA). This is the ONLY way
   * `liveVerified` moves — the smoke-gate pass drives it mechanically, with no
   * manual bookkeeping step. A FAILED smoke gate simply never calls this, so the
   * live set and every rollup stay unchanged from before the deploy attempt.
   *
   * Fleet-wide recompute, but a rare event (a deploy, not a ledger write), so it
   * does not violate the bounded-write-path invariant that governs the hot path.
   *
   * Verified commits are UNIONED into the live set, never replaced: "verified
   * live" is monotonic because merge history is append-only, so a commit already
   * contained in a passed prod SHA stays contained forever. Union is also what
   * keeps multiple prods independent — a converged `kookr` deploy (whose SHA
   * naturally does not contain `lucy`'s commits) must not un-verify `lucy`'s
   * units. (A prod rollback that un-deploys an already-verified commit is the one
   * case this over-counts; the issue's "the smoke gate HAS passed at a SHA
   * including the commit" is past-tense, so a once-verified unit staying counted
   * is the intended reading.)
   */
  applyDeployVerification(
    schedules: Schedule[],
    deployedSha: string,
    verifiedCommits: Iterable<string>,
  ): void {
    for (const commit of verifiedCommits) this.liveVerifiedCommits.add(commit);
    this.lastVerifiedSha = deployedSha;
    const now = new Date().toISOString();
    for (const schedule of schedules) {
      this.rollups.set(schedule.id, computeScheduleRollup(schedule, now, this.liveVerifiedCommits));
    }
  }

  /** The prod SHA whose smoke-gate pass produced the current live-verified set (issue #1596). */
  get verifiedSha(): string | undefined {
    return this.lastVerifiedSha;
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

  private async readPersisted(): Promise<PersistedRollups | null> {
    try {
      const content = await readFile(this.filePath, 'utf-8');
      const data = JSON.parse(content);
      // Backward compat: legacy files (pre-#1596) persisted a bare rollup array;
      // the current format wraps them alongside the live-verification state. A
      // legacy file loads with an empty live set — its `liveVerified` counts then
      // reconcile from the ledger (all 0 until the next verified deploy).
      const rawRollups = Array.isArray(data)
        ? data
        : (data && typeof data === 'object' && Array.isArray((data as { rollups?: unknown }).rollups)
          ? (data as { rollups: unknown[] }).rollups
          : null);
      if (!rawRollups) return null;
      const map = new Map<string, ScheduleRollup>();
      for (const raw of rawRollups) {
        const rollup = normalizeRollup(raw);
        if (rollup) map.set(rollup.scheduleId, rollup);
      }
      const meta = Array.isArray(data) ? undefined : (data as Partial<PersistedRollupsFile>);
      const liveVerifiedCommits = Array.isArray(meta?.liveVerifiedCommits)
        ? meta!.liveVerifiedCommits.filter((c): c is string => typeof c === 'string' && c.length > 0)
        : [];
      return {
        rollups: map,
        liveVerifiedCommits,
        ...(typeof meta?.lastVerifiedSha === 'string' ? { lastVerifiedSha: meta.lastVerifiedSha } : {}),
      };
    } catch {
      // ENOENT (never written / deleted) or a corrupt file both degrade to
      // "no durable state" — load() then rebuilds every rollup from the ledger.
      return null;
    }
  }

  private async writeRollups(): Promise<void> {
    const payload: PersistedRollupsFile = {
      rollups: this.list(),
      liveVerifiedCommits: Array.from(this.liveVerifiedCommits),
      ...(this.lastVerifiedSha ? { lastVerifiedSha: this.lastVerifiedSha } : {}),
    };
    const data = JSON.stringify(payload, null, 2);
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

/** On-disk shape of `schedule-rollups.json` (issue #1596 added the live-verification state). */
interface PersistedRollupsFile {
  rollups: ScheduleRollup[];
  /** Merge commits contained in the last smoke-gate-passed prod SHA. */
  liveVerifiedCommits: string[];
  /** That prod SHA, for observability. */
  lastVerifiedSha?: string;
}

/** Parsed durable state returned by {@link ScheduleRollupStore.readPersisted}. */
interface PersistedRollups {
  rollups: Map<string, ScheduleRollup>;
  liveVerifiedCommits: string[];
  lastVerifiedSha?: string;
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
    merged: typeof candidate.merged === 'number' ? candidate.merged : 0,
    liveVerified: typeof candidate.liveVerified === 'number' ? candidate.liveVerified : 0,
    costUsd: typeof candidate.costUsd === 'number' ? candidate.costUsd : 0,
    tokens: typeof candidate.tokens === 'number' ? candidate.tokens : 0,
    artifacts: typeof candidate.artifacts === 'number' ? candidate.artifacts : 0,
    ...(typeof candidate.windowStart === 'string' ? { windowStart: candidate.windowStart } : {}),
    ...(typeof candidate.windowEnd === 'string' ? { windowEnd: candidate.windowEnd } : {}),
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date().toISOString(),
  };
}
