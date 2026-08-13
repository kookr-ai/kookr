/**
 * Schedule re-arm decisions (issues #2196 / #2459).
 *
 * Two independent policies live here — both pure, no I/O:
 *
 *  1. {@link decideCriticalScheduleRearm} (#2196): after outages, re-enable
 *     allowlisted residual-sensing schedules that stayed disabled from ops
 *     drift. An explicit {@link operatorHold} keeps those parked.
 *
 *  2. {@link decideTransientFailureRearm} (#2459): lift a leftover
 *     `consecutive_failures` hold whose last reason was a transient
 *     `launch_error` / overlap-skip, and whose last fire predates the
 *     daemon becoming ready. Genuine timeout/failed streaks stay paused
 *     (#2353). This path exists because #2353 sets `operatorHold`, so
 *     policy 1 cannot unstick a recovered launch wedge.
 */

/** Playbook basenames that must not stay disabled without an operator hold. */
export const CRITICAL_SCHEDULE_PLAYBOOK_BASENAMES: readonly string[] = [
  // L3 residual fuse (orchestration effectiveness).
  'lucy-orchestration-effectiveness.md',
  'lucy-orchestration-effectiveness',
  // Product-surface residual / journey sensing.
  'lucy-product-surface-journey.md',
  'lucy-product-surface-journey',
  // Merge→prod auto-advance (issue #1883 / #2226). Agent schedule is a
  // belt-and-suspenders path beside the in-process controller; if it exists
  // it must not sit disabled without an explicit operator hold.
  'kookr-deploy-convergence.md',
  'kookr-deploy-convergence',
];

/**
 * Name substrings as a fallback when a playbook is renamed but the schedule
 * title still identifies the critical role. Matched case-insensitively.
 */
export const CRITICAL_SCHEDULE_NAME_PATTERNS: readonly RegExp[] = [
  /orchestration\s+effectiveness/i,
  /product\s+surface\s+journey/i,
  /kookr\s+deploy\s+convergence/i,
];

export type CriticalRearmSkipReason =
  | 'not_allowlisted'
  | 'already_enabled'
  | 'operator_hold'
  | 'trigger_limit_exhausted';

export type CriticalRearmDecision =
  | { rearm: true }
  | { rearm: false; reason: CriticalRearmSkipReason };

export interface CriticalRearmScheduleView {
  id: string;
  name: string;
  enabled: boolean;
  /**
   * Explicit operator hold (issue #2196). When true, recovery re-arm must not
   * re-enable the schedule. Cleared when the operator re-enables manually.
   */
  operatorHold?: boolean;
  /** Auto-exhaustion stop reason — not ops drift; leave alone. */
  stopReason?: string;
  playbook: { path: string };
}

/** Basename of a playbook path (`a/b/foo.md` → `foo.md`). */
export function playbookBasename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return (parts[parts.length - 1] ?? normalized).trim();
}

/**
 * True when the schedule is on the critical re-arm allowlist (playbook basename
 * or well-known name pattern). Experimental scouts / parked batches are out.
 */
export function isCriticalAllowlistedSchedule(
  schedule: Pick<CriticalRearmScheduleView, 'name' | 'playbook'>,
): boolean {
  const base = playbookBasename(schedule.playbook.path).toLowerCase();
  if (CRITICAL_SCHEDULE_PLAYBOOK_BASENAMES.some((b) => b.toLowerCase() === base)) {
    return true;
  }
  const name = schedule.name ?? '';
  return CRITICAL_SCHEDULE_NAME_PATTERNS.some((re) => re.test(name));
}

/**
 * Decide whether recovery should re-enable this schedule.
 *
 * Order (first match wins):
 *  1. not on allowlist
 *  2. already enabled
 *  3. operator hold marker set
 *  4. trigger-limit auto-exhausted (different recovery path)
 *  5. otherwise → rearm
 */
