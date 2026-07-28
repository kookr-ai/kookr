import type { Task } from './task-read-model.js';

/**
 * Pending-task TTL (issue #1526 Phase C / C3).
 *
 * The pending-queue depth limit bounds how much starving work can accumulate;
 * this TTL bounds how LONG any one entry can starve. A task that has sat in
 * `pending` past the TTL without ever launching is expired on the liveness
 * tick — cancelled (the existing `pending → cancelled` terminal transition,
 * the same one the promotion loop's failure path uses) with a structured
 * reason and an audit row (actor `system:pending-ttl`) — freeing queue depth
 * for callers that are still waiting on the 429 depth limit.
 *
 * Parented/chain tasks (`parentTaskId` set) get the SAME treatment: a
 * starving child of a live parent still expires. Documented in
 * docs/reference/backpressure.md — a chain that relies on a queued successor
 * must watch for the `cancelled` outcome and respawn.
 */

/** Default TTL — mirrors the `pendingTaskTtlMinutes` settings default (240m; range 15–2880). */
export const DEFAULT_PENDING_TASK_TTL_MS = 240 * 60_000;

export interface ExpiredPendingEntry {
  task: Task;
  /** How long the task has been queued (now − createdAt). */
  pendingForMs: number;
}

export interface ListExpiredPendingTasksOpts {
  now?: Date;
  ttlMs?: number;
  /**
   * Launch-reservation probe (`TaskStore.hasFreshLaunchReservation`). A
   * pending task a promoter has just reserved is mid-launch, not starving —
   * it must not be expired out from under the promoter.
   */
  hasFreshLaunchReservation?: (taskId: string) => boolean;
}

/**
 * Pure selection of pending tasks past the TTL. Age is measured from
 * `createdAt` — a task pends in the same call that creates it, and `createdAt`
 * is also the FIFO promotion key, so "oldest queued" and "longest starving"
 * agree. Boundary is inclusive: age >= ttl expires. Guards:
 *
 * - `sessions.length === 0`: only never-launched tasks. A pending task should
 *   always have zero sessions (a session attach flips it to inProgress), but
 *   persisted state from older versions is not trusted blindly.
 * - no fresh launch reservation: mid-promotion tasks are exempt.
 *
 * Returned oldest-first so expiry drains in the same order promotion would
 * have served.
 */
export function listExpiredPendingTasks(
  tasks: readonly Task[],
  opts: ListExpiredPendingTasksOpts = {},
): ExpiredPendingEntry[] {
  const nowMs = (opts.now ?? new Date()).getTime();
  const ttlMs = opts.ttlMs ?? DEFAULT_PENDING_TASK_TTL_MS;
  const out: ExpiredPendingEntry[] = [];
  for (const task of tasks) {
    if (task.status !== 'pending') continue;
    if (task.sessions.length > 0) continue;
    if (opts.hasFreshLaunchReservation?.(task.id)) continue;
    const pendingForMs = nowMs - task.createdAt.getTime();
    if (pendingForMs >= ttlMs) out.push({ task, pendingForMs });
  }
  return out.sort((a, b) => a.task.createdAt.getTime() - b.task.createdAt.getTime());
}
