import type { Task, TaskStore } from '../core/tasks.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { completeTask, type LifecycleDeps } from './agent-lifecycle.js';
import { surfaceDirtyWorktreeOnHeadlessCompletion } from './dirty-worktree-completion-finding.js';
import { appendAuditRow } from '../core/audit-log.js';
import { nowISO } from '../core/interaction-log.js';
import {
  DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS,
  listStaleCompletionReadyTasks,
} from '../core/completion-ready-cleanup.js';

export interface AutoCloseStaleCompletionReadyDeps {
  taskStore: TaskStore;
  lifecycleDeps?: LifecycleDeps;
  /** Path to the shared audit.jsonl log. TTL escalations write a row here; immediate (opted-in) closes do not. */
  auditLogPath?: string;
  /** Optional broadcast for the TTL-escalation alert (issue #1526 Phase A) — reuses the existing 'alert' channel, no new notification surface. */
  broadcastToAll?: (msg: ServerMessage) => void;
  /**
   * Issue #1667: skip auto-closing tasks whose agent is provider-paused
   * (billing/quota). Optional — omit → no pause filtering (legacy tests).
   */
  isProviderPaused?: (task: Task) => boolean;
}

export interface AutoCloseStaleCompletionReadyResult {
  closedTaskIds: string[];
}

/**
 * Cap on how many completion-ready tasks this function will auto-close per
 * BATCH (issue #1526 Phase A). The incident this guards against: 11
 * simultaneous session teardowns each broadcast a multi-MB websocket
 * snapshot on an already-loaded server, which re-triggers the overload that
 * caused the original wedge. Draining oldest-first (entries are sorted by
 * signal age) across successive batches keeps teardown load flat.
 */
export const DEFAULT_MAX_AUTO_CLOSE_PER_TICK = 2;

/**
 * Minimum spacing between auto-close BATCHES (issue #1526 Phase A). This
 * function is invoked from the liveness tick, which runs every 5s in
 * production (`livenessIntervalMs`) — without this throttle, "max 2 per
 * tick" would still drain 11 tasks in ~30s (~22 multi-MB teardown broadcasts
 * in half a minute), on the exact server whose overload caused the incident.
 * With this throttle, 11 tasks drain over ~6 minutes (2 every 60s) instead —
 * comfortably inside the ≤2h drain bound while actually spreading the load.
 */
export const AUTO_CLOSE_SWEEP_MIN_INTERVAL_MS = 60_000;

/**
 * Mutable cross-tick state for the sweep throttle above. Callers that want
 * throttling create ONE of these per server instance (e.g. once in
 * `startLifecycleTimers`) and pass the SAME object on every tick; omitting it
 * disables throttling (only the per-batch cap applies) — used by tests that
 * don't care about batch spacing.
 */
export interface AutoCloseSweepThrottle {
  lastSweepAt: number;
}

export function createAutoCloseSweepThrottle(): AutoCloseSweepThrottle {
  return { lastSweepAt: 0 };
}

export async function autoCloseStaleCompletionReadyTasks(
  deps: AutoCloseStaleCompletionReadyDeps,
  opts: {
    now?: Date;
    thresholdMs?: number;
    ttlMs?: number;
    maxPerTick?: number;
    throttle?: AutoCloseSweepThrottle;
    minIntervalMs?: number;
  } = {},
): Promise<AutoCloseStaleCompletionReadyResult> {
  const closedTaskIds: string[] = [];
  const lifecycleDeps = deps.lifecycleDeps;
  if (!lifecycleDeps) return { closedTaskIds };

  const nowMs = (opts.now ?? new Date()).getTime();
  if (opts.throttle) {
    const minIntervalMs = opts.minIntervalMs ?? AUTO_CLOSE_SWEEP_MIN_INTERVAL_MS;
    if (nowMs - opts.throttle.lastSweepAt < minIntervalMs) return { closedTaskIds };
    opts.throttle.lastSweepAt = nowMs;
  }

  const entries = listStaleCompletionReadyTasks(deps.taskStore.listTasks(), {
    now: opts.now,
    thresholdMs: opts.thresholdMs ?? DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS,
    ...(deps.isProviderPaused ? { isProviderPaused: deps.isProviderPaused } : {}),
    ttlMs: opts.ttlMs,
  })
    .filter((entry) => entry.canAutoClose && !isActiveRalphLoop(entry.task))
    .slice(0, opts.maxPerTick ?? DEFAULT_MAX_AUTO_CLOSE_PER_TICK);

  for (const entry of entries) {
    const taskId = entry.task.id;
    try {
      // Headless completion bypasses the interactive dialog's dirty-worktree
      // verdict, so surface a finding first when the worktree holds
      // uncommitted work (issue #1580). Inspection runs before the transition,
      // while the task still owns the worktree, and never throws.
      await surfaceDirtyWorktreeOnHeadlessCompletion(entry.task, {
        taskStore: deps.taskStore,
        auditLogPath: deps.auditLogPath,
        broadcastToAll: deps.broadcastToAll,
      });
      await completeTask(taskId, lifecycleDeps);
      deps.taskStore.clearPendingSignal(taskId);
      closedTaskIds.push(taskId);
      if (entry.closeReason === 'ttl_escalation') {
        await recordTtlEscalation(entry, deps);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[completion-ready] auto-close failed for task ${taskId}: ${message}`);
      if (deps.taskStore.getTask(taskId)?.status === 'completed') {
        deps.taskStore.clearPendingSignal(taskId);
      }
    }
  }

  return { closedTaskIds };
}

/**
 * Audit + notify a TTL-escalated close (issue #1526 Phase A / FM5). This is
 * the ONLY branch that writes an audit row and broadcasts an alert — an
 * opted-in (`autoCloseOnSignal: true`) close keeps its prior silent behavior,
 * since the operator already asked for exactly that.
 */
async function recordTtlEscalation(
  entry: { task: Task; signal: NonNullable<Task['pendingSignal']>; ageMs: number },
  deps: AutoCloseStaleCompletionReadyDeps,
): Promise<void> {
  const { task, signal, ageMs } = entry;
  await appendAuditRow(deps.auditLogPath, {
    type: 'task.completionReadyTtlEscalation',
    timestamp: nowISO(),
    actor: 'system:completion-ready-ttl',
    taskId: task.id,
    signalRaisedAt: signal.raisedAt,
    ageMs,
  });
  deps.broadcastToAll?.({
    type: 'alert',
    agentId: task.sessions[task.sessions.length - 1]?.tmuxSession ?? '',
    summary: `Auto-closed after TTL: ${task.name ?? 'Task'}`,
    details: `completion_ready pending ${Math.round(ageMs / 60_000)}m with no manual review — closed automatically to free the slot.`,
    severity: 'info',
  });
}

function isActiveRalphLoop(task: Task): boolean {
  return task.ralphLoop?.status === 'running' || task.ralphLoop?.status === 'paused';
}
