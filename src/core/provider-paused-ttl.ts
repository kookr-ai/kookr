import type { Task } from './task-read-model.js';

/**
 * provider_paused occupancy bound + hard TTL (issue #2079).
 *
 * `provider_paused` correctly blocks auto-complete (#1667) and hungSuspect
 * reclaim skip, but there was no upper bound when paused tasks hold
 * concurrency for hours — unattended capacity starves (live
 * `skippedProviderPaused=5743` with `reclaimAttempted=0`).
 *
 * This module is the pure selector / occupancy summary for:
 *
 * 1. Health: count of inProgress provider_paused tasks + oldest pause age.
 * 2. Hard TTL reclaim: after a long hold (default 2h), terminate with
 *    disposition `provider_paused_ttl` (needs-human) — never force-complete
 *    as delivered.
 *
 * Stranded-PR exemption: same fail-safe contract as hungSuspect TTL —
 * a paused task that still holds an open, unmerged PR must NEVER be
 * terminated out from under it.
 *
 * Sibling of `hung-suspect-ttl.ts` — same age / inclusive-boundary shape —
 * wired from `server/provider-paused-ttl-sweep.ts` on the liveness tick.
 */

/** Default hard TTL (issue #2079): 2 hours of continuous provider pause. */
export const DEFAULT_PROVIDER_PAUSED_HARD_TTL_MS = 2 * 60 * 60_000;

/**
 * Hard max TTL: 6 hours. Operator override (env/settings) can lengthen the
 * hold for long free-tier cooldowns but never restore multi-day phantom holds
 * this feature exists to bound.
 */
export const MAX_PROVIDER_PAUSED_HARD_TTL_MS = 6 * 60 * 60_000;

/** Cap task ids on the health occupancy snapshot. */
export const MAX_PROVIDER_PAUSED_OCCUPANCY_TASK_IDS = 16;

/**
 * Minimum provider_paused occupancy before paging (issue #2079). Matches
 * hungSuspect residual / capacity count bound defaults so operators see a
 * consistent "≥3 stalled slots" page threshold.
 */
export const DEFAULT_PROVIDER_PAUSED_OCCUPANCY_COUNT_BOUND = 3;

export interface ProviderPausedOccupancySnapshot {
  /** How many inProgress (non-FAA) tasks are currently provider_paused. */
  count: number;
  /**
   * Age of the oldest continuous pause (now − earliest pauseStartedAt), or
   * null when count is 0. Tasks without a known start contribute 0 age only
   * after the tracker latches them on a later tick.
   */
  oldestPauseAgeMs: number | null;
  /** Sample of paused task ids (capped) for operator audit. */
  taskIds: string[];
}

export interface SummarizeProviderPausedOccupancyOpts {
  now?: Date;
  isProviderPaused: (task: Task) => boolean;
  /**
   * First-observed pause start (ms since epoch) for the task. Returns
   * `undefined` when the task is not (or was never) latched as paused —
   * such tasks still count toward occupancy, but do not contribute to
   * oldestPauseAgeMs until a start is known.
   */
  getPauseStartedAtMs: (task: Task) => number | undefined;
}

/**
 * Live occupancy of provider_paused tasks for `/api/health` (issue #2079).
 * Counts every inProgress task that is provider-paused and not
 * finishedAwaitingAck (FAA has its own reclaim path).
 */
export function summarizeProviderPausedOccupancy(
  tasks: readonly Task[],
  opts: SummarizeProviderPausedOccupancyOpts,
): ProviderPausedOccupancySnapshot {
  const nowMs = (opts.now ?? new Date()).getTime();
  const taskIds: string[] = [];
  let count = 0;
  let oldestStart: number | undefined;

  for (const task of tasks) {
    if (task.status !== 'inProgress') continue;
    if (task.pendingSignal?.kind === 'completion_ready') continue;
    if (!opts.isProviderPaused(task)) continue;

    count += 1;
    if (taskIds.length < MAX_PROVIDER_PAUSED_OCCUPANCY_TASK_IDS) {
      taskIds.push(task.id);
    }
    const started = opts.getPauseStartedAtMs(task);
    if (typeof started === 'number' && Number.isFinite(started) && started > 0) {
      if (oldestStart === undefined || started < oldestStart) {
        oldestStart = started;
      }
    }
  }

  return {
    count,
    oldestPauseAgeMs:
      count > 0 && oldestStart !== undefined
        ? Math.max(0, nowMs - oldestStart)
        : null,
    taskIds,
  };
}

