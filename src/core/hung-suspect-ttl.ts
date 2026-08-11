import type { Task } from './task-read-model.js';
import type { HungTaskLivenessEvidence } from './hung-task-reaper.js';

/**
 * hungSuspect TTL reclaim (issue #1935 / residual metrics #2045 / reclaim
 * effectiveness #2072).
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
 * missing liveness, provider pause). Issue #2072: long-silent
 * `needs_input` / `permission_blocked` no longer permanently block reclaim —
 * once multi-channel silence ≥ TTL they are selected (same class L3 already
 * reclaims via stuckReason `hung_suspect`, which outranks waiting_on_input).
 * Provider-pause and open-PR fail-safe remain hard bars.
 *
 * Per-candidate outcomes (issue #2072) carry task ids so a pass with
 * `candidatesConsidered>0` and `reclaimAttempted=0` is auditable.
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
 *
 * `skipped_exempt_anomaly` is retained for API/metrics stability (issue #2045)
 * but is no longer produced by the selector after #2072 — past-TTL silence
 * supersedes human-gated anomalies. Historical health docs may still mention it.
 *
 * Issue #2228: open-PR fail-safe is split into confirmed vs unknown so GitHub
 * state-fetch lag is not lumped with real stranded PRs. The aggregate
 * `skipped_open_pr_failsafe` remains on health/metrics snapshots only
 * (`confirmed + unknown`) for scraper/compat; it is not a selection outcome.
 */
export type HungSuspectReclaimSkipReason =
  | 'skipped_no_liveness'
  | 'skipped_open_pr_confirmed'
  | 'skipped_open_pr_unknown'
  | 'skipped_under_ttl'
  | 'skipped_exempt_anomaly'
  | 'skipped_provider_paused';

export const HUNG_SUSPECT_RECLAIM_SKIP_REASONS: readonly HungSuspectReclaimSkipReason[] = [
  'skipped_no_liveness',
  'skipped_open_pr_confirmed',
  'skipped_open_pr_unknown',
  'skipped_under_ttl',
  'skipped_exempt_anomaly',
  'skipped_provider_paused',
] as const;

export type HungSuspectReclaimSkipCounts = Record<HungSuspectReclaimSkipReason, number>;

export function emptyHungSuspectReclaimSkipCounts(): HungSuspectReclaimSkipCounts {
  return {
    skipped_no_liveness: 0,
    skipped_open_pr_confirmed: 0,
    skipped_open_pr_unknown: 0,
    skipped_under_ttl: 0,
    skipped_exempt_anomaly: 0,
    skipped_provider_paused: 0,
  };
}

/** Aggregate open-PR fail-safe skips (confirmed + unknown) for health/metrics compat. */
export function openPrFailsafeSkipTotal(
  skips: Pick<HungSuspectReclaimSkipCounts, 'skipped_open_pr_confirmed' | 'skipped_open_pr_unknown'>,
): number {
  return skips.skipped_open_pr_confirmed + skips.skipped_open_pr_unknown;
}

/**
 * One hungSuspect candidate's fate on a single selection pass (issue #2072).
 * Gives operators task-id granularity when aggregate counters show
 * `candidatesConsidered>0` but `reclaimAttempted=0`.
 */
export interface HungSuspectReclaimCandidateOutcome {
  taskId: string;
  /** Selected for reclaim, or the skip reason that applied. */
  outcome: 'selected' | HungSuspectReclaimSkipReason;
  /** Present when silence age was computed (not for no-liveness). */
  silentForMs?: number;
}

/** Full selection result for one reclaim pass (issues #2045 / #2072). */
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
  /** Per-candidate outcomes with task ids (issue #2072 audit). */
  outcomes: HungSuspectReclaimCandidateOutcome[];
}

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
   * or `null`/`undefined` when nothing is queued.
   *
   * Issue #2072: `needs_input` / `permission_blocked` no longer permanently
   * block reclaim. `stuckReason` already surfaces long-silent human-gated
   * stalls as `hung_suspect` (hung wins over waiting_on_input), matching the
   * class L3 RECLAIM_HUNG_L1 already completes. Once multi-channel silence
   * reaches the hungSuspect TTL, soft-reclaim frees the slot (needs-human
   * disposition). Under-TTL silence still skips via `skipped_under_ttl`.
   *
   * Kept as an option for callers/tests that still pass it (no-op for
   * selection after #2072; reserved for future anomaly-aware policy).
   */
  getQueuedAnomalyType?: (task: Task) => string | null | undefined;
  /**
   * Provider billing/quota pause (#1667). When true, reclaim skips the task —
   * same hold-for-resume rule as `maybeReapHungTask`. Not widened by #2072.
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
   * Not widened by #2072 (open-PR fail-safe stays).
   */
  isHoldingOpenPr?: (task: Task) => boolean | undefined;
}

