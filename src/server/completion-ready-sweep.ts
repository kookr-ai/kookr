import type { Task, TaskStore } from '../core/tasks.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { completeTask, type LifecycleDeps } from './agent-lifecycle.js';
import { surfaceDirtyWorktreeOnHeadlessCompletion } from './dirty-worktree-completion-finding.js';
import { appendAuditRow } from '../core/audit-log.js';
import { nowISO } from '../core/interaction-log.js';
import {
  DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS,
  selectAutoClosableCompletionReadyTasks,
} from '../core/completion/index.js';
import { evaluateLiveWorkVeto, liveWorkVetoReasonText } from './live-work-veto.js';

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
  /**
   * Live-human veto inputs (parity with the finished-awaiting-ack reapers).
   * Age-only selection can pick a task that has since resumed its turn, has a
   * human mid-keystroke in the composer, is attached in the dashboard, or is
   * holding an open delivery PR. All optional — omitted ⇒ that signal never
   * vetoes (legacy callers/tests keep their age-only behaviour).
   */
  /** Latest reconstructed pane text for the task's live session (TOCTOU tail veto). May be async. */
  getTaskPaneText?: (
    taskId: string,
  ) => string | undefined | null | Promise<string | undefined | null>;
  /** True when a viewer connection currently has the task selected/attached. */
  isTaskSelectedByAnyConnection?: (taskId: string) => boolean;
  /** Confirmed-open delivery-PR hold — only a definite `true` vetoes the close. */
  isHoldingOpenPr?: (task: Task) => boolean | undefined;
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

  // The per-tick cap bounds TEARDOWNS, not selection attempts: select every
  // eligible task (oldest signal first) and stop after `maxCloses` ACTUAL
  // closes below. Slicing to the cap in selection — as this used to — let
  // live-human-vetoed tasks burn the batch so a genuinely drainable task
  // behind two perpetually-attended older ones never drained (head-of-line
  // starvation). Counting closes keeps the #1526 teardown-storm throttle
  // (≤ maxCloses teardown broadcasts per tick) while never letting a deferral
  // consume a drain slot.
  const maxCloses = opts.maxPerTick ?? DEFAULT_MAX_AUTO_CLOSE_PER_TICK;
  const entries = selectAutoClosableCompletionReadyTasks(deps.taskStore.listTasks(), {
    now: opts.now,
    thresholdMs: opts.thresholdMs ?? DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS,
    ttlMs: opts.ttlMs,
    ...(deps.isProviderPaused ? { isProviderPaused: deps.isProviderPaused } : {}),
    excludeActiveRalph: true,
  });

  for (const entry of entries) {
    if (closedTaskIds.length >= maxCloses) break;
    const taskId = entry.task.id;
    try {
      // TOCTOU re-GET + live-human veto (parity with the finished-awaiting-ack
      // TTL/ack reapers; issues #2170 / #2238 / #3040). Selection is age-only:
      // between selection and teardown a quiet task can resume its turn, show a
      // human composer / permission dialog, be attached in the dashboard, or
      // grow a confirmed-open PR. Closing then tears a live session down out
      // from under a present human (the completion-ready-ttl drain valve did
      // exactly this to a session whose operator was mid-keystroke). Defer
      // instead — a genuinely idle task re-selects next tick and drains then,
      // while an attended one holds only its OWN slot until the human detaches.
      const fresh = deps.taskStore.getTask(taskId);
      if (
        !fresh
        || fresh.status !== 'inProgress'
        || fresh.pendingSignal?.kind !== 'completion_ready'
      ) {
        // Acked / dismissed / transitioned since selection — no longer ours to close.
        continue;
      }
      // Cheap synchronous vetoes first (live turn / viewer attached / open PR);
      // only read the live pane — the one async, per-task cost — for a task
      // that still looks drainable after those. The captured pane of the
      // incident that motivated this guard classified as `unknown` while the
      // human was mid-keystroke, so the pane check is a backstop, not the
      // primary signal — viewer-attached is.
      let veto = evaluateLiveWorkVeto(fresh, {
        present: deps.isTaskSelectedByAnyConnection?.(taskId) ?? false,
        holdingOpenPr: deps.isHoldingOpenPr?.(fresh),
      });
      if (!veto.veto && deps.getTaskPaneText) {
        const paneText = await deps.getTaskPaneText(taskId);
        veto = evaluateLiveWorkVeto(fresh, {
          paneText,
          present: deps.isTaskSelectedByAnyConnection?.(taskId) ?? false,
          holdingOpenPr: deps.isHoldingOpenPr?.(fresh),
        });
      }
      if (veto.veto) {
        console.warn(
          `[completion-ready-ttl] deferred task ${taskId} — ${liveWorkVetoReasonText(veto.reason)}`
            + ` (completion_ready ${Math.round(entry.ageMs / 60_000)}m; slot held, not closed)`,
        );
        continue;
      }

      // Headless completion bypasses the interactive dialog's dirty-worktree
      // verdict, so surface a finding first when the worktree holds
      // uncommitted work (issue #1580). Inspection runs before the transition,
      // while the task still owns the worktree, and never throws.
      await surfaceDirtyWorktreeOnHeadlessCompletion(fresh, {
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

