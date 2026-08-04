import type { Task } from './task-read-model.js';
import type { HungTaskLivenessEvidence } from './hung-task-reaper.js';

/**
 * hungSuspect TTL reclaim (issue #1935 / residual metrics #2045).
 *
 * `hungSuspect` is a CAPACITY CLASS (see `core/capacity-ledger.ts`
 * `classifyTaskCapacity`), not a task status: a task is hungSuspect when
 * `status === 'inProgress'`, no `completion_ready` pendingSignal, and the
 * watchdog/attention path reports it hung (see `isTaskHungSuspect`). Until
 * the 3h hard hung-task reaper fires, these tasks chronically hold active
 * concurrency slots — the 2026-08-03 reflection saw 7 hungSuspect of 14
 * active (~50% phantom occupancy) while utilization still looked healthy.
 *
 * This module is the pure selector for "which hungSuspect tasks have been
 * silent past the TTL and should be terminated to free their slot." Sibling
 * of `finished-awaiting-ack-ttl.ts` / `pending-task-ttl.ts` — same age /
 * inclusive-boundary shape — wired on the liveness tick from
 * `server/hung-suspect-ttl-sweep.ts`.
 *
 * Soft reclaim (not force-complete): hungSuspect tasks have NOT finished
 * their work, so the wiring layer terminates (same path as the 3h hung-task
 * reaper) with disposition reason `hung_suspect_ttl` and a needs-human /
 * obsolete ledger entry. Force-completing would lie about delivery.
 *
 * Stranded-PR exemption: a hungSuspect task that still holds an open,
 * unmerged PR must NEVER be terminated out from under it — that PR is the
 * actual deliverable. See {@link ListExpiredHungSuspectTasksOpts.isHoldingOpenPr}.
 *
 * Skip-reason breakdown (issue #2045): every hungSuspect candidate that is
 * not selected is counted under exactly one skip reason so operators can see
 * why `reclaimedTotal` stays 0 (under-TTL after redeploy, open-PR fail-safe,
 * missing liveness, exempt anomaly, provider pause).
 */

/** Default TTL (issue #1935): 25 minutes of all-channel silence. */
export const DEFAULT_HUNG_SUSPECT_TTL_MS = 25 * 60_000;

/**
 * Hard max TTL (issue #1935): 60 minutes. `settings-store.ts` clamps
 * `hungSuspectTtlMinutes` to this ceiling so an operator override can lengthen
 * the grace window for long tools but never restore multi-hour phantom holds
 * this feature exists to bound. Exported so callers that bypass settings
 * (tests, scripts) can enforce the same cap.
 */
export const MAX_HUNG_SUSPECT_TTL_MS = 60 * 60_000;

export interface ExpiredHungSuspectEntry {
  task: Task;
  /** How long all liveness channels have been silent (now − max activity timestamps). */
  silentForMs: number;
}

/**
 * Why a hungSuspect candidate was not selected for reclaim (issue #2045).
 * Cumulative counters live on `HungSuspectTtlReclaimMetrics`.
 */
export type HungSuspectReclaimSkipReason =
  | 'skipped_no_liveness'
  | 'skipped_open_pr_failsafe'
  | 'skipped_under_ttl'
  | 'skipped_exempt_anomaly'
  | 'skipped_provider_paused';

export const HUNG_SUSPECT_RECLAIM_SKIP_REASONS: readonly HungSuspectReclaimSkipReason[] = [
  'skipped_no_liveness',
  'skipped_open_pr_failsafe',
  'skipped_under_ttl',
  'skipped_exempt_anomaly',
  'skipped_provider_paused',
] as const;

export type HungSuspectReclaimSkipCounts = Record<HungSuspectReclaimSkipReason, number>;

export function emptyHungSuspectReclaimSkipCounts(): HungSuspectReclaimSkipCounts {
  return {
    skipped_no_liveness: 0,
    skipped_open_pr_failsafe: 0,
    skipped_under_ttl: 0,
    skipped_exempt_anomaly: 0,
    skipped_provider_paused: 0,
  };
}

/** Full selection result for one reclaim pass (issue #2045). */
export interface HungSuspectReclaimSelection {
  /** Tasks past TTL and clear of fail-safes — oldest-silent first. */
  expired: ExpiredHungSuspectEntry[];
  /**
   * How many inProgress, non-FAA, isHungSuspect tasks were considered this
   * pass (denominator for skip-reason breakdown).
   */
  candidatesConsidered: number;
  /** Per-reason skip counts for candidates that were not selected. */
  skips: HungSuspectReclaimSkipCounts;
}

/** Queued anomaly types that mean "waiting on human / external", never reclaim. */
const RECLAIM_EXEMPT_ANOMALY_TYPES = new Set([
  'needs_input',
  'permission_blocked',
]);

