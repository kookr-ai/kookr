import type { Task } from './task-read-model.js';
import { capacityHasResidualPhantomPressure } from './capacity-ledger.js';

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
 * Soft TTL for capacity-aware early reclaim (issue #2225): 40 minutes.
 * When the fleet has idle effective headroom (or sustained phantom/paused
 * occupancy), reclaim uses this bound instead of waiting the full hard 2h.
 */
export const DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS = 40 * 60_000;

/**
 * Hard max TTL: 6 hours. Operator override (env/settings) can lengthen the
 * hold for long free-tier cooldowns but never restore multi-day phantom holds
 * this feature exists to bound.
 */
export const MAX_PROVIDER_PAUSED_HARD_TTL_MS = 6 * 60 * 60_000;

/**
 * Minimum soft TTL (issue #2225): 15 minutes — never early-reclaim faster than
 * a short free-tier reset window.
 */
export const MIN_PROVIDER_PAUSED_SOFT_TTL_MS = 15 * 60_000;

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

/**
 * Issue #2228: open-PR fail-safe split into confirmed vs unknown. Aggregate
 * `skippedOpenPrFailsafe` on health/metrics = confirmed + unknown.
 */
export type ProviderPausedTtlSkipReason =
  | 'skipped_under_ttl'
  | 'skipped_open_pr_confirmed'
  | 'skipped_open_pr_unknown'
  | 'skipped_no_pause_start'
  /** Provider reset not yet elapsed — hold for #1896 auto-resume (issue #2079). */
  | 'skipped_awaiting_provider_reset';

export const PROVIDER_PAUSED_TTL_SKIP_REASONS: readonly ProviderPausedTtlSkipReason[] = [
  'skipped_under_ttl',
  'skipped_open_pr_confirmed',
  'skipped_open_pr_unknown',
  'skipped_no_pause_start',
  'skipped_awaiting_provider_reset',
] as const;

export type ProviderPausedTtlSkipCounts = Record<ProviderPausedTtlSkipReason, number>;

export function emptyProviderPausedTtlSkipCounts(): ProviderPausedTtlSkipCounts {
  return {
    skipped_under_ttl: 0,
    skipped_open_pr_confirmed: 0,
    skipped_open_pr_unknown: 0,
    skipped_no_pause_start: 0,
    skipped_awaiting_provider_reset: 0,
  };
}

/** Aggregate open-PR fail-safe skips (confirmed + unknown) for health/metrics compat. */
export function providerPausedOpenPrFailsafeSkipTotal(
  skips: Pick<ProviderPausedTtlSkipCounts, 'skipped_open_pr_confirmed' | 'skipped_open_pr_unknown'>,
): number {
  return skips.skipped_open_pr_confirmed + skips.skipped_open_pr_unknown;
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
  /** Hard TTL (default {@link DEFAULT_PROVIDER_PAUSED_HARD_TTL_MS}). */
  ttlMs?: number;
  /**
   * Soft TTL for capacity-aware early reclaim (issue #2225). Used only when
   * {@link capacityAllowsEarlyReclaim} is true. Defaults to
   * {@link DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS}.
   */
  softTtlMs?: number;
  /**
   * When true, select candidates once pause age reaches the soft TTL instead
   * of waiting for the hard 2h bound (issue #2225). Wire from capacity ledger
   * (phantom/paused occupancy + free general-source slots).
   */
  capacityAllowsEarlyReclaim?: boolean;
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
 * Effective TTL for one provider_paused selection pass (issue #2225).
 * Capacity-aware early reclaim uses min(hard, soft); otherwise hard only.
 */
export function effectiveProviderPausedTtlMs(opts: {
  ttlMs?: number;
  softTtlMs?: number;
  capacityAllowsEarlyReclaim?: boolean;
}): number {
  const hard = opts.ttlMs ?? DEFAULT_PROVIDER_PAUSED_HARD_TTL_MS;
  if (!opts.capacityAllowsEarlyReclaim) return hard;
  const soft = opts.softTtlMs ?? DEFAULT_PROVIDER_PAUSED_SOFT_TTL_MS;
  return Math.min(hard, Math.max(MIN_PROVIDER_PAUSED_SOFT_TTL_MS, soft));
}

/**
 * Capacity gate for soft provider_paused reclaim (issues #2225 AC3 / #2357).
 *
 * Fires when either:
 * 1. **Steady soft path (#2225):** free general-source headroom ≥ freeBound
 *    (default 3) AND phantom+paused occupancy ≥ occupancyBound (default 4).
 * 2. **Residual idle_capacity pressure (#2357):** freeForGeneralSources (idle
 *    effective slots) > 0 AND multi-slot phantom/pause occupancy ≥ 2, with
 *    empty pending queue when provided — the live residual free=2 / phantom=3
 *    / paused=5 shape that capacityThroughputVerdict already labels
 *    idle_capacity while the #2225 freeBound=3 gate stayed off.
 */
export function capacityAllowsProviderPausedEarlyReclaim(input: {
  phantomActive: number;
  providerPausedCount: number;
  freeForGeneralSources: number;
  /** When set and > 0, residual path stays off (work already queued). */
  pendingQueueDepth?: number;
  /** Minimum free general slots for the #2225 path (default 3). */
  freeBound?: number;
  /** Minimum phantom+paused occupancy for the #2225 path (default 4). */
  occupancyBound?: number;
}): boolean {
  const free = input.freeForGeneralSources;
  // Residual idle_capacity + multi-slot pause/phantom (issue #2357). freeForGeneral
  // is the same key capacityThroughputVerdict uses for idleEffectiveSlots.
  if (
    Number.isFinite(free)
    && capacityHasResidualPhantomPressure({
      idleEffectiveSlots: free,
      phantomActive: input.phantomActive,
      providerPausedCount: input.providerPausedCount,
      pendingQueueDepth: input.pendingQueueDepth,
    })
  ) {
    return true;
  }

  const freeBound = input.freeBound ?? 3;
  const occupancyBound = input.occupancyBound ?? 4;
  if (!Number.isFinite(free) || free < freeBound) return false;
  const occupancy =
    Math.max(0, input.phantomActive) + Math.max(0, input.providerPausedCount);
  return occupancy >= occupancyBound;
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
 * Pure selection of provider_paused tasks past the (hard or soft) TTL
 * (issues #2079 / #2225).
 *
 * Boundary is inclusive: `pausedForMs >= effectiveTtlMs` selects. When
 * {@link SelectExpiredProviderPausedTasksOpts.capacityAllowsEarlyReclaim} is
 * true, effective TTL is min(hard, soft) so aged pauses free slots without
 * waiting the full 2h hard bound. Guards (order):
 * - only `status === 'inProgress'` without `completion_ready`;
 * - `isProviderPaused` must return true;
 * - missing pause start → `skipped_no_pause_start`;
 * - effective pause age under TTL → `skipped_under_ttl`;
 * - awaiting provider reset (#1896) → `skipped_awaiting_provider_reset`;
 * - open-PR fail-safe true → `skipped_open_pr_confirmed`; unknown/unwired →
 *   `skipped_open_pr_unknown` (issue #2228; reclaim still blocked either way);
 * - otherwise selected (oldest-paused first).
 */
export function selectExpiredProviderPausedTasks(
  tasks: readonly Task[],
  opts: SelectExpiredProviderPausedTasksOpts,
): ProviderPausedTtlSelection {
  const nowMs = (opts.now ?? new Date()).getTime();
  const ttlMs = effectiveProviderPausedTtlMs({
    ttlMs: opts.ttlMs,
    softTtlMs: opts.softTtlMs,
    capacityAllowsEarlyReclaim: opts.capacityAllowsEarlyReclaim,
  });
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
    // Issue #2228: split confirmed-open vs unknown (state-fetch lag / unwired).
    const openPrHold = opts.isHoldingOpenPr?.(task);
    if (openPrHold !== false) {
      if (openPrHold === true) {
        skips.skipped_open_pr_confirmed += 1;
        outcomes.push({
          taskId: task.id,
          outcome: 'skipped_open_pr_confirmed',
          pausedForMs,
        });
      } else {
        skips.skipped_open_pr_unknown += 1;
        outcomes.push({
          taskId: task.id,
          outcome: 'skipped_open_pr_unknown',
          pausedForMs,
        });
      }
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
