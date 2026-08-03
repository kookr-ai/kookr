import type { Task } from './task-read-model.js';
import type { HungTaskLivenessEvidence } from './hung-task-reaper.js';

/**
 * hungSuspect TTL reclaim (issue #1935).
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
 * Pure selection of hungSuspect tasks past the silence TTL, oldest-first.
 *
 * Silence age is measured from the most recent of the three liveness channels
 * (hook event / pane change / token activity) — the same clock
 * `evaluateHungTaskReap` uses. Boundary is inclusive: `silentForMs >= ttlMs`
 * selects. Guards:
 *
 * - only `status === 'inProgress'` without `completion_ready` (hungSuspect
 *   class; finishedAwaitingAck has its own reclaim path);
 * - `isHungSuspect` must return true — never reclaim a working agent;
 * - missing liveness evidence skips the task (no silence-since-epoch);
 * - the stranded-PR predicate gates every candidate before selection.
 */
export function listExpiredHungSuspectTasks(
  tasks: readonly Task[],
  opts: ListExpiredHungSuspectTasksOpts,
): ExpiredHungSuspectEntry[] {
  const nowMs = (opts.now ?? new Date()).getTime();
  const ttlMs = opts.ttlMs ?? DEFAULT_HUNG_SUSPECT_TTL_MS;
  const out: ExpiredHungSuspectEntry[] = [];

  for (const task of tasks) {
    if (task.status !== 'inProgress') continue;
    // finishedAwaitingAck has its own reclaim (#1884); never double-claim.
    if (task.pendingSignal?.kind === 'completion_ready') continue;
    if (!opts.isHungSuspect(task)) continue;

    // Human-gated / external stalls must never be reclaimed as "hung" — the
    // capacity class can still label long-silent needs_input as hungSuspect via
    // the silence fallback, but termination requires the same safety the hard
    // reaper gets from its stale_agent-only gate (issue #1935 / #1667).
    const queuedAnomaly = opts.getQueuedAnomalyType?.(task) ?? null;
    if (queuedAnomaly !== null && RECLAIM_EXEMPT_ANOMALY_TYPES.has(queuedAnomaly)) continue;
    if (opts.isProviderPaused?.(task)) continue;

    const liveness = opts.getLiveness(task);
    if (!liveness) continue;

    const lastActivityAt = Math.max(
      liveness.lastHookEventAt,
      liveness.lastPaneChangeAt,
      liveness.lastTokenActivityAt,
    );
    // All-zero liveness (never recorded) is "unknown", not "silent forever".
    if (lastActivityAt <= 0) continue;

    const silentForMs = nowMs - lastActivityAt;
    if (silentForMs < ttlMs) continue;

    // Fail-safe: only a definite `false` clears the task for reclaim.
    if (opts.isHoldingOpenPr?.(task) !== false) continue;

    out.push({ task, silentForMs });
  }

  return out.sort((a, b) => b.silentForMs - a.silentForMs);
}
