/**
 * Critical-schedule re-arm (issue #2196).
 *
 * After multi-day outages or daemon restarts, allowlisted residual-sensing /
 * product-surface schedules can remain `enabled=false` from ops drift. This
 * module decides — pure, no I/O — whether a schedule should be re-enabled on
 * the recovery path.
 *
 * Never re-arms experimental or intentionally parked schedules. An explicit
 * {@link operatorHold} marker is the only durable way to keep an allowlisted
 * schedule disabled across restarts.
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