/**
 * Pure selection of hungSuspect tasks past the silence TTL, with skip-reason
 * breakdown and per-candidate task-id outcomes (issues #2045 / #2072).
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
 * - provider pause → `skipped_provider_paused`;
 * - missing / all-zero liveness → `skipped_no_liveness`;
 * - silence under TTL → `skipped_under_ttl`;
 * - open-PR fail-safe true → `skipped_open_pr_confirmed`; unknown/unwired →
 *   `skipped_open_pr_unknown` (issue #2228; reclaim still blocked either way);
 * - otherwise selected (including long-silent needs_input / permission_blocked
 *   past TTL — issue #2072; disposition stays needs-human).
 */
export function selectExpiredHungSuspectTasks(
  tasks: readonly Task[],
  opts: ListExpiredHungSuspectTasksOpts,
): HungSuspectReclaimSelection {
  const nowMs = (opts.now ?? new Date()).getTime();
  const ttlMs = opts.ttlMs ?? DEFAULT_HUNG_SUSPECT_TTL_MS;
  const out: ExpiredHungSuspectEntry[] = [];
  const skips = emptyHungSuspectReclaimSkipCounts();
  const outcomes: HungSuspectReclaimCandidateOutcome[] = [];
  let candidatesConsidered = 0;

  for (const task of tasks) {
    if (task.status !== 'inProgress') continue;
    // finishedAwaitingAck has its own reclaim (#1884); never double-claim.
    if (task.pendingSignal?.kind === 'completion_ready') continue;
    if (!opts.isHungSuspect(task)) continue;

    candidatesConsidered += 1;

    // Provider pause stays a hard bar (#1667 / issue #2072: do not widen).
    if (opts.isProviderPaused?.(task)) {
      skips.skipped_provider_paused += 1;
      outcomes.push({ taskId: task.id, outcome: 'skipped_provider_paused' });
      continue;
    }

    const liveness = opts.getLiveness(task);
    if (!liveness) {
      skips.skipped_no_liveness += 1;
      outcomes.push({ taskId: task.id, outcome: 'skipped_no_liveness' });
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
      outcomes.push({ taskId: task.id, outcome: 'skipped_no_liveness' });
      continue;
    }

    const silentForMs = nowMs - lastActivityAt;
    if (silentForMs < ttlMs) {
      skips.skipped_under_ttl += 1;
      outcomes.push({ taskId: task.id, outcome: 'skipped_under_ttl', silentForMs });
      continue;
    }

    // Fail-safe: only a definite `false` clears the task for reclaim.
    // Not widened by #2072 — open/unknown PR holds still skip.
    // Issue #2228: split confirmed-open vs unknown (state-fetch lag / unwired).
    const openPrHold = opts.isHoldingOpenPr?.(task);
    if (openPrHold !== false) {
      if (openPrHold === true) {
        skips.skipped_open_pr_confirmed += 1;
        outcomes.push({
          taskId: task.id,
          outcome: 'skipped_open_pr_confirmed',
          silentForMs,
        });
      } else {
        skips.skipped_open_pr_unknown += 1;
        outcomes.push({
          taskId: task.id,
          outcome: 'skipped_open_pr_unknown',
          silentForMs,
        });
      }
      continue;
    }

    // Past TTL + clear of hard bars → select. Queued needs_input /
    // permission_blocked no longer permanent-blocks here (#2072): silence age
    // is the invariant; soft reclaim records needs-human disposition.
    // `getQueuedAnomalyType` is retained on opts for API/call-site compat but
    // is not a selection gate after #2072.
    out.push({ task, silentForMs });
    outcomes.push({ taskId: task.id, outcome: 'selected', silentForMs });
  }

  return {
    expired: out.sort((a, b) => b.silentForMs - a.silentForMs),
    candidatesConsidered,
    skips,
    outcomes,
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
