/**
 * Shared ScheduleStatusSnapshot fixture for fail-closed pause visibility tests
 * (issue #2431).
 *
 * Doctor, `kookr status`, `/api/ready`, and Discord follow-ups all need a
 * paused-schedule list of a requested length. Without one helper, each test
 * invents a slightly different mock and the surfaces drift. This module is
 * the single builder those tests should import.
 *
 * Production omits `schedulesPausedByFailure` when nothing is fail-closed
 * paused; some consumers also accept an empty array as "none paused." Callers
 * can ask for either shape. This file is test-only — it does not resume
 * pauses, drop open-PR fail-safes, or change `/api/ready`.
 */
import type { ScheduleStatusSnapshot } from '../shared/contracts/schedule.js';

/** One row of `ScheduleStatusSnapshot.schedulesPausedByFailure`. */
export type PausedByFailureRow = NonNullable<
  ScheduleStatusSnapshot['schedulesPausedByFailure']
>[number];

export interface MakePausedByFailureSnapshotOptions {
  /**
   * How many paused rows to emit. `undefined` omits the field (production
   * "none paused" shape) unless `names` is provided. `0` emits `[]`.
   */
  count?: number;
  /**
   * Display names, applied in order. Extra names are ignored. Missing names
   * default to `paused-schedule-N` (1-based). When `count` is omitted, the
   * array length becomes the row count.
   */
  names?: string[];
}

/** Default consecutive-failure count on generated rows (the #2353 pause floor). */
export const DEFAULT_PAUSED_CONSECUTIVE_FAILURES = 3;

function resolveRowCount(
  count: number | undefined,
  names: string[] | undefined,
): number | undefined {
  if (count !== undefined) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(
        `makePausedByFailureSnapshot: count must be a non-negative integer, got ${String(count)}`,
      );
    }
    return count;
  }
  if (names !== undefined) return names.length;
  return undefined;
}

function makePausedByFailureRows(count: number, names: string[] | undefined): PausedByFailureRow[] {
  const rows: PausedByFailureRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const n = i + 1;
    rows.push({
      id: `sched-${n}`,
      name: names?.[i] ?? `paused-schedule-${n}`,
      consecutiveFailures: DEFAULT_PAUSED_CONSECUTIVE_FAILURES,
    });
  }
  return rows;
}

function healthySnapshotBase(): Omit<ScheduleStatusSnapshot, 'schedulesPausedByFailure'> {
  return {
    timezone: 'UTC',
    catchUpMode: 'manual',
    catchUpEnabled: false,
    schedulerHealthy: true,
  };
}

/**
 * Build a healthy `ScheduleStatusSnapshot` whose paused-by-failure list has
 * the requested length (or is omitted).
 */
export function makePausedByFailureSnapshot(
  options: MakePausedByFailureSnapshotOptions = {},
): ScheduleStatusSnapshot {
  const rowCount = resolveRowCount(options.count, options.names);
  const base = healthySnapshotBase();
  if (rowCount === undefined) return base;
  return {
    ...base,
    schedulesPausedByFailure: makePausedByFailureRows(rowCount, options.names),
  };
}
