import { appendFile, mkdir, rm, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentActivityMeta, AgentEvent } from '../../core/types.js';
import type { Monitor } from '../../core/monitor.js';
import type { Task, TaskCompletionFeedback, TaskStore } from '../../core/tasks.js';
import { InvalidTransitionError } from '../../core/tasks.js';
import { isTerminalStatus } from '../../core/task-status.js';
import { redactSecrets } from '../../core/redact-secrets.js';
import type { DeferredInteractionLogWriter } from '../../core/interaction-log.js';
import { nowISO } from '../../core/interaction-log.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import type { LaunchOpts, LaunchResult } from '../launch-service.js';
import type { ScheduleService } from '../schedule-service.js';
import type { RalphLoopService } from '../ralph-loop-service.js';
import type { LifecycleDeps } from '../agent-lifecycle.js';
import {
  cleanupSessionResources,
  completeTask as completeTaskImpl,
  cancelTask as cancelTaskImpl,
} from '../agent-lifecycle.js';
import { buildTaskCompletionMetadata } from '../completion-metadata.js';
import { getSnapshotAgentsForClient } from './get-snapshot.js';
import { deleteTask, type DeleteTaskDeps } from './delete-task.js';
import { writeFeedbackBundle } from './write-feedback-bundle.js';
import { writeTaskSnapshotBundle } from './write-task-snapshot-bundle.js';
import { requestTaskReflect } from './request-task-reflect.js';

type RuntimeLifecycleDeps = LifecycleDeps & DeleteTaskDeps;

export interface TaskLifecycleCommandDeps {
  taskStore: TaskStore;
  monitor: Monitor;
  interactionLog?: DeferredInteractionLogWriter;
  scheduleService?: Pick<ScheduleService, 'recordTaskTerminalOutcome'>;
  ralphLoopService?: Pick<RalphLoopService, 'cancelLoop'>;
  launchTask?: (opts: LaunchOpts) => Promise<LaunchResult>;
  broadcastToAll?: (msg: ServerMessage) => void;
  activityMetaProvider?: { getActivityMeta(kookrSessionId: string): AgentActivityMeta | undefined };
  takePredeleteSnapshot?: () => Promise<void>;
  getLifecycleDeps: () => RuntimeLifecycleDeps;
  tryPromotePending?: () => Promise<void>;
  feedbackDir?: string;
  taskSnapshotDir?: string;
  reflectWorktreesDir?: string;
  hooksDir?: string;
  auditLogPath?: string;
  readInteractionLogSnapshot?: () => Promise<import('../../core/interaction-log.js').InteractionEvent[]>;
}

export interface TaskDeletionAuditActor {
  source: 'websocket' | 'api' | 'unknown';
  actorId?: string;
}

interface TaskDeletionAuditOpts {
  actor?: TaskDeletionAuditActor;
}

interface TaskDeletionAuditRecord {
  action: 'deleteTask' | 'clearCompleted';
  actor?: TaskDeletionAuditActor;
  projectId?: string;
  includeTerminated?: boolean;
  count: number;
  deletedTaskIds: string[];
  targetTaskId?: string;
  outcome: 'deleted' | 'not_found' | 'cleared' | 'invalid_scope' | 'snapshot_failed';
}

type TaskDeletionAuditRow = {
  type: 'task.deleteTask' | 'task.clearCompleted';
  timestamp: string;
  actor: TaskDeletionAuditActor;
  scope: { kind: 'project'; projectId: string } | { kind: 'all' };
  count: number;
  deletedTaskIds: string[];
  outcome: TaskDeletionAuditRecord['outcome'];
  taskId?: string;
  includeTerminated?: boolean;
};

type BatchAbortAuditRow = {
  type: 'task.batchAbort';
  timestamp: string;
  actor: TaskDeletionAuditActor;
  reason?: string;
  count: number;
  abortedTaskIds: string[];
  summary: BatchAbortSummary;
  results: Array<{ taskId: string; outcome: BatchAbortTaskOutcome }>;
};

