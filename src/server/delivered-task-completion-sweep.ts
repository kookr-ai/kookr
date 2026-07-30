/**
 * Delivery-aware self-completion sweep (issue #1560).
 *
 * Runs on the liveness tick. For each running task whose PR is merged (delivery
 * attribution from `GitHubStateStore`) but which never raised a
 * `completion_ready` signal, once the post-merge cleanup budget is exceeded it:
 *   1. raises a `completion_ready` signal through the #1541 signal outbox
 *      (durable spool append + apply as `source: 'outbox'`), and
 *   2. runs the normal completion lifecycle via `completeTask`.
 *
 * There is no parallel completion surface — the signal rides the existing
 * outbox / `autoCloseOnSignal` machinery and the completion goes through the
 * same `completeTask` the auto-close sweep uses. Because the merged PR is
 * definitive delivery evidence (a stronger authorization than a lesson
 * decision), the raise is applied directly rather than through
 * `SignalOutboxService.deliverLocal`, which would drop it under the
 * lesson-decision gate (#1608) — a hung, delivered agent typically never
 * recorded a decision. The hung-task reaper stays the backstop: this fires
 * ~10-15 min after merge, the reaper only after hours.
 *
 * The budget clock starts when the sweep FIRST observes the merge (tracked in
 * memory, mirroring the auto-close throttle), so a just-delivered task always
 * gets one full budget window of cleanup before completion.
 */

import { completeTask, type LifecycleDeps } from './agent-lifecycle.js';
import { surfaceDirtyWorktreeOnHeadlessCompletion } from './dirty-worktree-completion-finding.js';
import { appendAuditRow } from '../core/audit-log.js';
import { nowISO } from '../core/interaction-log.js';
import {
  appendSignalOutbox,
  buildSignalOutboxEntry,
  removeSignalOutboxEntry,
} from '../core/signal-outbox.js';
import {
  DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS,
  buildDeliveredCompletionDigest,
  buildDeliveredCompletionNote,
  classifyDeliveredCompletion,
  type MergedPrAttribution,
} from '../core/delivered-task-completion.js';
import type { Task, TaskStore } from '../core/tasks.js';
import type { ServerMessage } from '../shared/contracts/messages.js';

/**
 * Max delivered tasks completed per sweep. Same rationale as the auto-close
 * per-batch cap: each completion tears down sessions and broadcasts a snapshot,
 * so draining a backlog is spread across ticks rather than done all at once.
 */
export const DEFAULT_MAX_DELIVERED_COMPLETE_PER_TICK = 2;

/** Minimum spacing between delivered-completion batches. Mirrors the auto-close sweep. */
export const DELIVERED_SWEEP_MIN_INTERVAL_MS = 60_000;

/** Actor stamped on the audit row + used for completion provenance. */
export const DELIVERED_AUTO_COMPLETE_ACTOR = 'system:delivered-auto-complete';

/**
 * Cross-tick state for the delivered-completion sweep. Created once per server
 * instance and passed on every tick: the `firstObservedMergedAt` map is the
 * budget clock, and `lastSweepAt` throttles batches. Omitting it (tests)
 * disables throttling and starts every task's clock fresh each call.
 */
export class DeliveredCompletionTracker {
  private readonly firstObservedMergedAt = new Map<string, number>();
  lastSweepAt = 0;

  /** Record (once) and return the ms at which this task's merge was first seen. */
  observe(taskId: string, nowMs: number): number {
    const existing = this.firstObservedMergedAt.get(taskId);
    if (existing !== undefined) return existing;
    this.firstObservedMergedAt.set(taskId, nowMs);
    return nowMs;
  }

  /** Drop a task's observation (no longer merged, terminal, or completed). */
  forget(taskId: string): void {
    this.firstObservedMergedAt.delete(taskId);
  }
}

export function createDeliveredCompletionTracker(): DeliveredCompletionTracker {
  return new DeliveredCompletionTracker();
}

