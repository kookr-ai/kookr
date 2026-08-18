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

const LIFECYCLE_TIMER_NAME_SET: ReadonlySet<string> = new Set(LIFECYCLE_TIMER_NAMES);

export function isLifecycleTimerName(value: string): value is LifecycleTimerName {
  return LIFECYCLE_TIMER_NAME_SET.has(value);
}

export const TIMER_HEALTH_SCHEMA_VERSION = 'timer-health.v1' as const;

/** On-disk last-fired stamps so overdue math survives a crash (issue #2638). */
export const TIMER_HEALTH_PERSIST_SCHEMA_VERSION = 'timer-health-persist.v1' as const;

/** Filename under the data directory (`KOOKR_DIR` / `~/.kookr`). */
export const TIMER_HEALTH_STATE_FILE = 'timer-health.state.json';

/**
 * How many missed expected intervals make a loop `overdue`. Two intervals is
 * long enough that a single slow tick does not flap the flag, and short enough
 * that a dead loop is visible within a couple of cadences (mirrors
 * SCHEDULER_TICK_STALE_INTERVALS for the schedule-runner).
 */
export const TIMER_HEALTH_OVERDUE_INTERVALS = 2;

export interface TimerHealthLoopEntry {
  name: LifecycleTimerName;
  /**
   * ISO-8601 last fire; null until the loop has fired at least once.
   * Survives process restart when a persist file is configured (issue #2638).
   */
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

/**
 * Compact counts for `GET /api/health.timerHealth` (issue #2636).
 *
 * Last-good health persists `/api/health` only, so these four fields are what
 * a remote operator can still read after HTTP goes dark. The per-loop list
 * stays on `GET /api/diagnostics/timer-health`.
 */
export interface TimerHealthSummary {
  registered: number;
  overdue: number;
  neverFired: number;
  oldestNeverFiredName: LifecycleTimerName | null;
  /**
   * Oldest overdue loop by progress time (last fire, or register if never
   * fired). Optional extra so the already-shipped overdue pill can name a
   * loop that has fired but gone stale; not one of the four required fields.
   */
  oldestOverdueName: LifecycleTimerName | null;
}

export const EMPTY_TIMER_HEALTH_SUMMARY: TimerHealthSummary = {
  registered: 0,
  overdue: 0,
  neverFired: 0,
  oldestNeverFiredName: null,
  oldestOverdueName: null,
};
