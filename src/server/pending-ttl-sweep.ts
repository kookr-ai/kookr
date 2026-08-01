import type { TaskStore } from '../core/tasks.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { LifecycleDeps } from './agent-lifecycle.js';
import { listExpiredPendingTasks } from '../core/pending-task-ttl.js';
import { appendAuditRow } from '../core/audit-log.js';
import { nowISO } from '../core/interaction-log.js';

export interface ExpirePendingTasksDeps {
  taskStore: TaskStore;
  /** Optional lifecycle context — supplies queue purge, claim release, interaction log, and onTaskOutcome. */
  lifecycleDeps?: LifecycleDeps;
  /** Path to the shared audit.jsonl log — every expiry writes a `system:pending-ttl` row. */
  auditLogPath?: string;
  /** Optional broadcast for the sweep-summary alert — reuses the existing 'alert' channel. */
  broadcastToAll?: (msg: ServerMessage) => void;
}

export interface ExpirePendingTasksResult {
  expiredTaskIds: string[];
}

/**
 * Expire pending tasks past the TTL (issue #1526 Phase C / C3). Runs on the
 * liveness tick. Each expired task is cancelled through the existing
 * `pending → cancelled` transition — the same terminal status the promotion
 * loop's failure path uses — with:
 *
 * - an interaction-log `task_cancelled` row, reason `pending_ttl_expired`
 *   (structured reason; NOT `user_cancelled` — nobody clicked anything);
 * - an `audit.jsonl` row, actor `system:pending-ttl` (the convention Phase A's
 *   `system:completion-ready-ttl` / `system:hung-task-reaper` established);
 * - issue-claim release + attention-queue purge (a pending task holds no
 *   sessions, leases, or worktrees, so the full lifecycle cancel is not
 *   needed);
 * - `onTaskOutcome(id, { kind: 'cancelled' })` so chain supervisors observe
 *   the drop.
 *
 * One summary alert per sweep (not per task) keeps a full-queue expiry from
 * flooding the alert channel. No per-tick cap: expiring a pending task tears
 * down no session and broadcasts nothing per-task, so even a maximal sweep
 * (200 tasks) is cheap — unlike the completion-ready drain this deliberately
 * does not throttle.
 */
export async function expirePendingTasks(
  deps: ExpirePendingTasksDeps,
  opts: { now?: Date; ttlMs?: number } = {},
): Promise<ExpirePendingTasksResult> {
  const now = opts.now ?? new Date();
  const entries = listExpiredPendingTasks(deps.taskStore.listTasks(), {
    now,
    ttlMs: opts.ttlMs,
    hasFreshLaunchReservation: (id) => deps.taskStore.hasFreshLaunchReservation(id),
  });

  const expiredTaskIds: string[] = [];
  for (const { task, pendingForMs } of entries) {
    try {
      deps.taskStore.cancelTask(task.id);
    } catch (err) {
      // Raced a promoter or a user cancel — skip; the task is no longer
      // (only) pending, so it is somebody else's to finish.
      console.warn(
        `[pending-ttl] could not expire task ${task.id}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    expiredTaskIds.push(task.id);
    console.warn(
      `[pending-ttl] expired pending task ${task.id} — queued ${Math.round(pendingForMs / 60_000)}m without launching`,
    );

    deps.lifecycleDeps?.queue?.purgeTask(task.id);
    deps.lifecycleDeps?.issueClaimRegistry?.safeReleaseAllFor(task.id, 'released');
    try {
      deps.lifecycleDeps?.onTaskOutcome?.(task.id, { kind: 'cancelled' });
    } catch (err) {
      console.warn('[pending-ttl] onTaskOutcome threw:', err);
    }

    await deps.lifecycleDeps?.interactionLog?.append({
      type: 'task_cancelled',
      taskId: task.id,
      agentId: '',
      reason: 'pending_ttl_expired',
      durationMs: pendingForMs,
      timestamp: nowISO(),
    });
    await appendAuditRow(deps.auditLogPath, {
      type: 'task.pendingTtlExpired',
      timestamp: nowISO(),
      actor: 'system:pending-ttl',
      taskId: task.id,
      pendingForMs,
      ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
      ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    });
  }

  if (expiredTaskIds.length > 0) {
    deps.broadcastToAll?.({
      type: 'alert',
      agentId: '',
      summary: `Expired ${expiredTaskIds.length} pending task(s) (TTL)`,
      details:
        'These tasks waited in the pending queue past pendingTaskTtlMinutes without ever launching ' +
        'and were cancelled to free queue depth. Relaunch any that are still wanted.',
      severity: 'warning',
    });
  }

  return { expiredTaskIds };
}