export interface ListExpiredHungSuspectTasksOpts {
  now?: Date;
  ttlMs?: number;
  /**
   * Precomputed hung-suspect classification for each task. The wiring layer
   * supplies `isTaskHungSuspect` (or the capacity-ledger path) so this selector
   * stays pure and I/O-free. Only tasks for which this returns `true` are
   * candidates — never terminate a task that is not already classified hung.
   */
  isHungSuspect: (task: Task) => boolean;
  /**
   * Raw liveness timestamps for the task's agent. Returns `undefined` when
   * the watchdog has no state — treated as "not reclaimable" (same fail-safe
   * as `isTaskHungSuspect`: never invent silence-since-epoch).
   */
  getLiveness: (task: Task) => HungTaskLivenessEvidence | undefined;
  /**
   * Queued attention anomaly for the task's agent (`AttentionQueue.peek` type),
   * or `null`/`undefined` when nothing is queued. Reclaim refuses
   * `needs_input` / `permission_blocked` — those are human-gated stalls, not
   * silent death (mirrors the hard hung-task reaper's `stale_agent`-only gate;
   * issue #1935 safety: never force-kill a waiting agent).
   */
  getQueuedAnomalyType?: (task: Task) => string | null | undefined;
  /**
   * Provider billing/quota pause (#1667). When true, reclaim skips the task —
   * same hold-for-resume rule as `maybeReapHungTask`.
   */
  isProviderPaused?: (task: Task) => boolean;
  /**
   * Stranded-PR / `merge_required` exemption predicate (issue #1935). Same
   * fail-safe contract as the finishedAwaitingAck TTL reclaim:
   *
   * - `true`  — the task holds a confirmed-open PR. Exempt, always.
   * - `false` — confirmed no open PR is tied to the task. Safe to reclaim.
   * - `undefined` — unknown / unavailable. FAIL-SAFE: treated like `true`.
   *
   * Omitting this option entirely has the same fail-safe effect as a predicate
   * that always returns `undefined` — every candidate is left alone. Callers
   * that want the TTL to actually reclaim anything MUST wire a real predicate.
   */
  isHoldingOpenPr?: (task: Task) => boolean | undefined;
}

/**
 * Pure selection of hungSuspect tasks past the silence TTL, with skip-reason
 * breakdown for every candidate not selected (issue #2045).
 *
 * Silence age is measured from the most recent of the three liveness channels
 * (hook event / pane change / token activity) — the same clock
 * `evaluateHungTaskReap` uses. Boundary is inclusive: `silentForMs >= ttlMs`
 * selects. Guards (in evaluation order for a hungSuspect candidate):
 *
 * - only `status === 'inProgress'` without `completion_ready` (hungSuspect
 *   class; finishedAwaitingAck has its own reclaim path) — non-candidates are
 *   not counted;
 * - `isHungSuspect` must return true — never reclaim a working agent;
 * - exempt anomaly → `skipped_exempt_anomaly`;
 * - provider pause → `skipped_provider_paused`;
 * - missing / all-zero liveness → `skipped_no_liveness`;
 * - silence under TTL → `skipped_under_ttl`;
 * - open-PR fail-safe (true or unknown) → `skipped_open_pr_failsafe`.
 */
export function selectExpiredHungSuspectTasks(
  tasks: readonly Task[],
  opts: ListExpiredHungSuspectTasksOpts,
): HungSuspectReclaimSelection {
  const nowMs = (opts.now ?? new Date()).getTime();
  const ttlMs = opts.ttlMs ?? DEFAULT_HUNG_SUSPECT_TTL_MS;
  const out: ExpiredHungSuspectEntry[] = [];
  const skips = emptyHungSuspectReclaimSkipCounts();
  let candidatesConsidered = 0;

  for (const task of tasks) {
    if (task.status !== 'inProgress') continue;
    // finishedAwaitingAck has its own reclaim (#1884); never double-claim.
    if (task.pendingSignal?.kind === 'completion_ready') continue;
    if (!opts.isHungSuspect(task)) continue;

    candidatesConsidered += 1;

    // Human-gated / external stalls must never be reclaimed as "hung" — the
    // capacity class can still label long-silent needs_input as hungSuspect via
    // the silence fallback, but termination requires the same safety the hard
    // reaper gets from its stale_agent-only gate (issue #1935 / #1667).
    const queuedAnomaly = opts.getQueuedAnomalyType?.(task) ?? null;
    if (queuedAnomaly !== null && RECLAIM_EXEMPT_ANOMALY_TYPES.has(queuedAnomaly)) {
      skips.skipped_exempt_anomaly += 1;
      continue;
    }
    if (opts.isProviderPaused?.(task)) {
      skips.skipped_provider_paused += 1;
      continue;
    }

    const liveness = opts.getLiveness(task);
    if (!liveness) {
      skips.skipped_no_liveness += 1;
      continue;
    }

    const lastActivityAt = Math.max(
      liveness.lastHookEventAt,
      liveness.lastPaneChangeAt,
      liveness.lastTokenActivityAt,
    );
    // All-zero liveness (never recorded) is "unknown", not "silent forever".
    if (lastActivityAt <= 0) {
      skips.skipped_no_liveness += 1;
      continue;
    }

    const silentForMs = nowMs - lastActivityAt;
    if (silentForMs < ttlMs) {
      skips.skipped_under_ttl += 1;
      continue;
    }

    // Fail-safe: only a definite `false` clears the task for reclaim.
    if (opts.isHoldingOpenPr?.(task) !== false) {
      skips.skipped_open_pr_failsafe += 1;
      continue;
    }

    out.push({ task, silentForMs });
  }

  return {
    expired: out.sort((a, b) => b.silentForMs - a.silentForMs),
    candidatesConsidered,
    skips,
  };
}

/**
 * Pure selection of hungSuspect tasks past the silence TTL, oldest-first.
 * Thin wrapper over {@link selectExpiredHungSuspectTasks} for call sites that
 * only need the expired list (issue #1935 API).
 */
export function listExpiredHungSuspectTasks(
  tasks: readonly Task[],
  opts: ListExpiredHungSuspectTasksOpts,
): ExpiredHungSuspectEntry[] {
  return selectExpiredHungSuspectTasks(tasks, opts).expired;
}