export interface AutoCompleteDeliveredDeps {
  taskStore: TaskStore;
  /** Lifecycle context threaded to `completeTask` (session teardown, cleanup, claims). */
  lifecycleDeps: LifecycleDeps;
  /**
   * Delivery attribution: a task's attributable merged PR, or null. Production
   * reads `GitHubStateStore` (a tracked PR reference whose fetched status is
   * `merged`); tests inject a fake.
   */
  resolveMergedPr: (task: Task) => MergedPrAttribution | null;
  /**
   * Issue #1667: true when the agent is provider-paused (billing/quota). The
   * pure classifier refuses auto-complete in that case so a pause is never
   * treated as post-merge cleanup hang. Production reads recent agent events
   * (+ pane text); tests inject a fake. Optional — omit → never paused.
   */
  isProviderPaused?: (task: Task) => boolean;
  /** Cross-tick budget-clock + throttle state (created once per server). */
  tracker: DeliveredCompletionTracker;
  /**
   * Durable signal-outbox spool dir (#1541). When set, the raised
   * `completion_ready` is appended before it is applied and removed after, so a
   * crash mid-raise replays on restart. Omit to skip the durable write.
   */
  signalOutboxSpoolDir?: string;
  /** Mirrors the outbox drain's onTaskOutcome so chain supervisors observe the signal. */
  onTaskOutcome?: (taskId: string, outcome: { kind: 'completion_ready'; note?: string }) => void;
  auditLogPath?: string;
  broadcastToAll?: (msg: ServerMessage) => void;
  now?: () => Date;
}

export interface AutoCompleteDeliveredOptions {
  budgetMs?: number;
  maxPerTick?: number;
  minIntervalMs?: number;
  /** When true, apply the `lastSweepAt` throttle on `deps.tracker`. */
  throttle?: boolean;
}

export interface AutoCompleteDeliveredResult {
  completedTaskIds: string[];
}

/**
 * Raise a `completion_ready` signal through the #1541 outbox and apply it.
 *
 * Deliberately bypasses the lesson-decision gate (see module header): a merged
 * PR authorizes completion. The spool append/remove is the durable record; the
 * `setPendingSignal({ source: 'outbox' })` is what the completion lifecycle
 * reads to stamp `completionPath: 'outbox_drained'`.
 */
async function raiseCompletionReadyViaOutbox(opts: {
  taskStore: TaskStore;
  spoolDir?: string;
  taskId: string;
  note: string;
  now: Date;
  onTaskOutcome?: AutoCompleteDeliveredDeps['onTaskOutcome'];
}): Promise<void> {
  const entry = buildSignalOutboxEntry({
    taskId: opts.taskId,
    kind: 'completion_ready',
    note: opts.note,
    createdAt: opts.now.toISOString(),
  });

  if (opts.spoolDir) {
    await appendSignalOutbox(opts.spoolDir, entry, { now: opts.now });
  }

  opts.taskStore.setPendingSignal(opts.taskId, {
    kind: 'completion_ready',
    raisedAt: opts.now.toISOString(),
    note: opts.note,
    signalId: entry.signalId,
    source: 'outbox',
  });

  if (opts.spoolDir) {
    // Applied in-process → the entry is delivered; drop it so the periodic
    // SignalOutboxService drain never re-touches it (and never re-gates it).
    await removeSignalOutboxEntry(opts.spoolDir, entry.signalId);
  }

  try {
    opts.onTaskOutcome?.(opts.taskId, { kind: 'completion_ready', note: opts.note });
  } catch {
    // onTaskOutcome is best-effort observability; never block completion.
  }
}

async function recordDeliveredAutoComplete(
  deps: AutoCompleteDeliveredDeps,
  task: Task,
  merged: MergedPrAttribution,
  elapsedSinceMergeMs: number,
  budgetMs: number,
): Promise<void> {
  await appendAuditRow(deps.auditLogPath, {
    type: 'task.deliveredAutoComplete',
    timestamp: nowISO(),
    actor: DELIVERED_AUTO_COMPLETE_ACTOR,
    taskId: task.id,
    prNumber: merged.prNumber,
    ...(merged.prUrl ? { prUrl: merged.prUrl } : {}),
    elapsedSinceMergeMs,
    budgetMs,
  });
  deps.broadcastToAll?.({
    type: 'alert',
    agentId: task.sessions[task.sessions.length - 1]?.tmuxSession ?? '',
    summary: `Auto-completed on delivery: ${task.name ?? 'Task'}`,
    details:
      `PR #${merged.prNumber} merged; post-merge cleanup exceeded the `
      + `${Math.round(budgetMs / 60_000)}m budget — completed automatically to free the slot.`,
    severity: 'info',
  });
}