export interface ExpiredProviderPausedEntry {
  task: Task;
  /** How long the task has been continuously paused (now − pauseStartedAt). */
  pausedForMs: number;
}

export type ProviderPausedTtlSkipReason =
  | 'skipped_under_ttl'
  | 'skipped_open_pr_failsafe'
  | 'skipped_no_pause_start'
  /** Provider reset not yet elapsed — hold for #1896 auto-resume (issue #2079). */
  | 'skipped_awaiting_provider_reset';

export const PROVIDER_PAUSED_TTL_SKIP_REASONS: readonly ProviderPausedTtlSkipReason[] = [
  'skipped_under_ttl',
  'skipped_open_pr_failsafe',
  'skipped_no_pause_start',
  'skipped_awaiting_provider_reset',
] as const;

export type ProviderPausedTtlSkipCounts = Record<ProviderPausedTtlSkipReason, number>;

export function emptyProviderPausedTtlSkipCounts(): ProviderPausedTtlSkipCounts {
  return {
    skipped_under_ttl: 0,
    skipped_open_pr_failsafe: 0,
    skipped_no_pause_start: 0,
    skipped_awaiting_provider_reset: 0,
  };
}

export interface ProviderPausedTtlCandidateOutcome {
  taskId: string;
  outcome: 'selected' | ProviderPausedTtlSkipReason;
  pausedForMs?: number;
}

export interface ProviderPausedTtlSelection {
  expired: ExpiredProviderPausedEntry[];
  candidatesConsidered: number;
  skips: ProviderPausedTtlSkipCounts;
  outcomes: ProviderPausedTtlCandidateOutcome[];
}

export interface SelectExpiredProviderPausedTasksOpts {
  now?: Date;
  ttlMs?: number;
  isProviderPaused: (task: Task) => boolean;
  /**
   * First-observed continuous pause start (ms). Missing start → skip
   * `skipped_no_pause_start` (never invent pause-since-epoch).
   */
  getPauseStartedAtMs: (task: Task) => number | undefined;
  /**
   * Optional last liveness activity (ms). When present and after the latch
   * start, hard-TTL age is measured from the later of the two so a recovered
   * agent that still has a sticky billing event in its event window is not
   * terminated while it is demonstrably working (issue #2079 review).
   */
  getLastActivityAtMs?: (task: Task) => number | undefined;
  /**
   * Provider-reset hold (#1896). When true, hard-TTL reclaim skips so the
   * auto-resume scheduler can re-dispatch at reset. When false, reclaim is
   * allowed (reset elapsed — free the slot/lease). When omitted, no skip.
   */
  isAwaitingProviderReset?: (task: Task) => boolean;
  /**
   * Stranded-PR / open-PR fail-safe (same contract as hungSuspect TTL):
   * - `true`  — holds a confirmed-open PR. Exempt, always.
   * - `false` — confirmed no open PR. Safe to reclaim.
   * - `undefined` — unknown. FAIL-SAFE: treated like `true`.
   * Omitting the option entirely leaves every candidate alone.
   */
  isHoldingOpenPr?: (task: Task) => boolean | undefined;
}

/**
 * Effective continuous-pause start for hard TTL (issue #2079).
 * Later of first-observed pause latch and last liveness activity — so sticky
 * historical billing events do not accumulate age while the agent works.
 */
