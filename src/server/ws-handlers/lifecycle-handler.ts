import type { AgentActivityMeta } from '../../core/types.js';
import type { ServerMessage, ClientMessage } from '../../shared/contracts/messages.js';
import type { TaskStore } from '../../core/tasks.js';
import type { Monitor } from '../../core/monitor.js';
import type { AttentionQueue } from '../../core/attention-queue.js';
import type { DeferredInteractionLogWriter } from '../../core/interaction-log.js';
import type { ScheduleService } from '../schedule-service.js';
import type { RalphLoopService } from '../ralph-loop-service.js';
import type { LaunchOpts, LaunchResult, LaunchTaskServerOptions } from '../launch-service.js';
import type { LifecycleDeps } from '../agent-lifecycle.js';
import {
  cleanupSessionResources as cleanupSessionResourcesImpl,
} from '../agent-lifecycle.js';
import { nowISO } from '../../core/interaction-log.js';
import { getSnapshotAgentsForClient } from '../use-cases/get-snapshot.js';
import { handleLaunchResult } from './launch-result.js';
import {
  TaskLifecycleCommands,
  type TaskDeletionAuditActor,
  type TaskLifecycleCommandResult,
  type BatchAbortSummary,
} from '../use-cases/task-lifecycle-commands.js';
import { isSharedTaskId } from '../../shared/contracts/contact-share.js';

/**
 * Narrow dependency bag for task-lifecycle messages.
 *
 * Task lifecycle naturally depends on a lot of state — every terminal
 * transition has to sync with the task store, interaction log, monitor,
 * schedule service, and agent-lifecycle cleanup. We keep those as a
 * lifecycleDeps thunk and a tryPromotePending callback to avoid leaking
 * the underlying AdapterRegistry / broadcastToAll / serverCwd collaborators
 * into this handler.
 */
export interface LifecycleHandlerDeps {
  send: (msg: ServerMessage) => void;
  taskStore: TaskStore;
  monitor: Monitor;
  queue: AttentionQueue;
  interactionLog?: DeferredInteractionLogWriter;
  scheduleService?: ScheduleService;
  ralphLoopService: RalphLoopService;
  launchTask?: (opts: LaunchOpts, serverOpts?: LaunchTaskServerOptions) => Promise<LaunchResult>;
  broadcastToAll?: (msg: ServerMessage) => void;
  activityMetaProvider?: { getActivityMeta(kookrSessionId: string): AgentActivityMeta | undefined };
  takePredeleteSnapshot?: () => Promise<void>;
  auditLogPath?: string;
  deletionAuditActor?: () => TaskDeletionAuditActor;
  /**
   * Thunk that rebuilds the LifecycleDeps used by agent-lifecycle / delete-task.
   * Thunk instead of a direct field because several of its members
   * (interactionLog, suppressionTracker, leaseService, attemptRepository)
   * may be wired lazily at server startup.
   */
  getLifecycleDeps: () => LifecycleDeps;
  /** Promote pending tasks if concurrency slots have opened. */
  tryPromotePending: () => Promise<void>;
  /** Where feedback bundles are written. Typically `<kookrDir>/feedback`. Optional — feedback is fail-open. */
  feedbackDir?: string;
  /** Where anytime task snapshot bundles are written. Typically `<kookrDir>/task-snapshots`. */
  taskSnapshotDir?: string;
  /** Where ephemeral reflect worktrees live. Typically `<kookrDir>/reflect-worktrees`. */
  reflectWorktreesDir?: string;
  /** Where hook JSONLs live. Typically `<kookrDir>/hooks`. */
  hooksDir?: string;
  /** Reads the current full interaction log (snapshot at submission time). */
  readInteractionLogSnapshot?: () => Promise<import('../../core/interaction-log.js').InteractionEvent[]>;
}

type LifecycleMessage = Extract<ClientMessage, {
  type:
    | 'launch'
    | 'relaunch'
    | 'stop'
    | 'completeTask'
    | 'cancelTask'
    | 'batchAbortTasks'
    | 'reopenTask'
    | 'dismissAgentSignal'
    | 'renameTask'
    | 'setTaskPriority'
    | 'deleteTask'
    | 'clearCompleted'
    | 'ackTerminatedTask'
    | 'getNext'
    | 'setTaskFeedback'
    | 'requestTaskReflect'
    | 'requestTaskSnapshotReflect'
}>;

/**
 * Handles task-lifecycle client messages.
 *
 * Returns `{ duplicate }` from `handle(...)` so the dispatching router
 * can track duplicate launches for achievement-watcher. Most cases return
 * `{ duplicate: false }`; only `launch` and `relaunch` may flag it true.
 */
export class LifecycleHandler {
  private readonly commands: TaskLifecycleCommands;

