import type { AgentActivityMeta, AgentEvent } from '../../core/types.js';
import type { ServerMessage, ClientMessage } from '../../shared/contracts/messages.js';
import type { TaskStore } from '../../core/tasks.js';
import type { Monitor } from '../../core/monitor.js';
import type { AttentionQueue } from '../../core/attention-queue.js';
import type { DeferredInteractionLogWriter } from '../../core/interaction-log.js';
import type { ScheduleService } from '../schedule-service.js';
import type { RalphLoopService } from '../ralph-loop-service.js';
import type { LaunchOpts, LaunchResult } from '../launch-service.js';
import type { LifecycleDeps } from '../agent-lifecycle.js';
import {
  completeTask as completeTaskImpl,
  cancelTask as cancelTaskImpl,
  cleanupSessionResources as cleanupSessionResourcesImpl,
} from '../agent-lifecycle.js';
import { nowISO } from '../../core/interaction-log.js';
import { buildTaskCompletionMetadata } from '../completion-metadata.js';
import { getSnapshotAgentsForClient } from '../use-cases/get-snapshot.js';
import { deleteTask } from '../use-cases/delete-task.js';
import { handleLaunchResult } from './launch-result.js';
import { writeFeedbackBundle } from '../use-cases/write-feedback-bundle.js';
import { requestTaskReflect } from '../use-cases/request-task-reflect.js';
import type { Task, TaskCompletionFeedback } from '../../core/tasks.js';
import { isSharedTaskId } from '../../shared/contracts/contact-share.js';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

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
  launchTask?: (opts: LaunchOpts) => Promise<LaunchResult>;
  broadcastToAll?: (msg: ServerMessage) => void;
  activityMetaProvider?: { getActivityMeta(kookrSessionId: string): AgentActivityMeta | undefined };
  takePredeleteSnapshot?: () => Promise<void>;
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
    | 'reopenTask'
    | 'renameTask'
    | 'setTaskPriority'
    | 'deleteTask'
    | 'clearCompleted'
    | 'ackTerminatedTask'
    | 'getNext'
    | 'setTaskFeedback'
    | 'requestTaskReflect'
}>;

/**
 * Handles task-lifecycle client messages.
 *
 * Returns `{ duplicate }` from `handle(...)` so the dispatching router
 * can track duplicate launches for achievement-watcher. Most cases return
 * `{ duplicate: false }`; only `launch` and `relaunch` may flag it true.
 */
