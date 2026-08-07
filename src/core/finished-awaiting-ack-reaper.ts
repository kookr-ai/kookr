import type { Task } from './task-read-model.js';

/**
 * finishedAwaitingAck (FAA) ack-path reaper (issue #2170).
 *
 * ## Root cause this targets: `awaiting_poll`
 *
 * The FAA root-cause classifier (#2146/#2149, `core/faa-root-cause.ts`) labels
 * essentially 100% of the chronic FAA squatters `awaiting_poll`: a finished
 * task raised `completion_ready`, but the signal is still younger than the
 * 60-min stale/auto-close threshold, so *no* existing close path touches it
 * yet. The task-side completion gate (#2149) and the meta auto-complete (#2070)
 * both act on the *task lifecycle* or the aged/opted-in populations; none of
 * them bounds the plain `awaiting_poll` dwell. The result is a finished task
 * squatting an active concurrency slot for tens of minutes purely waiting on
 * the ack/close poll cadence — exactly the `finishedAwaitingAck_age` anomaly
 * that fired near-continuously across the 08-06→08-07 window.
 *
 * This module bounds that dwell on the **ack/close side**: a short hard
 * deadline after which a still-unacknowledged FAA task is force-completed to
 * free its slot — but routed through the **grace-period + operator-veto rail**
 * proven for the hung-task reaper (#2163, `core/reap-warning-coordinator.ts`)
 * so the close is never a silent surprise. Closing a *finished* task (work
 * done, only the ack missing) is far safer than killing a *hung* one, so the
 * deadline can be much tighter than the 3h hung reaper — minutes, not hours.
 *
 * Pure layer: this file owns only the deadline/grace bounds and the
 * candidate predicate. The stateful grace machine is the shared
 * {@link ../core/reap-warning-coordinator.js ReapWarningCoordinator}; the
 * tick-driven selection + close + audit live in
 * `server/finished-awaiting-ack-ack-reaper.ts`.
 */

/**
 * Default hard deadline (issue #2170): 5 minutes. A finished task whose
 * `completion_ready` signal has sat unacknowledged this long is force-completed
 * (after the grace window) to free its slot. Deliberately far under the strict
 * finishedAwaitingAck TTL reclaim (15m, #1884): that path is the slower,
 * open-PR-fail-safe-gated backstop; this one bounds the `awaiting_poll` dwell
 * that never reaches it.
 */
export const DEFAULT_FAA_ACK_REAP_DEADLINE_MS = 5 * 60_000;

/**
 * Floor for the ack-reaper deadline (minutes). 1 minute keeps the reaper from
 * racing an ack that is merely a poll-cadence away from landing while still
 * bounding the dwell to roughly one liveness window.
 */
export const MIN_FAA_ACK_REAP_DEADLINE_MIN = 1;

/**
 * Ceiling for the ack-reaper deadline (minutes). Capped at the strict FAA TTL
 * (15m, #1884) so this fast path can never be configured *slower* than the
 * backstop it front-runs — an operator override can only tighten the bound,
 * never restore the chronic hold this feature exists to eliminate.
 */
export const MAX_FAA_ACK_REAP_DEADLINE_MIN = 15;

/**
 * Default grace window (seconds) between the warning and the actual close.
 * Shorter than the hung reaper's 120s default: a finished task loses no work
 * when closed, so the reaction window only needs to let a present operator veto
 * or take the task over, not protect a long in-flight composition.
 */
export const DEFAULT_FAA_ACK_REAP_GRACE_SECONDS = 60;

/** Clamp a raw ack-reaper deadline (minutes) into the accepted range. */
export function clampFaaAckReapDeadlineMinutes(raw: number): number {
  return Math.max(
    MIN_FAA_ACK_REAP_DEADLINE_MIN,
    Math.min(MAX_FAA_ACK_REAP_DEADLINE_MIN, Math.round(raw)),
  );
}

/**
 * True when the task is (still) a finishedAwaitingAck close candidate: the
 * exact FAA capacity-class predicate (`classifyTaskCapacity` →
 * `'finishedAwaitingAck'`) — `inProgress` with a `completion_ready` pending
 * signal. Used by the maintenance pass to clear a grace warning the moment the
 * task is acked, completed, cancelled, or otherwise leaves FAA, so a countdown
 * banner never lingers on a task that already freed its slot.
 */
export function isFinishedAwaitingAckCloseCandidate(
  task: Pick<Task, 'status' | 'pendingSignal'>,
): boolean {
  return task.status === 'inProgress' && task.pendingSignal?.kind === 'completion_ready';
}
