import type { TerminalReasonCategory } from '../shared/contracts/task.js';
import type { Schedule, ScheduleExecutionLedgerEntry } from './schedule.js';

/**
 * Bounded diagnostic rollup of schedule terminal reasons (issue #2877). Pure
 * over the in-memory schedule execution ledgers (each already capped at
 * {@link MAX_LEDGER_ENTRIES}), so it never serializes full task event
 * histories. Lets the daily reflection identify a provider-wide timeout storm
 * directly — counts and occupied slot-time grouped by terminal reason and by
 * resolved provider over a trailing window — instead of joining `/api/schedules`
 * to `/api/tasks` per fire.
 *
 * The rollup counts only NON-SUCCESS terminal fires: a fire whose classified
 * reason is a clean completion (`completed_normal` / `completed_recovery`) is
 * excluded, so a healthy high-cadence schedule's completions do not swamp the
 * failure signal this rollup exists to surface. This matches the issue's own
 * framing — it counts the *terminated* fires (timeouts, provider failures,
 * restart-recovery unknowns), not the successful ones. Every fire still carries
 * its `terminalReason` on the ledger row for point provenance; the filtering is
 * only in this aggregate view.
 */

/**
 * Classified reasons that mark a clean completion, excluded from the rollup so
 * it stays a failure/degradation view. Kept as a set so a future completion
 * reason added to {@link TerminalReasonCategory} can be excluded here too.
 */
const SUCCESS_TERMINAL_REASONS: ReadonlySet<TerminalReasonCategory> = new Set([
  'completed_normal',
  'completed_recovery',
]);

/** One reason/provider bucket: how many classified fires and their occupied slot-time. */
export interface ScheduleTerminalReasonBucket {
  count: number;
  /**
   * Sum of occupied slot-time (ms) across this bucket's fires, counting only
   * fires whose ledger row carried both an `evaluatedAt` and a `completedAt` so
   * the duration is real, never fabricated. A fire missing either timestamp
   * still counts toward `count` but contributes 0 here.
   */
  occupiedMs: number;
}

export interface ScheduleTerminalReasonAggregate {
  windowMs: number;
  generatedAt: string;
  /** Non-success classified terminal fires whose transition falls inside the window. */
  total: number;
  /** Total occupied slot-time (ms) across all counted fires with measurable duration. */
  occupiedMs: number;
  /** Buckets keyed by {@link ScheduleTerminalReason.reasonCode}. */
  byReason: Record<string, ScheduleTerminalReasonBucket>;
  /**
   * Buckets keyed by resolved provider/agent type. Only fires whose
   * classification carried a `provider` (provider failures) appear here, so the
   * grouping stays meaningful rather than dominated by an `unattributed` bucket.
   */
  byProvider: Record<string, ScheduleTerminalReasonBucket>;
}

/** Occupied slot-time for a fire from its ledger timestamps, or 0 when not measurable. */
function occupiedMsForEntry(entry: ScheduleExecutionLedgerEntry): number {
  if (!entry.completedAt) return 0;
  const start = Date.parse(entry.evaluatedAt);
  const end = Date.parse(entry.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  const duration = end - start;
  return duration > 0 ? duration : 0;
}

function addToBucket(
  buckets: Record<string, ScheduleTerminalReasonBucket>,
  key: string,
  occupiedMs: number,
): void {
  const bucket = buckets[key] ?? { count: 0, occupiedMs: 0 };
  bucket.count += 1;
  bucket.occupiedMs += occupiedMs;
  buckets[key] = bucket;
}

/**
 * Aggregate classified schedule terminal fires over a bounded trailing window.
 * Reads each entry's {@link ScheduleTerminalReason} (stamped at the
 * task→schedule terminal transition) and buckets by reason and provider. A fire
 * with no classification, or whose transition timestamp falls outside the
 * window, is skipped — nothing is fabricated.
 */
export function aggregateScheduleTerminalReasons(
  schedules: readonly Schedule[],
  opts: { nowMs: number; windowMs: number },
): ScheduleTerminalReasonAggregate {
  const cutoff = opts.nowMs - opts.windowMs;
  const byReason: Record<string, ScheduleTerminalReasonBucket> = {};
  const byProvider: Record<string, ScheduleTerminalReasonBucket> = {};
  let total = 0;
  let occupiedMs = 0;

  for (const schedule of schedules) {
    for (const entry of schedule.executionLedger) {
      const classification = entry.terminalReason;
      if (!classification) continue;
      // Failure/degradation view only — clean completions are excluded so they
      // do not swamp the timeout/provider-failure signal (issue #2877).
      if (SUCCESS_TERMINAL_REASONS.has(classification.reasonCode)) continue;
      const atMs = Date.parse(classification.at);
      if (!Number.isFinite(atMs) || atMs < cutoff) continue;

      const entryOccupied = occupiedMsForEntry(entry);
      total += 1;
      occupiedMs += entryOccupied;
      addToBucket(byReason, classification.reasonCode, entryOccupied);
      if (classification.provider) {
        addToBucket(byProvider, classification.provider, entryOccupied);
      }
    }
  }

  return {
    windowMs: opts.windowMs,
    generatedAt: new Date(opts.nowMs).toISOString(),
    total,
    occupiedMs,
    byReason,
    byProvider,
  };
}