export function decideCriticalScheduleRearm(
  schedule: CriticalRearmScheduleView,
): CriticalRearmDecision {
  if (!isCriticalAllowlistedSchedule(schedule)) {
    return { rearm: false, reason: 'not_allowlisted' };
  }
  if (schedule.enabled) {
    return { rearm: false, reason: 'already_enabled' };
  }
  if (schedule.operatorHold === true) {
    return { rearm: false, reason: 'operator_hold' };
  }
  if (schedule.stopReason === 'trigger_limit_reached') {
    return { rearm: false, reason: 'trigger_limit_exhausted' };
  }
  return { rearm: true };
}

/**
 * Filter a fleet of schedules to those that should be re-enabled this recovery
 * pass. Deterministic order by id for stable audit logs.
 */
export function listCriticalSchedulesToRearm(
  schedules: readonly CriticalRearmScheduleView[],
): CriticalRearmScheduleView[] {
  return schedules
    .filter((s) => decideCriticalScheduleRearm(s).rearm)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Reason codes whose consecutive-failure pause is leftover accounting from a
 * transient launch wedge or overlap-skip (issues #2458 / #2459). These may be
 * lifted automatically once the daemon is healthy. Genuine `failed` / timeout
 * streaks (Requirements-Redundancy class, issue #2353) are not in this set.
 */
export const TRANSIENT_FAILURE_REARM_REASON_CODES = [
  'launch_error',
  'previous_run_active',
  'previous_run_pending',
] as const;

export type TransientFailureRearmReasonCode =
  (typeof TRANSIENT_FAILURE_REARM_REASON_CODES)[number];

export type TransientFailureRearmSkipReason =
  | 'health_not_ok'
  | 'already_enabled'
  | 'not_failure_pause'
  | 'not_transient_reason'
  | 'failure_after_ready';

export type TransientFailureRearmDecision =
  | { rearm: true }
  | { rearm: false; reason: TransientFailureRearmSkipReason };

export interface TransientFailureRearmView {
  id: string;
  name: string;
  enabled: boolean;
  /** Auto-pause marker from issue #2353. Other stop reasons are left alone. */
  stopReason?: string;
  latestReasonCode?: string;
  /** When the last fire was recorded. Compared to {@link readyAt}. */
  lastEvaluatedAt?: string;
}

export function isTransientFailureRearmReason(
  reasonCode: string | undefined,
): reasonCode is TransientFailureRearmReasonCode {
  return (TRANSIENT_FAILURE_REARM_REASON_CODES as readonly string[]).includes(
    reasonCode ?? '',
  );
}

/**
 * Decide whether a leftover consecutive-failures hold should be lifted after
 * the daemon recovered (issue #2459).
 *
 * Order (first match wins):
 *  1. health/ready is not ok
 *  2. already enabled
 *  3. pause is not `consecutive_failures` (manual park, trigger-limit, …)
 *  4. last reason is not a transient launch_error / overlap-skip
 *  5. last fire happened at or after the daemon became ready (a live #2353
 *     streak, not leftover accounting from before recovery)
 *  6. otherwise → rearm
 *
 * `operatorHold` is not consulted: #2353 sets it on every auto-pause, and
 * this path exists specifically to lift that leftover hold. A distinct
 * operator park has a different stopReason (or none) and fails step 3.
 *
 * `readyAt` is required for a lift. Without a watermark we cannot tell a
 * leftover hold from a pause that just fired while the process was already
 * healthy, so we fail closed.
 */
export function decideTransientFailureRearm(
  schedule: TransientFailureRearmView,
  healthOk: boolean,
  readyAt?: string,
): TransientFailureRearmDecision {
  if (!healthOk) {
    return { rearm: false, reason: 'health_not_ok' };
  }
  if (schedule.enabled) {
    return { rearm: false, reason: 'already_enabled' };
  }
  if (schedule.stopReason !== 'consecutive_failures') {
    return { rearm: false, reason: 'not_failure_pause' };
  }
  if (!isTransientFailureRearmReason(schedule.latestReasonCode)) {
    return { rearm: false, reason: 'not_transient_reason' };
  }
  if (!readyAt || !schedule.lastEvaluatedAt || schedule.lastEvaluatedAt >= readyAt) {
    return { rearm: false, reason: 'failure_after_ready' };
  }
  return { rearm: true };
}