export type TaskLifecycleCommandResult =
  | { outcome: 'completed'; task: Task }
  | { outcome: 'already_terminal'; task: Task }
  | { outcome: 'partial_ralph_completion'; task: Task }
  | { outcome: 'cancelled'; task: Task }
  | { outcome: 'reopened'; task: Task }
  | { outcome: 'deleted' }
  | { outcome: 'cleared'; deletedTaskIds: string[] }
  | { outcome: 'not_found'; error: string }
  | { outcome: 'invalid'; code: string; error: string }
  | { outcome: 'snapshot_failed'; error: string };

const MAX_ABORT_REASON_LENGTH = 500;

/** Per-task outcome of a batch-abort request. Retries are idempotent: a task
 * that is already terminal (or missing) reports `already_terminal`/`not_found`
 * without a second state transition. */
export type BatchAbortTaskOutcome = 'aborted' | 'already_terminal' | 'not_found' | 'failed';

export interface BatchAbortTaskResult {
  taskId: string;
  outcome: BatchAbortTaskOutcome;
  /** Terminal status the task converged to (present for aborted / already_terminal). */
  status?: Task['status'];
  /** Failure detail for `failed` outcomes. */
  error?: string;
}

export interface BatchAbortSummary {
  /** Unique task IDs considered (after trimming + dedup). */
  total: number;
  aborted: number;
  already_terminal: number;
  not_found: number;
  failed: number;
}

export interface BatchAbortResult {
  results: BatchAbortTaskResult[];
  summary: BatchAbortSummary;
}

export class TaskLifecycleCommands {
  constructor(private readonly deps: TaskLifecycleCommandDeps) {}

  /**
   * Mark a task complete (issue #691; actor attribution added issue #1526
   * Phase B / FM12 — this is the exact call a supervisor needed and lacked
   * during the 2026-07-24 deadlock). Every outcome — including no-ops like
   * `already_terminal`/`not_found` — is audited when `auditLogPath` is
   * configured, mirroring `deleteTask`'s unconditional audit below: knowing
   * a supervisor *attempted* a no-op call is itself useful forensics.
   */
  async completeTask(
    taskId: string,
    opts: {
      feedback?: TaskCompletionFeedback;
      requestReflect?: boolean;
      cleanupWorktree?: boolean;
    } & TaskDeletionAuditOpts = {},
  ): Promise<TaskLifecycleCommandResult> {
    const result = await this.completeTaskInner(taskId, opts);
    await this.writeTaskCompletionAudit(taskId, result, opts.actor);
    return result;
  }

  private async completeTaskInner(
    taskId: string,
    opts: {
      feedback?: TaskCompletionFeedback;
      requestReflect?: boolean;
      cleanupWorktree?: boolean;
    },
  ): Promise<TaskLifecycleCommandResult> {
    const task = this.deps.taskStore.getTask(taskId);
    if (!task) return { outcome: 'not_found', error: `Task not found: ${taskId}` };

    if (task.status === 'completed' || task.status === 'cancelled') {
      return { outcome: 'already_terminal', task };
    }

    if (isActiveRalphLoop(task)) {
      // Active Ralph loops own their task-level lifecycle. A user "complete"
      // click only ends the current iteration session; the Stop hook decides
      // whether to spawn the next iteration.
      await this.completeActiveRalphIteration(task);
      return {
        outcome: 'partial_ralph_completion',
        task: this.deps.taskStore.getTask(taskId) ?? task,
      };
    }

    if (task.status !== 'inProgress' && task.status !== 'terminated') {
      return {
        outcome: 'invalid',
        code: 'not_in_progress',
        error: `Cannot complete a task in status "${task.status}"; only in-progress or terminated tasks can be completed`,
      };
    }

    const preEvents = this.captureTaskEvents(task);

    try {
      this.deps.taskStore.clearPendingSignal(taskId);
      await completeTaskImpl(taskId, this.deps.getLifecycleDeps(), {
        cleanupWorktree: opts.cleanupWorktree,
      });
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        const current = this.deps.taskStore.getTask(taskId);
        if (current && isTerminalStatus(current.status)) {
          return { outcome: 'already_terminal', task: current };
        }
      }
      throw err;
    }

    await this.deps.scheduleService?.recordTaskTerminalOutcome(taskId, 'completed');
    this.finalizeCompletionMetadata(task, preEvents);