export function effectiveProviderPausedStartMs(
  pauseStartedAtMs: number,
  lastActivityAtMs: number | undefined,
): number {
  if (
    typeof lastActivityAtMs === 'number'
    && Number.isFinite(lastActivityAtMs)
    && lastActivityAtMs > 0
    && lastActivityAtMs > pauseStartedAtMs
  ) {
    return lastActivityAtMs;
  }
  return pauseStartedAtMs;
}

/**
 * Pure selection of provider_paused tasks past the hard TTL (issue #2079).
 *
 * Boundary is inclusive: `pausedForMs >= ttlMs` selects. Guards (order):
 * - only `status === 'inProgress'` without `completion_ready`;
 * - `isProviderPaused` must return true;
 * - missing pause start → `skipped_no_pause_start`;
 * - effective pause age under TTL → `skipped_under_ttl`;
 * - awaiting provider reset (#1896) → `skipped_awaiting_provider_reset`;
 * - open-PR fail-safe (true or unknown) → `skipped_open_pr_failsafe`;
 * - otherwise selected (oldest-paused first).
 */
export function selectExpiredProviderPausedTasks(
  tasks: readonly Task[],
  opts: SelectExpiredProviderPausedTasksOpts,
): ProviderPausedTtlSelection {
  const nowMs = (opts.now ?? new Date()).getTime();
  const ttlMs = opts.ttlMs ?? DEFAULT_PROVIDER_PAUSED_HARD_TTL_MS;
  const out: ExpiredProviderPausedEntry[] = [];
  const skips = emptyProviderPausedTtlSkipCounts();
  const outcomes: ProviderPausedTtlCandidateOutcome[] = [];
  let candidatesConsidered = 0;

  for (const task of tasks) {
    if (task.status !== 'inProgress') continue;
    if (task.pendingSignal?.kind === 'completion_ready') continue;
    if (!opts.isProviderPaused(task)) continue;

    candidatesConsidered += 1;

    const started = opts.getPauseStartedAtMs(task);
    if (typeof started !== 'number' || !Number.isFinite(started) || started <= 0) {
      skips.skipped_no_pause_start += 1;
      outcomes.push({ taskId: task.id, outcome: 'skipped_no_pause_start' });
      continue;
    }

    const effectiveStart = effectiveProviderPausedStartMs(
      started,
      opts.getLastActivityAtMs?.(task),
    );
    const pausedForMs = nowMs - effectiveStart;
    if (pausedForMs < ttlMs) {
      skips.skipped_under_ttl += 1;
      outcomes.push({ taskId: task.id, outcome: 'skipped_under_ttl', pausedForMs });
      continue;
    }

    // #1896: hold until provider reset so auto-resume can re-dispatch.
    if (opts.isAwaitingProviderReset?.(task) === true) {
      skips.skipped_awaiting_provider_reset += 1;
      outcomes.push({
        taskId: task.id,
        outcome: 'skipped_awaiting_provider_reset',
        pausedForMs,
      });
      continue;
    }

    // Fail-safe: only a definite `false` clears the task for reclaim.
    if (opts.isHoldingOpenPr?.(task) !== false) {
      skips.skipped_open_pr_failsafe += 1;
      outcomes.push({
        taskId: task.id,
        outcome: 'skipped_open_pr_failsafe',
        pausedForMs,
      });
      continue;
    }

    out.push({ task, pausedForMs });
    outcomes.push({ taskId: task.id, outcome: 'selected', pausedForMs });
  }

  return {
    expired: out.sort((a, b) => b.pausedForMs - a.pausedForMs),
    candidatesConsidered,
    skips,
    outcomes,
  };
}

/**
 * Thin wrapper over {@link selectExpiredProviderPausedTasks} for call sites
 * that only need the expired list.
 */
export function listExpiredProviderPausedTasks(
  tasks: readonly Task[],
  opts: SelectExpiredProviderPausedTasksOpts,
): ExpiredProviderPausedEntry[] {
  return selectExpiredProviderPausedTasks(tasks, opts).expired;
}
