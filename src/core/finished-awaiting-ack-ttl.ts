import type { Task } from './task-read-model.js';

/**
 * finishedAwaitingAck TTL reclaim (issue #1884).
 *
 * `finishedAwaitingAck` is a CAPACITY CLASS (see `core/capacity-ledger.ts`
 * `classifyTaskCapacity`), not a task status: a task is finishedAwaitingAck
 * when `status === 'inProgress'` AND `pendingSignal?.kind === 'completion_ready'`
 * — the agent finished its work and raised the completion signal, but nobody
 * has acknowledged it yet. Until that ack arrives the task keeps occupying an
 * active concurrency slot. In practice these sit for 15–45 minutes at a time
 * (the `finishedAwaitingAck_age` sentinel trips every ~30m), chronically
 * starving the pool the same way a hung task would, just without looking hung.
 *
 * This module is the pure selector for "which finishedAwaitingAck tasks have
 * sat past the TTL and should be force-completed to free their slot." It is
 * intentionally the sibling of `pending-task-ttl.ts` — same shape, same
 * age-from-signal-timestamp / inclusive-boundary rules — wired on the liveness
 * tick from `server/finished-awaiting-ack-ttl-sweep.ts`.
 *
 * Force-complete, not cancel: cancelling a task that already finished its work
 * would inflate `cancelled_delta` noise for no benefit (lucy #1995 lesson) —
 * the work is done, only the ack is missing. The wiring layer force-completes
 * with reason `finished_awaiting_ack_ttl` instead.
 *
 * Stranded-PR exemption: a finishedAwaitingAck task that still holds an open,
 * unmerged PR (the `merge_required` delivery path) must NEVER be force-completed
 * out from under it — that PR is the actual deliverable and a premature
 * "completed" status would strand it with no task left driving it home. See
 * {@link ListExpiredFinishedAwaitingAckTasksOpts.isHoldingOpenPr} for the
 * fail-safe contract.
 */

/** Default TTL (issue #1884): 15 minutes. */
export const DEFAULT_FINISHED_AWAITING_ACK_TTL_MS = 15 * 60_000;

/**
 * Hard max TTL (issue #1884): 30 minutes. `settings-store.ts` clamps
 * `finishedAwaitingAckTtlMinutes` to this ceiling so an operator override can
 * never restore the chronic 30–45m holds this feature exists to bound. Exported
 * so any caller that bypasses settings (tests, scripts) can enforce the same cap.
 */
export const MAX_FINISHED_AWAITING_ACK_TTL_MS = 30 * 60_000;

export interface ExpiredFinishedAwaitingAckEntry {
  task: Task;
  /** How long the completion_ready signal has sat unacknowledged (now − pendingSignal.raisedAt). */
  ageMs: number;
}

export interface ListExpiredFinishedAwaitingAckTasksOpts {
  now?: Date;
  ttlMs?: number;
  /**
   * Stranded-PR / `merge_required` exemption predicate (issue #1884). Injected
   * so this selector stays pure and I/O-free — the wiring layer supplies a
   * real implementation backed by `GitHubStateStore`. Returns:
   *
   * - `true`  — the task holds a confirmed-open PR. Exempt, always.
   * - `false` — confirmed no open PR is tied to the task. Safe to reclaim.
   * - `undefined` — unknown or unavailable (never checked, GitHub state not
   *   yet fetched, predicate not wired, etc). FAIL-SAFE: treated exactly like
   *   `true`. A possible stranded delivery must never be clobbered just
   *   because we couldn't confirm it either way.
   *
   * Omitting this option entirely has the same fail-safe effect as a predicate
   * that always returns `undefined` — every finishedAwaitingAck task is
   * treated as a possible PR hold and left alone. Callers that want the TTL to
   * actually reclaim anything MUST wire a real predicate.
   */
  isHoldingOpenPr?: (task: Task) => boolean | undefined;
}

/**
 * Pure selection of finishedAwaitingAck tasks past the TTL, oldest-first.
 *
 * Age is measured from `task.pendingSignal.raisedAt` (ISO string) — the same
 * field `buildCapacityLedger` uses for `oldestFinishedAwaitingAckAgeMs`, so
 * "past the TTL" here agrees with what the capacity ledger already reports.
 * Boundary is inclusive: `ageMs >= ttlMs` selects. Guards:
 *
 * - only `status === 'inProgress'` with `pendingSignal?.kind === 'completion_ready'`
 *   counts as finishedAwaitingAck — matches `classifyTaskCapacity` exactly.
 * - a missing or unparseable `raisedAt` skips the task rather than surfacing a
 *   bogus age (persisted state from a malformed signal is not trusted blindly).
 * - the stranded-PR predicate above gates every candidate before it is selected.
 */
export function listExpiredFinishedAwaitingAckTasks(
  tasks: readonly Task[],
  opts: ListExpiredFinishedAwaitingAckTasksOpts = {},
): ExpiredFinishedAwaitingAckEntry[] {
  const nowMs = (opts.now ?? new Date()).getTime();
  const ttlMs = opts.ttlMs ?? DEFAULT_FINISHED_AWAITING_ACK_TTL_MS;
  const out: ExpiredFinishedAwaitingAckEntry[] = [];

  for (const task of tasks) {
    if (task.status !== 'inProgress') continue;
    const signal = task.pendingSignal;
    if (signal?.kind !== 'completion_ready') continue;

    const raisedAtMs = Date.parse(signal.raisedAt);
    if (!Number.isFinite(raisedAtMs)) continue;

    const ageMs = nowMs - raisedAtMs;
    if (ageMs < ttlMs) continue;

    // Fail-safe: only a definite `false` clears the task for reclaim. `true`
    // and `undefined` (including "no predicate wired") both exempt it.
    if (opts.isHoldingOpenPr?.(task) !== false) continue;

    out.push({ task, ageMs });
  }

  return out.sort(
    (a, b) => Date.parse(a.task.pendingSignal!.raisedAt) - Date.parse(b.task.pendingSignal!.raisedAt),
  );
}
