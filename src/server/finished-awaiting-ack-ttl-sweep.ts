import type { Task, TaskStore } from '../core/tasks.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { completeTask, type LifecycleDeps } from './agent-lifecycle.js';
import { listExpiredFinishedAwaitingAckTasks } from '../core/finished-awaiting-ack-ttl.js';
import { appendAuditRow } from '../core/audit-log.js';
import { nowISO } from '../core/interaction-log.js';

/** In-memory snapshot for the `/metrics` gauge (issue #1884). */
export interface FinishedAwaitingAckTtlReclaimMetricsSnapshot {
  /** Cumulative finishedAwaitingAck tasks force-completed by the TTL reclaim since process start. */
  reclaimedTotal: number;
}

/**
 * Minimal process-lifetime counter for the finishedAwaitingAck TTL reclaim
 * (issue #1884). Mirrors the existing `NonCriticalTimerPauseGate` /
 * `SnapshotShedMetrics` counters — a single instance is created once at
 * bootstrap, threaded into the sweep (which calls {@link recordReclaimed}) and
 * into `/metrics` (which reads {@link getSnapshot}).
 */
export class FinishedAwaitingAckTtlReclaimMetrics {
  private reclaimedTotal = 0;

  recordReclaimed(count: number): void {
    if (count > 0) this.reclaimedTotal += count;
  }

  getSnapshot(): FinishedAwaitingAckTtlReclaimMetricsSnapshot {
    return { reclaimedTotal: this.reclaimedTotal };
  }
}

export interface ReclaimFinishedAwaitingAckTasksDeps {
  taskStore: TaskStore;
  /** Optional lifecycle context — required for the force-complete to actually run; absent ⇒ no-op. */
  lifecycleDeps?: LifecycleDeps;
  /** Path to the shared audit.jsonl log — every reclaim writes a `system:finished-awaiting-ack-ttl` row. */
  auditLogPath?: string;
  /** Optional broadcast for the sweep-summary alert — reuses the existing 'alert' channel. */
  broadcastToAll?: (msg: ServerMessage) => void;
  /**
   * Stranded-PR / `merge_required` exemption predicate (issue #1884) — see
   * `core/finished-awaiting-ack-ttl.ts` for the fail-safe contract. Omitted ⇒
   * every candidate is treated as a possible PR hold and left alone.
   */
  isHoldingOpenPr?: (task: Task) => boolean | undefined;
  /** Optional counter, incremented once per sweep by the reclaimed count. */
  metrics?: Pick<FinishedAwaitingAckTtlReclaimMetrics, 'recordReclaimed'>;
}

export interface ReclaimFinishedAwaitingAckTasksResult {
  reclaimedTaskIds: string[];
}

/**
 * Reclaim finishedAwaitingAck tasks past the TTL (issue #1884). Runs on the
 * liveness tick, after the pending-task TTL sweep. Each reclaimed task is
 * force-completed through the existing `completeTask` transition — the same
 * one manual acks and the completion-ready auto-close sweep use — with:
 *
 * - reason `finished_awaiting_ack_ttl` on the interaction-log `task_completed`
 *   row, so an autonomous slot reclaim is distinguishable from a manual ack;
 * - an `audit.jsonl` row, actor `system:finished-awaiting-ack-ttl` (the
 *   convention `system:pending-ttl` / `system:completion-ready-ttl` established);
 * - `taskStore.clearPendingSignal` so the (now completed) task no longer
 *   reports a stale `completion_ready` signal.
 *
 * Force-complete, not cancel — cancelling a task that already finished its
 * work would inflate `cancelled_delta` noise for no benefit (lucy #1995
 * lesson). The stranded-PR exemption in `listExpiredFinishedAwaitingAckTasks`
 * is what actually protects an in-flight `merge_required` delivery; this
 * function only executes what that selector already cleared.
 *
 * One summary alert per sweep (not per task), matching `expirePendingTasks`.
 */
export async function reclaimAgedFinishedAwaitingAckTasks(
  deps: ReclaimFinishedAwaitingAckTasksDeps,
  opts: { now?: Date; ttlMs?: number } = {},
): Promise<ReclaimFinishedAwaitingAckTasksResult> {
  const lifecycleDeps = deps.lifecycleDeps;
  if (!lifecycleDeps) return { reclaimedTaskIds: [] };

  const now = opts.now ?? new Date();
  const entries = listExpiredFinishedAwaitingAckTasks(deps.taskStore.listTasks(), {
    now,
    ttlMs: opts.ttlMs,
    isHoldingOpenPr: deps.isHoldingOpenPr,
  });

  const reclaimedTaskIds: string[] = [];
  for (const { task, ageMs } of entries) {
    try {
      await completeTask(task.id, lifecycleDeps, { interactionLogReason: 'finished_awaiting_ack_ttl' });
    } catch (err) {
      // Raced a manual ack or another terminal transition — skip; the task is
      // no longer (only) finishedAwaitingAck, so it is somebody else's to finish.
      console.warn(
        `[finished-awaiting-ack-ttl] could not reclaim task ${task.id}:`,
        err instanceof Error ? err.message : err,
      );
      continue;
    }
    deps.taskStore.clearPendingSignal(task.id);
    reclaimedTaskIds.push(task.id);
    console.warn(
      `[finished-awaiting-ack-ttl] reclaimed task ${task.id} — finishedAwaitingAck ${Math.round(ageMs / 60_000)}m unacknowledged`,
    );

    await appendAuditRow(deps.auditLogPath, {
      type: 'task.finishedAwaitingAckTtlReclaimed',
      timestamp: nowISO(),
      actor: 'system:finished-awaiting-ack-ttl',
      taskId: task.id,
      reason: 'finished_awaiting_ack_ttl',
      ageMs,
      ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
    });
  }

  deps.metrics?.recordReclaimed(reclaimedTaskIds.length);

  if (reclaimedTaskIds.length > 0) {
    deps.broadcastToAll?.({
      type: 'alert',
      agentId: '',
      summary: `Reclaimed ${reclaimedTaskIds.length} finishedAwaitingAck task(s) (TTL)`,
      details:
        'These tasks finished their work and signalled completion_ready, but sat unacknowledged past ' +
        'finishedAwaitingAckTtlMinutes and were force-completed to free the active concurrency slot. ' +
        'Review the completed task if manual follow-up is still needed.',
      severity: 'warning',
    });
  }

  return { reclaimedTaskIds };
}
