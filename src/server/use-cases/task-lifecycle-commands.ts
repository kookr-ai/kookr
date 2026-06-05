import { rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
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
  reflectWorktreesDir?: string;
  hooksDir?: string;
  readInteractionLogSnapshot?: () => Promise<import('../../core/interaction-log.js').InteractionEvent[]>;
}

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

export class TaskLifecycleCommands {
  constructor(private readonly deps: TaskLifecycleCommandDeps) {}

  async completeTask(
    taskId: string,
    opts: { feedback?: TaskCompletionFeedback; requestReflect?: boolean } = {},
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
      await completeTaskImpl(taskId, this.deps.getLifecycleDeps());
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

  async deleteTask(taskId: string, opts: { gcFeedbackBundle?: boolean } = {}): Promise<TaskLifecycleCommandResult> {
    const deleted = await deleteTask(this.deps.getLifecycleDeps(), taskId);
    if (!deleted) return { outcome: 'not_found', error: `Task not found: ${taskId}` };
    if (opts.gcFeedbackBundle !== false) this.gcFeedbackBundle(taskId);
    return { outcome: 'deleted' };
  }

  async clearFinishedTasks(opts: { includeTerminated?: boolean } = {}): Promise<TaskLifecycleCommandResult> {
    const toClear = this.deps.taskStore.listTasks().filter((task) => {
      if (task.status === 'completed' || task.status === 'cancelled') return true;
      return opts.includeTerminated === true && task.status === 'terminated';
    });
    if (toClear.length === 0) return { outcome: 'cleared', deletedTaskIds: [] };

    if (this.deps.takePredeleteSnapshot) {
      try {
        await this.deps.takePredeleteSnapshot();
      } catch (err) {
        console.error('[clearCompleted] predelete snapshot failed, aborting delete to prevent unrecoverable data loss:', err);
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

  private deleteFinishedTaskRecord(task: Task, opts: { gcFeedbackBundle: boolean }): void {
    // Clear-finished is a terminal record sweep, not an active task delete. Do
    // not call adapter.stop here; legacy terminal records can have stale
    // nonterminal session statuses even though the task itself is finished.
    for (const session of task.sessions) {
      this.deps.monitor.unregisterAgent(session.tmuxSession);
    }
    this.deps.taskStore.deleteTask(task.id);
    if (opts.gcFeedbackBundle) this.gcFeedbackBundle(task.id);
  }
}

function isActiveRalphLoop(task: Task): boolean {
  return task.ralphLoop?.status === 'running' || task.ralphLoop?.status === 'paused';
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