  constructor(private readonly deps: LifecycleHandlerDeps) {
    this.commands = new TaskLifecycleCommands({
      taskStore: deps.taskStore,
      monitor: deps.monitor,
      interactionLog: deps.interactionLog,
      scheduleService: deps.scheduleService,
      ralphLoopService: deps.ralphLoopService,
      launchTask: deps.launchTask,
      broadcastToAll: deps.broadcastToAll,
      activityMetaProvider: deps.activityMetaProvider,
      takePredeleteSnapshot: deps.takePredeleteSnapshot,
      auditLogPath: deps.auditLogPath,
      feedbackDir: deps.feedbackDir,
      taskSnapshotDir: deps.taskSnapshotDir,
      reflectWorktreesDir: deps.reflectWorktreesDir,
      hooksDir: deps.hooksDir,
      readInteractionLogSnapshot: deps.readInteractionLogSnapshot,
      getLifecycleDeps: deps.getLifecycleDeps,
      tryPromotePending: deps.tryPromotePending,
    });
  }

  async handle(msg: LifecycleMessage): Promise<{ duplicate: boolean }> {
    if ('taskId' in msg && typeof msg.taskId === 'string' && isSharedTaskId(msg.taskId)) {
      this.deps.send({
        type: 'alert',
        agentId: '',
        summary: 'Shared tasks are remote-owned',
        details: 'Local task lifecycle mutations are disabled for Contact Share tasks.',
        severity: 'warning',
      });
      return { duplicate: false };
    }

    switch (msg.type) {
      case 'launch': {
        const excerpt = msg.prompt.slice(0, 40);
        let result: LaunchResult | undefined;
        let err: unknown;
        try {
          result = await this.deps.launchTask?.({
            prompt: msg.prompt,
            cwd: msg.cwd,
            criteria: msg.criteria,
            agentType: msg.agentType,
            dependencies: msg.dependencies,
          });
        } catch (e) { err = e; }
        return handleLaunchResult(this.deps.send, excerpt, result, err);
      }

      case 'relaunch': {
        const originalTask = this.deps.taskStore.getTask(msg.taskId);
        if (!originalTask) return { duplicate: false };
        const excerpt = msg.prompt.slice(0, 40);
        let result: LaunchResult | undefined;
        let err: unknown;
        try {
          result = await this.deps.launchTask?.({
            prompt: msg.prompt,
            cwd: originalTask.cwd,
            criteria: originalTask.criteria,
            agentType: msg.agentType ?? originalTask.agentType,
            dependencies: msg.dependencies,
          });
        } catch (e) { err = e; }
        return handleLaunchResult(this.deps.send, excerpt, result, err);
      }

      case 'stop': {
        // Legacy: kept for backwards compatibility but UI now uses completeTask/cancelTask
        await cleanupSessionResourcesImpl(msg.agentId, this.deps.getLifecycleDeps());
        // Mark the session completed and reopen the task if all sessions are done.
        // User-initiated stops reopen (not complete) because the user interrupted the work.
        // Natural session ends are auto-completed via reconciliation instead.
        const stopTask = this.deps.taskStore.findTaskBySession(msg.agentId);
        if (stopTask && stopTask.status === 'inProgress') {
          const updated = this.deps.taskStore.updateSession(stopTask.id, msg.agentId, { lastStatus: 'completed' });
          if (updated.sessions.every((s) => s.lastStatus === 'completed' || s.lastStatus === 'aborted')) {
            this.deps.taskStore.reopenTask(stopTask.id);
          }
        }
        await this.deps.interactionLog?.append({
          type: 'agent_stopped',
          agentId: msg.agentId,
          reason: 'user',
          timestamp: nowISO(),
        });
        return { duplicate: false };
      }

      case 'getNext': {
        const next = this.deps.queue.next();
        if (next) {
          const snapshot = getSnapshotAgentsForClient({
            monitor: this.deps.monitor,
            activityMetaProvider: this.deps.activityMetaProvider,
            pendingSignalProvider: this.deps.taskStore,
          });
          const state = snapshot.find((s) => s.agentId === next.agentId);
          if (state) {
            this.deps.send({ type: 'update', agentId: next.agentId, state });
          }
        }
        return { duplicate: false };
      }

      case 'completeTask': {
        assertCommandSucceeded(await this.commands.completeTask(msg.taskId, {
          feedback: msg.feedback,
          requestReflect: msg.requestReflect,
        }));
        return { duplicate: false };
      }

      case 'setTaskFeedback': {
        assertCommandSucceeded(await this.commands.setTaskFeedback(msg.taskId, msg.feedback));
        return { duplicate: false };
      }

      case 'requestTaskReflect': {
        await this.commands.requestTaskReflect(msg.taskId, msg.direction);
        return { duplicate: false };
      }

      case 'requestTaskSnapshotReflect': {
        assertCommandSucceeded(await this.commands.requestTaskSnapshotReflect(msg.taskId, msg.hint));
        return { duplicate: false };
      }

      case 'cancelTask': {
        assertCommandSucceeded(await this.commands.cancelTask(msg.taskId));
        return { duplicate: false };
      }

      case 'batchAbortTasks': {
        // SharedTask lifecycle is remote-owned (same rule the single-task guard
        // above enforces). Drop any that slipped into the batch so a bulk abort
        // can never mutate a Contact Share task locally.
        const localTaskIds = msg.taskIds.filter((id) => !isSharedTaskId(id));
        const { summary } = await this.commands.batchAbortTasks(localTaskIds, {
          reason: msg.reason,
          actor: this.deps.deletionAuditActor?.(),
        });
        // Concise result summary, delivered as a toast to every client — the
        // control room shows partial failures without a bespoke response
        // channel. The next periodic snapshot reflects the new terminal states,
        // matching how the single-task cancelTask path surfaces its result.
        this.deps.broadcastToAll?.({
          type: 'alert',
          agentId: '',
          summary: summarizeBatchAbortAlert(summary),
          details: describeBatchAbortAlertDetails(summary),
          severity: summary.failed > 0 ? 'warning' : 'info',
        });
        return { duplicate: false };
      }

      case 'reopenTask':
        assertCommandSucceeded(this.commands.reopenTask(msg.taskId));
        return { duplicate: false };

      case 'dismissAgentSignal': {
        // User dismissed the agent's pending signal (RFC:
        // rfc-agent-signal-surface). Clear it and push an immediate update so
        // the banner disappears without waiting for the next periodic snapshot.
        if (this.deps.taskStore.clearPendingSignal(msg.taskId)) {
          this.broadcastTaskUpdate(msg.taskId);
        }
        return { duplicate: false };
      }

      case 'deleteTask':
        assertCommandSucceeded(await this.commands.deleteTask(msg.taskId, {
          actor: this.deps.deletionAuditActor?.(),
        }));
        return { duplicate: false };

      case 'renameTask':
        this.deps.taskStore.renameTask(msg.taskId, msg.name);
        return { duplicate: false };

      case 'setTaskPriority':
        this.deps.taskStore.setTaskPriority(msg.taskId, msg.priority);
        return { duplicate: false };

      case 'clearCompleted': {
        const rawProjectId = msg.projectId;
        const projectId = rawProjectId?.trim();
        await this.commands.clearFinishedTasks({
          includeTerminated: msg.includeTerminated === true,
          projectId: rawProjectId !== undefined ? rawProjectId : projectId,
          actor: this.deps.deletionAuditActor?.(),
        });
        return { duplicate: false };
      }

      case 'ackTerminatedTask': {
        // User acknowledges a terminated task as "done" — transitions to 'completed'.
        // Only valid from 'terminated' (VALID_TRANSITIONS enforces this).
        const task = this.deps.taskStore.getTask(msg.taskId);
        if (!task) return { duplicate: false };
        if (task.status !== 'terminated') {
          console.warn(`[ack-terminated] taskId=${msg.taskId} — current status is ${task.status}, ignoring ack`);
          return { duplicate: false };
        }
        this.deps.taskStore.completeTask(msg.taskId);
        console.log(`[ack-terminated] taskId=${msg.taskId} transition=terminated->completed`);
        await this.deps.interactionLog?.append({
          type: 'task_completed',
          taskId: msg.taskId,
          agentId: task.sessions[0]?.tmuxSession ?? '',
          reason: 'user_acked_terminated',
          durationMs: Date.now() - task.createdAt.getTime(),
          timestamp: nowISO(),
        });
        return { duplicate: false };
      }
    }
  }