    if (opts.feedback) {
      await this.applyFeedback(taskId, sanitizeFeedback(opts.feedback), 'submit', opts.requestReflect);
    } else if (opts.requestReflect) {
      await this.requestReflectWithoutExplicitFeedback(taskId);
    }

    await this.deps.tryPromotePending?.();
    return {
      outcome: 'completed',
      task: this.deps.taskStore.getTask(taskId) ?? task,
    };
  }

  async cancelTask(taskId: string): Promise<TaskLifecycleCommandResult> {
    const task = this.deps.taskStore.getTask(taskId);
    if (!task) return { outcome: 'not_found', error: `Task not found: ${taskId}` };

    if (isActiveRalphLoop(task)) {
      this.deps.ralphLoopService?.cancelLoop(task);
    }

    this.deps.taskStore.clearPendingSignal(taskId);
    await cancelTaskImpl(taskId, this.deps.getLifecycleDeps());
    await this.deps.scheduleService?.recordTaskTerminalOutcome(taskId, 'cancelled');
    await this.deps.tryPromotePending?.();
    return {
      outcome: 'cancelled',
      task: this.deps.taskStore.getTask(taskId) ?? task,
    };
  }

  reopenTask(taskId: string): TaskLifecycleCommandResult {
    const task = this.deps.taskStore.getTask(taskId);
    if (!task) return { outcome: 'not_found', error: `Task not found: ${taskId}` };
    return { outcome: 'reopened', task: this.deps.taskStore.reopenTask(taskId) };
  }

  /**
   * Idempotent batch abort (issue #1325). Accepts explicit task IDs and an
   * operator reason, aborts every still-active task (interrupting its live
   * sessions via the same {@link cancelTask} path the UI uses), and returns a
   * per-task result so callers can report partial failures.
   *
   * Idempotency: the eligible set is filtered to non-terminal tasks *before*
   * any teardown, so retrying the same request never drives a second state
   * transition and never re-tears-down a session. A retry of an already-aborted
   * set reports every task as `already_terminal` and — because nothing
   * transitioned — writes no new audit record. IDs are trimmed and de-duplicated
   * so a list that repeats the same task aborts it once.
   */
  async batchAbortTasks(
    taskIds: readonly string[],
    opts: { reason?: string } & TaskDeletionAuditOpts = {},
  ): Promise<BatchAbortResult> {
    const orderedIds = dedupeTaskIds(taskIds);
    const results: BatchAbortTaskResult[] = [];
    for (const taskId of orderedIds) {
      results.push(await this.abortSingleTask(taskId));
    }

    const summary = summarizeBatchAbort(orderedIds.length, results);
    // Audit any batch that did something or attempted-and-failed a teardown —
    // an all-fail batch (e.g. the daemon is down) is the case most worth a
    // record. A pure no-op (only already-terminal / missing tasks) writes
    // nothing, so retrying an already-aborted set never appends a duplicate row.
    if (summary.aborted > 0 || summary.failed > 0) {
      await this.writeBatchAbortAudit({
        actor: opts.actor,
        reason: normalizeAbortReason(opts.reason),
        results,
        summary,
      });
    }
    return { results, summary };
  }

  private async abortSingleTask(taskId: string): Promise<BatchAbortTaskResult> {
    const task = this.deps.taskStore.getTask(taskId);
    if (!task) return { taskId, outcome: 'not_found' };
    // Terminal tasks are a safe no-op: no transition, no session teardown, no
    // audit row. This is the crux of retry-idempotency.
    if (isTerminalStatus(task.status)) {
      return { taskId, outcome: 'already_terminal', status: task.status };
    }
    try {
      const result = await this.cancelTask(taskId);
      switch (result.outcome) {
        case 'cancelled':
          return { taskId, outcome: 'aborted', status: result.task.status };
        case 'not_found':
          return { taskId, outcome: 'not_found' };
        default:
          return {
            taskId,
            outcome: 'failed',
            error: `unexpected cancel outcome: ${result.outcome}`,
          };
      }
    } catch (err) {
      // A concurrent aborter may have raced this task to terminal between the
      // guard above and the cancel transition; that is still a safe no-op.
      const current = this.deps.taskStore.getTask(taskId);
      if (current && isTerminalStatus(current.status)) {
        return { taskId, outcome: 'already_terminal', status: current.status };
      }
      return {
        taskId,
        outcome: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async deleteTask(
    taskId: string,
    opts: { gcFeedbackBundle?: boolean } & TaskDeletionAuditOpts = {},
  ): Promise<TaskLifecycleCommandResult> {
    const task = this.deps.taskStore.getTask(taskId);
    const deleted = await deleteTask(this.deps.getLifecycleDeps(), taskId);
    await this.writeTaskDeletionAudit({
      action: 'deleteTask',
      actor: opts.actor,
      projectId: task?.projectId,
      count: deleted ? 1 : 0,
      deletedTaskIds: deleted ? [taskId] : [],
      targetTaskId: taskId,
      outcome: deleted ? 'deleted' : 'not_found',
    });
    if (!deleted) return { outcome: 'not_found', error: `Task not found: ${taskId}` };
    if (opts.gcFeedbackBundle !== false) this.gcFeedbackBundle(taskId);
    return { outcome: 'deleted' };
  }

  async clearFinishedTasks(
    opts: { includeTerminated?: boolean; projectId?: string } & TaskDeletionAuditOpts = {},
  ): Promise<TaskLifecycleCommandResult> {
    const projectId = opts.projectId?.trim();
    if (opts.projectId !== undefined && !projectId) {
      await this.writeTaskDeletionAudit({
        action: 'clearCompleted',
        actor: opts.actor,
        includeTerminated: opts.includeTerminated === true,
        count: 0,
        deletedTaskIds: [],
        outcome: 'invalid_scope',
      });
      return { outcome: 'cleared', deletedTaskIds: [] };
    }
    const toClear = this.deps.taskStore.listTasks().filter((task) => {
      if (projectId && task.projectId !== projectId) return false;
      if (task.status === 'completed' || task.status === 'cancelled') return true;
      return opts.includeTerminated === true && task.status === 'terminated';
    });
    if (toClear.length === 0) {
      await this.writeTaskDeletionAudit({
        action: 'clearCompleted',
        actor: opts.actor,
        projectId,
        includeTerminated: opts.includeTerminated === true,
        count: 0,
        deletedTaskIds: [],
        outcome: 'cleared',
      });
      return { outcome: 'cleared', deletedTaskIds: [] };
    }

    if (this.deps.takePredeleteSnapshot) {
      try {
        await this.deps.takePredeleteSnapshot();
      } catch (err) {
        console.error('[clearCompleted] predelete snapshot failed, aborting delete to prevent unrecoverable data loss:', err);
        await this.writeTaskDeletionAudit({
          action: 'clearCompleted',
          actor: opts.actor,
          projectId,
          includeTerminated: opts.includeTerminated === true,
          count: 0,
          deletedTaskIds: [],
          outcome: 'snapshot_failed',
        });
        return {
          outcome: 'snapshot_failed',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const inFlightReflectSourceIds = this.inFlightReflectSourceIds();
    const deletedTaskIds: string[] = [];
    for (const task of toClear) {
      if (!this.deps.taskStore.getTask(task.id)) continue;
      const shouldGcFeedbackBundle = !inFlightReflectSourceIds.has(task.id);
      this.deleteFinishedTaskRecord(task, { gcFeedbackBundle: shouldGcFeedbackBundle });
      deletedTaskIds.push(task.id);
    }

    await this.writeTaskDeletionAudit({
      action: 'clearCompleted',
      actor: opts.actor,
      projectId,
      includeTerminated: opts.includeTerminated === true,
      count: deletedTaskIds.length,
      deletedTaskIds,
      outcome: 'cleared',
    });
    this.broadcastClearCompleted(deletedTaskIds.length, projectId);
    return { outcome: 'cleared', deletedTaskIds };
  }

  async setTaskFeedback(taskId: string, feedback: TaskCompletionFeedback): Promise<TaskLifecycleCommandResult> {
    const task = this.deps.taskStore.getTask(taskId);
    if (!task) return { outcome: 'not_found', error: `Task not found: ${taskId}` };
    await this.applyFeedback(taskId, sanitizeFeedback(feedback), 'amend');
    return { outcome: 'completed', task: this.deps.taskStore.getTask(taskId) ?? task };
  }

  async requestTaskReflect(taskId: string, direction: 'up' | 'down'): Promise<TaskLifecycleCommandResult> {
    if (!this.deps.reflectWorktreesDir || !this.deps.launchTask) {
      console.warn('[requestTaskReflect] missing deps; ignoring');
      return { outcome: 'invalid', code: 'reflect_unavailable', error: 'Task reflection is not configured' };
    }
    const task = this.deps.taskStore.getTask(taskId);
    if (!task) return { outcome: 'not_found', error: `Task not found: ${taskId}` };
    if (!task.completionFeedback) {
      console.warn(`[requestTaskReflect] task ${taskId} has no feedback; ignoring`);
      return { outcome: 'invalid', code: 'missing_feedback', error: 'Task has no completion feedback' };
    }

    const bundlePath = await findLatestBundleDir(this.deps.feedbackDir, taskId);
    if (!bundlePath) {
      console.warn(`[requestTaskReflect] no bundle found for ${taskId}; ignoring`);
      return { outcome: 'invalid', code: 'missing_bundle', error: 'Task has no feedback bundle' };
    }

    const result = await requestTaskReflect(
      { sourceTaskId: taskId, bundlePath, direction },
      {
        taskStore: this.deps.taskStore,
        reflectWorktreesDir: this.deps.reflectWorktreesDir,
        launchTask: this.deps.launchTask,
      },
    );
    if (!result.spawned) {
      console.warn(`[requestTaskReflect] spawn declined: ${result.reason}`);
    } else {
      console.log(`[requestTaskReflect] spawned reflect ${result.reflectTaskId} for ${taskId} (${direction})`);
    }

    return { outcome: 'completed', task };
  }

  async requestTaskSnapshotReflect(taskId: string, hint?: string): Promise<TaskLifecycleCommandResult> {
    if (
      !this.deps.taskSnapshotDir ||
      !this.deps.hooksDir ||
      !this.deps.readInteractionLogSnapshot ||
      !this.deps.reflectWorktreesDir ||
      !this.deps.launchTask
    ) {
      console.warn('[requestTaskSnapshotReflect] missing deps; ignoring');
      return { outcome: 'invalid', code: 'snapshot_reflect_unavailable', error: 'Task snapshot reflection is not configured' };
    }

    const task = this.deps.taskStore.getTask(taskId);
    if (!task) return { outcome: 'not_found', error: `Task not found: ${taskId}` };

    const sessionIds = new Set(task.sessions.map((session) => session.tmuxSession));
    const agentStates = getSnapshotAgentsForClient({
      monitor: this.deps.monitor,
      activityMetaProvider: this.deps.activityMetaProvider,
      pendingSignalProvider: this.deps.taskStore,
    }).filter((agent) => sessionIds.has(agent.agentId));
    const sessionEvents = Object.fromEntries(
      task.sessions.map((session) => [
        session.tmuxSession,
        this.deps.monitor.getAgentEvents(session.tmuxSession),
      ]),
    );
    const agentId = task.sessions[0]?.tmuxSession ?? '';

    // Free-text hint the user typed when clicking Reflect (e.g. "liked being
    // asked for e2e tests"). Optional; blank input reflects with no hint.
    const normalizedHint = hint?.trim() || undefined;

    await this.deps.interactionLog?.append({
      type: 'task_reflect_requested',
      taskId,
      agentId,
      mode: 'snapshot',
      ...(normalizedHint ? { hint: normalizedHint } : {}),
      timestamp: nowISO(),
    });

    let bundlePath: string;
    try {
      const result = await writeTaskSnapshotBundle(task, {
        taskSnapshotDir: this.deps.taskSnapshotDir,
        hooksDir: this.deps.hooksDir,
        readInteractionLog: this.deps.readInteractionLogSnapshot,
        agentStates,
        sessionEvents,
        userHint: normalizedHint,
      });
      bundlePath = result.bundlePath;
    } catch (err) {
      console.warn(`[requestTaskSnapshotReflect] bundle write failed for ${taskId}:`, err);
      return {
        outcome: 'snapshot_failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const result = await requestTaskReflect(
      { sourceTaskId: taskId, bundlePath, direction: 'review', kind: 'snapshot' },
      {
        taskStore: this.deps.taskStore,
        reflectWorktreesDir: this.deps.reflectWorktreesDir,
        launchTask: this.deps.launchTask,
      },
    );
    if (result.spawned) {
      console.log(`[requestTaskSnapshotReflect] spawned reflect ${result.reflectTaskId} for ${taskId}`);
    } else {
      console.warn(`[requestTaskSnapshotReflect] spawn declined for ${taskId}: ${result.reason}`);
    }

    return { outcome: 'completed', task };
  }

  private async completeActiveRalphIteration(task: Task): Promise<void> {
    for (const session of task.sessions) {
      if (session.lastStatus !== 'completed' && session.lastStatus !== 'aborted') {
        await cleanupSessionResources(session.tmuxSession, this.deps.getLifecycleDeps());
        this.deps.taskStore.updateSession(task.id, session.tmuxSession, { lastStatus: 'completed' });
      }
    }
  }

  private captureTaskEvents(task: Task): AgentEvent[] {
    const preEvents: AgentEvent[] = [];
    for (const session of task.sessions) {
      preEvents.push(...this.deps.monitor.getAgentEvents(session.tmuxSession));
    }
    return preEvents;
  }

  private async applyFeedback(
    taskId: string,
    feedback: TaskCompletionFeedback,
    mode: 'submit' | 'amend',
    requestReflect?: boolean,
  ): Promise<void> {
    const task = this.deps.taskStore.getTask(taskId);
    if (!task) return;
    const changed = this.deps.taskStore.setCompletionFeedback(taskId, feedback);
    if (!changed) return;

    const agentId = task.sessions[0]?.tmuxSession ?? '';
    await this.deps.interactionLog?.append({
      type: mode === 'submit' ? 'task_feedback_submitted' : 'task_feedback_amended',
      taskId,
      agentId,
      rating: feedback.rating,
      ...(feedback.note !== undefined ? { note: feedback.note } : {}),
      ...(feedback.downReason !== undefined ? { downReason: feedback.downReason } : {}),
      timestamp: nowISO(),
    });

    const bundlePath = await this.writeFeedbackBundleSnapshot(task, feedback);
    const shouldReflect = requestReflect ?? feedback.rating === 'down';
    if (shouldReflect && bundlePath) {
      await this.spawnTaskReflect(taskId, bundlePath, feedback.rating);
    }
  }

  private async requestReflectWithoutExplicitFeedback(taskId: string): Promise<void> {
    const task = this.deps.taskStore.getTask(taskId);
    if (!task) return;
    const feedback: TaskCompletionFeedback = { rating: 'up' };
    const bundlePath = await this.writeFeedbackBundleSnapshot(task, feedback);
    if (!bundlePath) return;
    await this.spawnTaskReflect(taskId, bundlePath, feedback.rating);
  }

  private async writeFeedbackBundleSnapshot(
    task: Task,
    feedback: TaskCompletionFeedback,
  ): Promise<string | undefined> {
    if (
      !this.deps.feedbackDir ||
      !this.deps.hooksDir ||
      !this.deps.readInteractionLogSnapshot
    ) {
      return undefined;
    }
    try {
      const result = await writeFeedbackBundle(task, feedback, {
        feedbackDir: this.deps.feedbackDir,
        hooksDir: this.deps.hooksDir,
        readInteractionLog: this.deps.readInteractionLogSnapshot,
      });
      return result.bundlePath;
    } catch (err) {
      console.warn(`[feedback] bundle write failed for ${task.id}:`, err);
      return undefined;
    }
  }

  private async spawnTaskReflect(
    taskId: string,
    bundlePath: string,
    direction: 'up' | 'down',
  ): Promise<void> {
    if (!this.deps.reflectWorktreesDir || !this.deps.launchTask) return;
    const result = await requestTaskReflect(
      { sourceTaskId: taskId, bundlePath, direction },
      {
        taskStore: this.deps.taskStore,
        reflectWorktreesDir: this.deps.reflectWorktreesDir,
        launchTask: this.deps.launchTask,
      },
    );
    if (result.spawned) {
      console.log(`[feedback] auto-reflect spawned ${result.reflectTaskId} for ${taskId}`);
    } else {
      console.log(`[feedback] auto-reflect skipped for ${taskId}: ${result.reason}`);
    }
  }

  private finalizeCompletionMetadata(task: Task | undefined, preEvents: AgentEvent[]): void {
    if (!task || preEvents.length === 0) return;

    void (async () => {
      const completionMetadata = await buildTaskCompletionMetadata(task, preEvents);
      if (!this.deps.taskStore.getTask(task.id)) return;

      this.deps.taskStore.setCompletionDigest(task.id, completionMetadata.digest);
      if (completionMetadata.taskTokenUsage) {
        this.deps.taskStore.updateTokenUsage(task.id, completionMetadata.taskTokenUsage);
      }

      const taskName = task.name ?? 'Task';
      this.deps.broadcastToAll?.({
        type: 'alert',
        agentId: task.sessions[0]?.tmuxSession ?? '',
        summary: `Completed: ${taskName} — ${completionMetadata.digest.bullets[0]}`,
        details: completionMetadata.digest.bullets.slice(1).join(' · '),
        severity: 'info',
      });

      const state = getSnapshotAgentsForClient({
        monitor: this.deps.monitor,
        activityMetaProvider: this.deps.activityMetaProvider,
        pendingSignalProvider: this.deps.taskStore,
      })
        .find((agent) => agent.taskId === task.id);
      if (state) {
        this.deps.broadcastToAll?.({ type: 'update', agentId: state.agentId, state });
      }
    })().catch((err) => {
      console.warn(
        `[completion] metadata finalization failed for ${task.id}:`,
        err instanceof Error ? err.message : err,
      );
    });
  }

  private inFlightReflectSourceIds(): Set<string> {
    const ids = new Set<string>();
    for (const task of this.deps.taskStore.listTasks()) {
      if (task.reflectMeta?.sourceTaskId && !isTerminalStatusForReflect(task.status)) {
        ids.add(task.reflectMeta.sourceTaskId);
      }
    }
    return ids;
  }

  private gcFeedbackBundle(taskId: string): void {
    if (!this.deps.feedbackDir) return;
    const bundleTaskDir = join(this.deps.feedbackDir, taskId);
    rm(bundleTaskDir, { recursive: true, force: true }).catch(() => {});
  }

  private gcTaskSnapshotBundle(taskId: string): void {
    if (!this.deps.taskSnapshotDir) return;
    const bundleTaskDir = join(this.deps.taskSnapshotDir, taskId);
    rm(bundleTaskDir, { recursive: true, force: true }).catch(() => {});
  }

  private deleteFinishedTaskRecord(task: Task, opts: { gcFeedbackBundle: boolean }): void {
    // Clear-finished is a terminal record sweep, not an active task delete. Do
    // not call adapter.stop here; legacy terminal records can have stale
    // nonterminal session statuses even though the task itself is finished.
    for (const session of task.sessions) {
      this.deps.monitor.unregisterAgent(session.tmuxSession);
    }
    this.deps.taskStore.deleteTask(task.id);
    if (opts.gcFeedbackBundle) {
      this.gcFeedbackBundle(task.id);
      this.gcTaskSnapshotBundle(task.id);
    }
  }

  private async writeTaskCompletionAudit(
    taskId: string,
    result: TaskLifecycleCommandResult,
    actor?: TaskDeletionAuditActor,
  ): Promise<void> {
    if (!this.deps.auditLogPath) return;
    const row: Record<string, unknown> = {
      type: 'task.complete',
      timestamp: nowISO(),
      actor: actor ?? { source: 'unknown' },
      taskId,
      outcome: result.outcome,
      ...('task' in result ? { status: result.task.status } : {}),
      ...('error' in result ? { error: result.error } : {}),
    };
    try {
      await mkdir(dirname(this.deps.auditLogPath), { recursive: true });
      await appendFile(this.deps.auditLogPath, `${JSON.stringify(row)}\n`, 'utf-8');
    } catch (err) {
      console.warn('[task-audit] failed to append completion audit row:', err);
    }
  }

  private async writeTaskDeletionAudit(record: TaskDeletionAuditRecord): Promise<void> {
    if (!this.deps.auditLogPath) return;
    const row: TaskDeletionAuditRow = {
      type: `task.${record.action}`,
      timestamp: nowISO(),
      actor: record.actor ?? { source: 'unknown' },
      scope: record.projectId ? { kind: 'project', projectId: record.projectId } : { kind: 'all' },
      count: record.count,
      deletedTaskIds: record.deletedTaskIds,
      outcome: record.outcome,
      ...(record.targetTaskId ? { taskId: record.targetTaskId } : {}),
      ...(record.includeTerminated !== undefined ? { includeTerminated: record.includeTerminated } : {}),
    };
    try {
      await mkdir(dirname(this.deps.auditLogPath), { recursive: true });
      await appendFile(this.deps.auditLogPath, `${JSON.stringify(row)}\n`, 'utf-8');
    } catch (err) {
      console.warn('[task-audit] failed to append deletion audit row:', err);
    }
  }

  private async writeBatchAbortAudit(record: {
    actor?: TaskDeletionAuditActor;
    reason?: string;
    results: BatchAbortTaskResult[];
    summary: BatchAbortSummary;
  }): Promise<void> {
    if (!this.deps.auditLogPath) return;
    const abortedTaskIds = record.results
      .filter((r) => r.outcome === 'aborted')
      .map((r) => r.taskId);
    const row: BatchAbortAuditRow = {
      type: 'task.batchAbort',
      timestamp: nowISO(),
      actor: record.actor ?? { source: 'unknown' },
      ...(record.reason ? { reason: record.reason } : {}),
      count: record.summary.total,
      abortedTaskIds,
      summary: record.summary,
      results: record.results.map((r) => ({ taskId: r.taskId, outcome: r.outcome })),
    };
    try {
      await mkdir(dirname(this.deps.auditLogPath), { recursive: true });
      await appendFile(this.deps.auditLogPath, `${JSON.stringify(row)}\n`, 'utf-8');
    } catch (err) {
      console.warn('[task-audit] failed to append batch-abort audit row:', err);
    }
  }

  private broadcastClearCompleted(count: number, projectId?: string): void {
    if (!this.deps.broadcastToAll || count === 0) return;
    this.deps.broadcastToAll({
      type: 'alert',
      agentId: '',
      summary: `Cleared ${count} task${count === 1 ? '' : 's'}`,
      details: projectId ? `Project: ${projectId}` : 'Scope: all projects',
      severity: 'info',
    });
  }
}

function isActiveRalphLoop(task: Task): boolean {
  return task.ralphLoop?.status === 'running' || task.ralphLoop?.status === 'paused';
}

function dedupeTaskIds(taskIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of taskIds) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  return ordered;
}

function summarizeBatchAbort(total: number, results: BatchAbortTaskResult[]): BatchAbortSummary {
  const summary: BatchAbortSummary = {
    total,
    aborted: 0,
    already_terminal: 0,
    not_found: 0,
    failed: 0,
  };
  for (const result of results) summary[result.outcome] += 1;
  return summary;
}

function normalizeAbortReason(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const redacted = redactSecrets(raw).trim();
  if (!redacted) return undefined;
  return redacted.length > MAX_ABORT_REASON_LENGTH
    ? `${redacted.slice(0, MAX_ABORT_REASON_LENGTH)} [truncated]`
    : redacted;
}

function sanitizeFeedback(input: TaskCompletionFeedback): TaskCompletionFeedback {
  const out: TaskCompletionFeedback = { rating: input.rating };
  if (input.downReason) out.downReason = input.downReason;
  if (input.note !== undefined) {
    let note = input.note;
    if (note.length > 500) {
      note = note.slice(0, 500) + ' [truncated]';
    }
    note = redactSecrets(note);
    out.note = note;
  }
  return out;
}

function isTerminalStatusForReflect(status: string): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'terminated';
}

async function findLatestBundleDir(
  feedbackDir: string | undefined,
  taskId: string,
): Promise<string | undefined> {
  if (!feedbackDir) return undefined;
  const taskDir = join(feedbackDir, taskId);
  let entries: string[] = [];
  try {
    // Bundle dirs are timestamp-slugged, so lexicographic order is newest-last.
    entries = (await readdir(taskDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return undefined;
  }
  if (entries.length === 0) return undefined;
  return join(taskDir, entries[entries.length - 1]);
}
