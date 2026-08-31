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

/**
 * Bootstrap-safe recovery sub-tier (issue #2530).
 *
 * These are the schedules whose liveness *gates the fleet's own recovery*: if
 * they go down, nothing can bring them (or anything else) back without a human.
 * The motivating deadlock: a loop-wide `consecutive_failures` cascade parked the
 * PR merge/rebase watchdog — the one schedule that lands fix PRs — so the fix
 * for the cascade could not merge, because merging it required the very schedule
 * the cascade had disabled.
 *
 * The sub-tier is a strict subset of the critical allowlist. Two protections
 * distinguish it from an ordinary critical schedule:
 *  1. It is never auto-paused by a `consecutive_failures` streak (see the
 *     service-side `autoPausePatch`) — it stays enabled and alerts instead of
 *     disabling, so the merge watchdog is always alive to land a fix.
 *  2. If it is *already* parked in a cascade-origin `consecutive_failures`
 *     `operatorHold` (from persisted pre-fix state or another disable path),
 *     {@link decideCriticalScheduleRearm} re-arms it *through* that hold —
 *     #2353 sets `operatorHold` on every auto-pause, so a cascade hold is
 *     otherwise indistinguishable from a genuine operator park.
 *
 * This is a floor over a tiny, hand-audited set. It does NOT weaken fail-closed
 * for the general fleet: a genuine operator park (any other stopReason, or none)
 * is still respected, and non-member schedules pause exactly as before.
 */
export const BOOTSTRAP_CRITICAL_SCHEDULE_PLAYBOOK_BASENAMES: readonly string[] = [
  // PR merge/rebase watchdog — lands the fix PRs (issue #2530). Without this
  // alive, any recovery fix merged to main can never land.
  'pr-merge-rebase-watchdog.md',
  'pr-merge-rebase-watchdog',
];

/**
 * Name substrings for the bootstrap sub-tier when the playbook is renamed but
 * the schedule title still identifies the merge watchdog. Matches "PR
 * Merge/Rebase Watchdog", "Kookr PR merge/rebase watchdog", and a hyphenated
 * "Merge-Rebase Watchdog". Deliberately narrow — it requires BOTH the "merge"
 * and "rebase" tokens so unrelated `*watchdog` schedules (Resource Watchdog,
 * a plain merge-watchdog) are not exempted from fail-closed.
 */
export const BOOTSTRAP_CRITICAL_SCHEDULE_NAME_PATTERNS: readonly RegExp[] = [
  /merge\s*[/-]?\s*rebase\s+watchdog/i,
];

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
  /** Distinguishes an explicit operator park from a daemon-origin hold. */
  holdSource?: 'operator' | 'daemon';
  /** Auto-exhaustion stop reason — not ops drift; leave alone. */
  stopReason?: string;
  /** Finite-trigger state is re-checked before a failed enable is retried. */
  maxTriggers?: number;
  remainingTriggers?: number;
  playbook: { path: string };
}

/** Basename of a playbook path (`a/b/foo.md` → `foo.md`). */
export function playbookBasename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return (parts[parts.length - 1] ?? normalized).trim();
}

/**
 * True when the schedule is in the bootstrap-safe recovery sub-tier (issue
 * #2530) — the merge watchdog and any future recovery executor whose liveness
 * gates the fleet's ability to land its own fixes. Matched by playbook basename
 * or well-known name pattern, case-insensitively.
 */
export function isBootstrapCriticalSchedule(
  schedule: Pick<CriticalRearmScheduleView, 'name' | 'playbook'>,
): boolean {
  const base = playbookBasename(schedule.playbook.path).toLowerCase();
  if (BOOTSTRAP_CRITICAL_SCHEDULE_PLAYBOOK_BASENAMES.some((b) => b.toLowerCase() === base)) {
    return true;
  }
  const name = schedule.name ?? '';
  return BOOTSTRAP_CRITICAL_SCHEDULE_NAME_PATTERNS.some((re) => re.test(name));
}

/**
 * True when the schedule is on the critical re-arm allowlist (playbook basename
 * or well-known name pattern). Experimental scouts / parked batches are out.
 * The bootstrap sub-tier is a strict subset — its members are always critical.
 */
export function isCriticalAllowlistedSchedule(
  schedule: Pick<CriticalRearmScheduleView, 'name' | 'playbook'>,
): boolean {
  if (isBootstrapCriticalSchedule(schedule)) {
    return true;
  }
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
 *  3. operator hold marker set, unless it is a bootstrap cascade artifact
 *  4. trigger-limit auto-exhausted (different recovery path)
 *  5. bootstrap sub-tier parked in a cascade-origin hold → rearm (#2530)
 *  6. otherwise → rearm
 *
 * Step 5 is the bootstrap-safe floor: a `consecutive_failures` `operatorHold`
 * is a cascade artifact (#2353 sets `operatorHold` on every auto-pause), so for
 * a recovery-critical member we re-arm through it rather than let the cascade
 * strand its own recovery path. It applies only to daemon-origin or legacy
 * untagged holds. Explicit operator provenance wins even if a stale cascade
 * reason remains, and trigger exhaustion wins before the bootstrap exception.
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
  const bootstrapCascadeHold = (
    isBootstrapCriticalSchedule(schedule)
    && schedule.operatorHold === true
    && schedule.holdSource !== 'operator'
    && schedule.stopReason === 'consecutive_failures'
  );
  if (schedule.operatorHold === true && !bootstrapCascadeHold) {
    return { rearm: false, reason: 'operator_hold' };
  }
  if (
    schedule.stopReason === 'trigger_limit_reached'
    || (
      schedule.maxTriggers !== undefined
      && (schedule.remainingTriggers ?? schedule.maxTriggers) <= 0
    )
  ) {
    return { rearm: false, reason: 'trigger_limit_exhausted' };
  }
  if (bootstrapCascadeHold) {
    return { rearm: true };
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
  | 'operator_hold'
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
  /**
   * Provenance of the current hold (issue #2520). `operator` holds are never
   * auto-cleared here — only `daemon`-set (or legacy untagged) fail-closed
   * holds are eligible. Absent on legacy schedules; combined with a
   * `consecutive_failures` stopReason it can only be a #2353 daemon pause, so
   * absence is treated as eligible (not operator).
   */
  holdSource?: string;
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
 *  4. hold provenance is `operator` — a human held it; never auto-cleared (#2520)
 *  5. last reason is not a transient launch_error / overlap-skip
 *  6. last fire happened at or after the daemon became ready (a live #2353
 *     streak, not leftover accounting from before recovery)
 *  7. otherwise → rearm
 *
 * `operatorHold` (the boolean) is not consulted: #2353 sets it on every
 * auto-pause, and this path exists specifically to lift that leftover hold.
 * The `holdSource` tag (issue #2520) is consulted instead so a genuine
 * operator park is never auto-cleared here even if it somehow carried a
 * `consecutive_failures` stopReason. Absent `holdSource` on a
 * `consecutive_failures` pause can only be a #2353 daemon hold → eligible.
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
  if (schedule.holdSource === 'operator') {
    return { rearm: false, reason: 'operator_hold' };
  }
  if (!isTransientFailureRearmReason(schedule.latestReasonCode)) {
    return { rearm: false, reason: 'not_transient_reason' };
  }
  if (!readyAt || !schedule.lastEvaluatedAt || schedule.lastEvaluatedAt >= readyAt) {
    return { rearm: false, reason: 'failure_after_ready' };
  }
  return { rearm: true };
}
