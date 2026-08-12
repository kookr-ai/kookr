/**
 * Wire contract for lifecycle-timer health (issue #1771).
 *
 * Surfaces each periodic loop started by `startLifecycleTimers` with its last
 * fire time, expected cadence, and an overdue flag so a silently-stopped timer
 * is detectable before downstream damage (stale saves, no reconciliation).
 */

/** Stable loop names for the lifecycle-timer health surface. */
export const LIFECYCLE_TIMER_NAMES = [
  'tokenScan',
  'watchdog',
  'liveness',
  'snoozeExpiry',
  'save',
  'quotaPoll',
  'maintenancePrune',
  'serverLogRotation',
  'prodSmokeTick',
  'deployLagDetector',
  'deployConvergence',
  'relayOrphanSweep',
  'hostStaleDtachReap',
  'reflectWorktreeSweep',
] as const;

export type LifecycleTimerName = (typeof LIFECYCLE_TIMER_NAMES)[number];

export const TIMER_HEALTH_SCHEMA_VERSION = 'timer-health.v1' as const;

/**
 * How many missed expected intervals make a loop `overdue`. Two intervals is
 * long enough that a single slow tick does not flap the flag, and short enough
 * that a dead loop is visible within a couple of cadences (mirrors
 * SCHEDULER_TICK_STALE_INTERVALS for the schedule-runner).
 */
export const TIMER_HEALTH_OVERDUE_INTERVALS = 2;

export interface TimerHealthLoopEntry {
  name: LifecycleTimerName;
  /** ISO-8601 last fire; null until the loop has fired at least once. */
  lastFiredAt: string | null;
  /** Expected cadence in ms (adaptive for `quotaPoll`). */
  expectedIntervalMs: number;
  /**
   * True when progress (last fire, or registration time if never fired) is
   * older than `expectedIntervalMs * TIMER_HEALTH_OVERDUE_INTERVALS`.
   */
  overdue: boolean;
}

export interface TimerHealthSnapshot {
  schemaVersion: typeof TIMER_HEALTH_SCHEMA_VERSION;
  generatedAt: string;
  loops: TimerHealthLoopEntry[];
}