/**
 * Complete running tasks whose PR merged once post-merge cleanup exceeds the
 * budget. See module header. Returns the ids completed this tick.
 */
export async function autoCompleteDeliveredTasks(
  deps: AutoCompleteDeliveredDeps,
  opts: AutoCompleteDeliveredOptions = {},
): Promise<AutoCompleteDeliveredResult> {
  const completedTaskIds: string[] = [];
  const now = deps.now?.() ?? new Date();
  const nowMs = now.getTime();
  const budgetMs = opts.budgetMs ?? DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS;
  const tracker = deps.tracker;

  if (opts.throttle) {
    const minIntervalMs = opts.minIntervalMs ?? DELIVERED_SWEEP_MIN_INTERVAL_MS;
    if (nowMs - tracker.lastSweepAt < minIntervalMs) return { completedTaskIds };
    tracker.lastSweepAt = nowMs;
  }

  const maxPerTick = opts.maxPerTick ?? DEFAULT_MAX_DELIVERED_COMPLETE_PER_TICK;
  let completedThisTick = 0;

  for (const task of deps.taskStore.listTasks()) {
    // A non-running task can never be delivered-completed here; forget its clock.
    if (task.status !== 'inProgress') {
      tracker.forget(task.id);
      continue;
    }

    const merged = deps.resolveMergedPr(task);
    if (!merged) {
      // Merge attribution gone (or never present) → reset the budget clock so a
      // later re-merge starts a fresh window rather than an already-elapsed one.
      tracker.forget(task.id);
      continue;
    }

    const firstObservedMergedAtMs = tracker.observe(task.id, nowMs);
    const providerPaused = deps.isProviderPaused?.(task) === true;
    const decision = classifyDeliveredCompletion(task, merged, {
      now,
      firstObservedMergedAtMs,
      budgetMs,
      providerPaused,
    });
    if (!decision.autoComplete) continue;

    // Per-batch cap: leave the rest for the next tick (drains a backlog gently).
    if (completedThisTick >= maxPerTick) break;
    completedThisTick += 1;

    const note = buildDeliveredCompletionNote(merged.prNumber, budgetMs);
    try {
      await raiseCompletionReadyViaOutbox({
        taskStore: deps.taskStore,
        spoolDir: deps.signalOutboxSpoolDir,
        taskId: task.id,
        note,
        now,
        onTaskOutcome: deps.onTaskOutcome,
      });
      // Same headless-completion visibility guard as the auto-close sweep
      // (issue #1580): surface a finding if the delivered task still holds
      // uncommitted work, so a dirty worktree is never discarded/kept silently.
      await surfaceDirtyWorktreeOnHeadlessCompletion(task, {
        taskStore: deps.taskStore,
        auditLogPath: deps.auditLogPath,
        broadcastToAll: deps.broadcastToAll,
      });
      await completeTask(task.id, deps.lifecycleDeps, {
        actorSource: DELIVERED_AUTO_COMPLETE_ACTOR,
      });
      deps.taskStore.setCompletionDigest(task.id, buildDeliveredCompletionDigest(merged, budgetMs));
      deps.taskStore.clearPendingSignal(task.id);
      tracker.forget(task.id);
      completedTaskIds.push(task.id);
      await recordDeliveredAutoComplete(deps, task, merged, decision.elapsedSinceMergeMs ?? 0, budgetMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[delivered-complete] auto-complete failed for task ${task.id}: ${message}`);
      // Idempotency backstop: if the task did reach terminal despite the throw,
      // clear the pending signal and stop tracking it so we never re-fire.
      if (deps.taskStore.getTask(task.id)?.status === 'completed') {
        deps.taskStore.clearPendingSignal(task.id);
        tracker.forget(task.id);
      }
    }
  }

  return { completedTaskIds };
}