  /**
   * Broadcast a fresh `update` for every live agent of a task. Used after a
   * pending-signal change so clients reflect it immediately rather than waiting
   * for the next periodic snapshot.
   */
  private broadcastTaskUpdate(taskId: string): void {
    if (!this.deps.broadcastToAll) return;
    const states = getSnapshotAgentsForClient({
      monitor: this.deps.monitor,
      activityMetaProvider: this.deps.activityMetaProvider,
      pendingSignalProvider: this.deps.taskStore,
    }).filter((agent) => agent.taskId === taskId);
    for (const state of states) {
      this.deps.broadcastToAll({ type: 'update', agentId: state.agentId, state });
    }
  }
}

function assertCommandSucceeded(result: TaskLifecycleCommandResult): void {
  if (result.outcome === 'not_found' || result.outcome === 'invalid') {
    throw new Error(result.error);
  }
}

function summarizeBatchAbortAlert(summary: BatchAbortSummary): string {
  const n = summary.aborted;
  return `Aborted ${n} task${n === 1 ? '' : 's'}`;
}

function describeBatchAbortAlertDetails(summary: BatchAbortSummary): string {
  const parts: string[] = [];
  if (summary.already_terminal > 0) parts.push(`${summary.already_terminal} already finished`);
  if (summary.not_found > 0) parts.push(`${summary.not_found} not found`);
  if (summary.failed > 0) parts.push(`${summary.failed} failed`);
  return parts.length > 0 ? parts.join(' · ') : `${summary.total} selected`;
}