export class LifecycleHandler {
  constructor(private readonly deps: LifecycleHandlerDeps) {}

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
          });
          const state = snapshot.find((s) => s.agentId === next.agentId);
          if (state) {
            this.deps.send({ type: 'update', agentId: next.agentId, state });
          }
        }
        return { duplicate: false };
      }

      case 'completeTask': {
        const completingTask = this.deps.taskStore.getTask(msg.taskId);

        // Ralph child whose loop is still active: "complete" means "this
        // iteration is done", not "the task is done". Skip task-level
        // teardown (status transition, lease release, worktree cleanup —
        // any of which would corrupt the next iteration's state) and just
        // stop the live session(s). The Stop hook on the killed owner
        // session is what spawns iteration N+1 in this same task. To stop
        // the loop entirely, use cancelTask. See
        // docs/rfc/rfc-ralph-loop-batch-mode-findings.md Phase 0.
        if (
          completingTask?.ralphLoop
          && (completingTask.ralphLoop.status === 'running' || completingTask.ralphLoop.status === 'paused')
        ) {
          for (const session of completingTask.sessions) {
            if (session.lastStatus !== 'completed' && session.lastStatus !== 'aborted') {
              await cleanupSessionResourcesImpl(session.tmuxSession, this.deps.getLifecycleDeps());
              this.deps.taskStore.updateSession(completingTask.id, session.tmuxSession, { lastStatus: 'completed' });
            }
          }
          return { duplicate: false };
        }

        // Capture events before lifecycle cleanup deletes them from the monitor
        const preEvents: AgentEvent[] = [];
        if (completingTask) {
          for (const session of completingTask.sessions) {
            preEvents.push(...this.deps.monitor.getAgentEvents(session.tmuxSession));
          }
        }

        await completeTaskImpl(msg.taskId, this.deps.getLifecycleDeps());
        await this.deps.scheduleService?.recordTaskTerminalOutcome(msg.taskId, 'completed');
        this.finalizeCompletionMetadata(completingTask, preEvents);

        // Apply optional feedback + trigger reflect according to the client.
        // Failure here is fail-open (logged) — never blocks completion.
        if (msg.feedback && completingTask) {
          await this.applyFeedback(msg.taskId, sanitizeFeedback(msg.feedback), 'submit', msg.requestReflect);
        }

        await this.deps.tryPromotePending();
        return { duplicate: false };
      }

      case 'setTaskFeedback': {
        const task = this.deps.taskStore.getTask(msg.taskId);
        if (!task) return { duplicate: false };
        await this.applyFeedback(msg.taskId, sanitizeFeedback(msg.feedback), 'amend');
        return { duplicate: false };
      }

      case 'requestTaskReflect': {
        if (!this.deps.reflectWorktreesDir || !this.deps.launchTask) {
          console.warn('[requestTaskReflect] missing deps; ignoring');
          return { duplicate: false };
        }
        const task = this.deps.taskStore.getTask(msg.taskId);
        if (!task?.completionFeedback) {
          console.warn(`[requestTaskReflect] task ${msg.taskId} has no feedback; ignoring`);
          return { duplicate: false };
        }
        // Manual trigger — find the most recent bundle for this task.
        const bundlePath = await findLatestBundleDir(this.deps.feedbackDir, msg.taskId);
        if (!bundlePath) {
          console.warn(`[requestTaskReflect] no bundle found for ${msg.taskId}; ignoring`);
          return { duplicate: false };
        }
        const result = await requestTaskReflect(
          { sourceTaskId: msg.taskId, bundlePath, direction: msg.direction },
          {
            taskStore: this.deps.taskStore,
            reflectWorktreesDir: this.deps.reflectWorktreesDir,
            launchTask: this.deps.launchTask,
          },
        );
        if (!result.spawned) {
          console.warn(`[requestTaskReflect] spawn declined: ${result.reason}`);
        } else {
          console.log(`[requestTaskReflect] spawned reflect ${result.reflectTaskId} for ${msg.taskId} (${msg.direction})`);
        }
        return { duplicate: false };
      }

      case 'cancelTask': {
        // Cancel the Ralph loop *before* killing the owner session, so the
        // Stop hook sees `ralphLoop.status === 'cancelled'` and skips the
        // next-iteration spawn path. See rfc-ralph-loop-batch-mode-findings.md
        // Phase 0.
        const cancellingTask = this.deps.taskStore.getTask(msg.taskId);
        if (
          cancellingTask?.ralphLoop
          && (cancellingTask.ralphLoop.status === 'running' || cancellingTask.ralphLoop.status === 'paused')
        ) {
          this.deps.ralphLoopService.cancelLoop(cancellingTask);
        }
        await cancelTaskImpl(msg.taskId, this.deps.getLifecycleDeps());
        await this.deps.scheduleService?.recordTaskTerminalOutcome(msg.taskId, 'cancelled');
        await this.deps.tryPromotePending();
        return { duplicate: false };
      }

      case 'reopenTask':
        this.deps.taskStore.reopenTask(msg.taskId);
        return { duplicate: false };

      case 'deleteTask':
        await deleteTask(this.deps.getLifecycleDeps(), msg.taskId);
        return { duplicate: false };

      case 'renameTask':
        this.deps.taskStore.renameTask(msg.taskId, msg.name);
        return { duplicate: false };

      case 'setTaskPriority':
        this.deps.taskStore.setTaskPriority(msg.taskId, msg.priority);
        return { duplicate: false };

      case 'clearCompleted': {
        // Default scope sweeps user-initiated terminal states: 'completed' AND
        // 'cancelled'. Both are states the user deliberately drove to and both
        // appear under the "Completed" pane in the UI. 'terminated' (session
        // died without user ack) stays opt-in via includeTerminated because
        // the user may not have noticed the death yet. Cancellation audit is
        // already preserved via the 'task_cancelled' event in the interaction
        // log and via predelete tasks.json snapshots, so sweeping the visible
        // entry loses no history. See rfc-task-loss-prevention.md D2
        // (revised 2026-04-23).
        const includeTerminated = msg.includeTerminated === true;
        const allTasks = this.deps.taskStore.listTasks();
        const toClear = allTasks.filter((t) => {
          if (t.status === 'completed' || t.status === 'cancelled') return true;
          if (includeTerminated && t.status === 'terminated') return true;
          return false;
        });
        if (toClear.length > 0) {
          // Take a predelete snapshot BEFORE any in-memory mutation so recovery
          // is possible from disk even if the dashboard click was unintended.
          // If the snapshot fails, abort the delete — silently proceeding would
          // recreate the data-loss pipeline this whole RFC is preventing.
          if (this.deps.takePredeleteSnapshot) {
            try {
              await this.deps.takePredeleteSnapshot();
            } catch (err) {
              console.error('[clearCompleted] predelete snapshot failed, aborting delete to prevent unrecoverable data loss:', err);
              return { duplicate: false };
            }
          }
          // Bundle gc: skip task IDs that have an in-flight reflect task pointing
          // at them — the reflect must keep reading its bundle.
          const inFlightReflectSourceIds = new Set<string>();
          for (const t of this.deps.taskStore.listTasks()) {
            if (t.reflectMeta?.sourceTaskId && !isTerminalStatusForReflect(t.status)) {
              inFlightReflectSourceIds.add(t.reflectMeta.sourceTaskId);
            }
          }

          for (const task of toClear) {
            if (!this.deps.taskStore.getTask(task.id)) continue;
            // Unregister any remaining agent entries from the monitor
            // (defensive: sessions should already be cleaned up, but handles edge cases)
            for (const session of task.sessions) {
              this.deps.monitor.unregisterAgent(session.tmuxSession);
            }
            this.deps.taskStore.deleteTask(task.id);
            // Bundle gc — best effort, never blocks
            if (this.deps.feedbackDir && !inFlightReflectSourceIds.has(task.id)) {
              const bundleTaskDir = join(this.deps.feedbackDir, task.id);
              rm(bundleTaskDir, { recursive: true, force: true }).catch(() => {});
            }
          }
        }
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
   * Persist feedback, write the bundle snapshot, log the interaction event, and
   * optionally spawn a reflect task. Mode controls which interaction event type
   * is emitted: `submit` for first-write inside completeTask, `amend` for
   * post-completion changes via setTaskFeedback.
   *
   * Failures here are fail-open and logged — feedback is enrichment, never a
   * blocker for the completion lifecycle.
   */
  private async applyFeedback(
    taskId: string,
    feedback: TaskCompletionFeedback,
    mode: 'submit' | 'amend',
    requestReflect?: boolean,
  ): Promise<void> {
    const task = this.deps.taskStore.getTask(taskId);
    if (!task) return;
    const changed = this.deps.taskStore.setCompletionFeedback(taskId, feedback);
    if (!changed) {
      // No-op amendment (deep-equal to existing) — suppress event emit and reflect spawn
      return;
    }

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

    // Write feedback bundle snapshot. Best-effort.
    let bundlePath: string | undefined;
    if (
      this.deps.feedbackDir &&
      this.deps.hooksDir &&
      this.deps.readInteractionLogSnapshot
    ) {
      try {
        const result = await writeFeedbackBundle(task, feedback, {
          feedbackDir: this.deps.feedbackDir,
          hooksDir: this.deps.hooksDir,
          readInteractionLog: this.deps.readInteractionLogSnapshot,
        });
        bundlePath = result.bundlePath;
      } catch (err) {
        console.warn(`[feedback] bundle write failed for ${taskId}:`, err);
      }
    }

    // Legacy clients omit requestReflect; preserve the old thumbs-down auto-reflect behavior.
    const shouldReflect = requestReflect ?? feedback.rating === 'down';
    if (
      shouldReflect &&
      bundlePath &&
      this.deps.reflectWorktreesDir &&
      this.deps.launchTask
    ) {
      const result = await requestTaskReflect(
        { sourceTaskId: taskId, bundlePath, direction: feedback.rating },
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
}

/**
 * Sanitize a feedback note before persistence:
 *   - hard-truncate to 500 chars
 *   - redact known secret prefixes
 */
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

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bghp_[A-Za-z0-9]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, // JWT
  /\bxoxb-[A-Za-z0-9-]{16,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/g,
  /\bhf_[A-Za-z0-9]{16,}\b/g,
  /\bnpm_[A-Za-z0-9]{16,}\b/g,
  /\bpypi-[A-Za-z0-9_-]{16,}\b/g,
  /\bdckr_pat_[A-Za-z0-9_-]{16,}\b/g,
  /\bya29\.[A-Za-z0-9_-]+\b/g,
  /-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g,
];

function redactSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

/** Reflect tasks whose own status is non-terminal still need their bundle. */
function isTerminalStatusForReflect(status: string): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'terminated';
}

/**
 * Find the most recent bundle dir under `<feedbackDir>/<taskId>/`. Bundles are
 * named with timestamp slugs so lex-sorting newest-last is reliable.
 */
async function findLatestBundleDir(
  feedbackDir: string | undefined,
  taskId: string,
): Promise<string | undefined> {
  if (!feedbackDir) return undefined;
  const taskDir = join(feedbackDir, taskId);
  const { readdir } = await import('node:fs/promises');
  let entries: string[] = [];
  try {
    entries = (await readdir(taskDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return undefined;
  }
  if (entries.length === 0) return undefined;
  return join(taskDir, entries[entries.length - 1]);
}
