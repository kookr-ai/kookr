import type { Task, TaskStore } from '../core/tasks.js';
import type { Monitor } from '../core/monitor.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { Watchdog } from '../core/watchdog.js';
import type { HookFileWatcher } from './hook-watcher.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import { nowISO } from '../core/interaction-log.js';
import type { GitHubScannerService } from '../core/github-scanner-service.js';
import type { AgentAdapter } from '../adapters/agent-adapter.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { MAX_ACTIVE_TASKS } from './config.js';
import { cleanupTaskWorktrees } from '../adapters/git-worktree.js';
import { getProjectId, deriveCanonicalPath } from '../core/project-identity.js';
import { isMissingWorktreeHealth } from '../core/worktree-health.js';
import { displayPromptForTask } from '../core/prompt-display.js';
import type { ProjectConfigStore } from '../core/project-config-store.js';
import { createSnapshotMessage } from './use-cases/get-snapshot.js';
import { removeReflectWorktree } from './use-cases/request-task-reflect.js';
import type { TerminalInputCoordinator } from './terminal-input-coordinator.js';

// ---------------------------------------------------------------------------
// Post-launch registration (used by WS handler and REST routes)
// ---------------------------------------------------------------------------

export interface AgentLifecycleDeps {
  monitor: Monitor;
  watchdog: Watchdog;
  hookWatcher: HookFileWatcher;
  interactionLog?: DeferredInteractionLogWriter;
  githubScanner: GitHubScannerService;
  autoNameTask: (taskId: string, prompt: string, cwd: string, criteria?: string) => void;
  taskStore?: TaskStore;
  /**
   * Optional project-config store. When supplied, the lifecycle stamps
   * ProjectConfig.localPath on first task start so the launch dialog can
   * pre-fill the cwd field for project-drawer launches.
   */
  projectConfigStore?: ProjectConfigStore;
  terminalInputCoordinator?: Pick<TerminalInputCoordinator, 'registerSession'>;
}

/**
 * Performs the full post-launch registration sequence for a newly launched task.
 *
 * This is the single place that registers an agent with the monitor, watchdog,
 * hook file watcher, interaction log, GitHub scanner, and AI task naming.
 * All code paths that launch agents (WS messages, REST API) call this function.
 */
export async function registerNewAgent(task: Task, deps: AgentLifecycleDeps): Promise<void> {
  const { monitor, watchdog, hookWatcher, interactionLog, githubScanner, autoNameTask } = deps;

  // Register only live sessions — skip completed, aborted, or crash-recovered ones.
  // After crash recovery, a task may have old dead sessions alongside the new one;
  // registering dead sessions creates ghost agents in the monitor with false anomalies.
  for (const session of task.sessions) {
    if (session.lastStatus === 'completed' || session.lastStatus === 'aborted' || session.crashRecovered) {
      continue;
    }
    monitor.registerAgent(session.tmuxSession);
    deps.terminalInputCoordinator?.registerSession(session.tmuxSession);
    watchdog.registerAgent(session.tmuxSession);
    if (!hookWatcher.isWatching(session.tmuxSession)) {
      hookWatcher.watch(session.tmuxSession, { replayExisting: true });
    }
  }

  // Log the launch event
  const launchedSession = task.sessions[task.sessions.length - 1];
  await interactionLog?.append({
    type: 'agent_launched',
    agentId: launchedSession?.tmuxSession ?? task.id,
    taskPrompt: task.prompt,
    timestamp: new Date().toISOString(),
  });

  // Scan task prompt for GitHub issue/PR references
  if (githubScanner.isActive()) {
    void githubScanner.processTaskPrompt(task.id);
  }

  // AI-generate a short task name (skip if task already has a name, e.g., playbooks)
  if (!task.name) {
    autoNameTask(task.id, displayPromptForTask(task), task.cwd, task.criteria);
  }

  // Resolve project identity (fire-and-forget — non-blocking).
  // Also stamp ProjectConfig.localPath on first task start so the launch
  // dialog can pre-fill the cwd for project-drawer launches. The store
  // call awaits its own save, so a process crash immediately after stamping
  // does not lose the value.
  if (!task.projectId && deps.taskStore) {
    const store = deps.taskStore;
    const configStore = deps.projectConfigStore;
    getProjectId(task.cwd)
      .then(async (projectId) => {
        store.setProjectId(task.id, projectId);
        if (configStore) {
          const canonical = deriveCanonicalPath(task.cwd);
          if (canonical) {
            await configStore.setLocalPathIfUnset(projectId, canonical);
          }
        }
      })
      .catch((err) => {
        // Best-effort — git failures (no remote) and config-store save
        // failures (ENOSPC, EROFS) are both non-fatal here; the task has
        // already launched. Log so a real disk problem does not stay
        // silent for ops.
        console.error('[lifecycle] projectId/localPath resolution failed:', err);
      });
  }
}

// ---------------------------------------------------------------------------
// Terminal input: clear anomaly state on user interaction
// ---------------------------------------------------------------------------

export interface TerminalInputDeps {
  monitor: Monitor;
  watchdog?: Pick<Watchdog, 'recordInputReceived'>;
  abortPendingSuggestion: (agentId: string, outcome?: 'used' | 'cleared') => void;
  broadcastToAll: (msg: ServerMessage) => void;
  serverCwd: string;
  /** Optional task-store reference for snapshot relation projection (#601). */
  taskStore?: TaskStore;
}

/**
 * Handle Enter-key input on a terminal session: clear needs_input /
 * permission_blocked anomaly state, abort any pending suggestion, and
 * broadcast an updated snapshot.
 */
export function handleTerminalInput(
  deps: TerminalInputDeps,
  sessionName: string,
): void {
  const changed = deps.monitor.markInputReceived(sessionName);
  if (changed) {
    deps.watchdog?.recordInputReceived(sessionName);
    deps.abortPendingSuggestion(sessionName);
    deps.broadcastToAll(createSnapshotMessage({
      monitor: deps.monitor,
      serverCwd: deps.serverCwd,
      ...(deps.taskStore ? { relationTaskStore: deps.taskStore } : {}),
    }));
  }
}

/**
 * Handle any keystroke on a terminal session.  Only acts when the agent is
 * permission-blocked (single-char responses like 'y'/'a'/'n' don't require
 * Enter).
 */
export function handleTerminalKeystroke(
  deps: TerminalInputDeps,
  sessionName: string,
): void {
  if (deps.monitor.isPermissionBlocked(sessionName)) {
    handleTerminalInput(deps, sessionName);
  }
}

// ---------------------------------------------------------------------------
// Task completion / cancellation
// ---------------------------------------------------------------------------

/**
 * Dependencies for task completion/cancellation operations.
 * Uses structural typing so callers can pass any matching objects.
 */
export interface LifecycleDeps {
  adapter: { stop(tmuxName: string): Promise<void> };
  monitor: { unregisterAgent(agentId: string): void };
  taskStore: TaskStore;
  interactionLog?: DeferredInteractionLogWriter;
  hookWatcher?: { stop(tmuxName: string): void };
  watchdog?: { unregisterAgent(agentId: string): void };
  shadowRegistry?: { unregisterAgent(agentId: string): void };
  tokenTracker?: { unregister(transcriptPath: string): void };
  suppressionTracker?: { reset(agentId: string): void };
  /** Optional queue — used to clear task-keyed snoozes on terminal transitions. */
  queue?: Pick<AttentionQueue, 'purgeTask'>;
  terminalInputCoordinator?: Pick<TerminalInputCoordinator, 'cleanupSession'>;
  /** Workspace lease service — releases leases on task completion (Phase 1b). */
  leaseService?: { release(worktreePath: string, ownerId: string): boolean };
  /** Workspace attempt repository — records cleanup attempts (Phase 1b). */
  attemptRepository?: import('../core/workspace-attempt-repository.js').WorkspaceAttemptRepository;
}

function unregisterTranscript(tmuxName: string, deps: LifecycleDeps): void {
  if (!deps.tokenTracker) return;
  const task = deps.taskStore.findTaskBySession(tmuxName);
  if (!task) return;
  for (const session of task.sessions) {
    if (session.tmuxSession === tmuxName && session.transcriptPath) {
      deps.tokenTracker.unregister(session.transcriptPath);
    }
  }
}

function forgetSessionBookkeeping(tmuxName: string, deps: LifecycleDeps): void {
  deps.monitor.unregisterAgent(tmuxName);
  deps.hookWatcher?.stop(tmuxName);
  deps.watchdog?.unregisterAgent(tmuxName);
  deps.shadowRegistry?.unregisterAgent(tmuxName);
  deps.suppressionTracker?.reset(tmuxName);
  deps.terminalInputCoordinator?.cleanupSession(tmuxName);
}

/**
 * Clean up all resources associated with a single agent session.
 * Stops tmux, unregisters from monitor/watchdog/shadow, and stops hook watcher.
 * Safe to call on already-dead sessions (adapter.stop is a graceful no-op).
 */
export async function cleanupSessionResources(
  tmuxName: string,
  deps: LifecycleDeps,
): Promise<void> {
  unregisterTranscript(tmuxName, deps);
  await deps.adapter.stop(tmuxName);
  forgetSessionBookkeeping(tmuxName, deps);
}

/**
 * Stop every live session of a task and mark its session status accordingly.
 * Shared helper for completeTask / cancelTask / terminateTask so the three
 * terminal transitions stay in lockstep.
 */
async function stopAllLiveSessions(
  task: Task,
  deps: LifecycleDeps,
  finalSessionStatus: 'completed' | 'aborted',
): Promise<void> {
  for (const session of task.sessions) {
    if (session.lastStatus !== 'completed' && session.lastStatus !== 'aborted') {
      await cleanupSessionResources(session.tmuxSession, deps);
      deps.taskStore.updateSession(task.id, session.tmuxSession, { lastStatus: finalSessionStatus });
    }
  }
}

function completeLiveSessionsInBackground(task: Task, deps: LifecycleDeps): void {
  for (const session of task.sessions) {
    if (session.lastStatus !== 'completed' && session.lastStatus !== 'aborted') {
      deps.taskStore.updateSession(task.id, session.tmuxSession, { lastStatus: 'completed' });
      unregisterTranscript(session.tmuxSession, deps);
      forgetSessionBookkeeping(session.tmuxSession, deps);
      void deps.adapter.stop(session.tmuxSession).catch((err) => {
        console.warn(
          `[lifecycle] background cleanup failed for ${session.tmuxSession}:`,
          err instanceof Error ? err.message : err,
        );
      });
    }
  }
}

/**
 * Reclaim a reflect task's ephemeral worktree on terminal transition, so it is
 * removed immediately instead of lingering until the next startup sweep. No-op
 * for non-reflect tasks. Fire-and-forget: never blocks or fails the transition;
 * `sweepReflectWorktrees` remains the crash backstop.
 *
 * This is needed even though `cleanupTaskWorktrees` runs on the same task: that
 * path *preserves* a worktree it finds dirty (a reflect agent that edited /
 * committed for the gated-PR flow leaves it dirty), whereas a reflect worktree
 * is disposable once the task ends — its branch, if any, was already pushed.
 * `removeReflectWorktree` force-removes it (and self-guards on the identity
 * marker, so the overlap with `cleanupTaskWorktrees` is a harmless no-op when
 * that path already removed a clean worktree).
 */
function cleanupReflectWorktree(task: Task): void {
  const worktreePath = task.reflectMeta?.worktreePath;
  if (!worktreePath) return;
  void removeReflectWorktree(worktreePath).catch(() => {});
}

function markCompletedMissingWorktreesCleanedUp(task: Task, deps: LifecycleDeps): void {
  for (const session of task.sessions) {
    if (isMissingWorktreeHealth(session.worktreeHealth)) {
      deps.taskStore.updateSessionWorktreeHealth(task.id, session.tmuxSession, 'cleaned_up');
    }
  }
}

/**
 * Complete a task: mark completed immediately, then stop active sessions in
 * the background so a slow terminal shutdown does not block the dashboard.
 */
export async function completeTask(
  taskId: string,
  deps: LifecycleDeps,
): Promise<void> {
  const task = deps.taskStore.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  completeLiveSessionsInBackground(task, deps);
  deps.queue?.purgeTask(taskId);
  deps.taskStore.completeTask(taskId);
  markCompletedMissingWorktreesCleanedUp(task, deps);

  await deps.interactionLog?.append({
    type: 'task_completed',
    taskId,
    agentId: task.sessions[0]?.tmuxSession ?? '',
    reason: 'user_marked',
    durationMs: Date.now() - task.createdAt.getTime(),
    timestamp: nowISO(),
  });

  // Release worktree leases for this task
  releaseTaskLeases(task, taskId, deps);

  // Fire-and-forget worktree cleanup — does not block the caller
  cleanupTaskWorktrees(deps.taskStore, taskId, deps.interactionLog).catch(() => {});
  cleanupReflectWorktree(task);
}

/**
 * Terminate a task: session(s) died without user ack. Mirrors completeTask
 * but transitions to 'terminated' so the user must acknowledge (→ completed)
 * or reopen (→ open) before the task is sweepable by "Clear completed".
 *
 * Invoked from reconciliation when all sessions are dead on an in-progress
 * task. See rfc-task-loss-prevention.md D1.
 */
export async function terminateTask(
  taskId: string,
  deps: LifecycleDeps,
): Promise<void> {
  const task = deps.taskStore.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  await stopAllLiveSessions(task, deps, 'completed');
  deps.queue?.purgeTask(taskId);
  deps.taskStore.terminateTask(taskId);

  await deps.interactionLog?.append({
    type: 'task_terminated',
    taskId,
    agentId: task.sessions[0]?.tmuxSession ?? '',
    reason: 'sessions_died',
    durationMs: Date.now() - task.createdAt.getTime(),
    timestamp: nowISO(),
  });

  // Release worktree leases for this task
  releaseTaskLeases(task, taskId, deps);

  // Fire-and-forget worktree cleanup — does not block the caller
  cleanupTaskWorktrees(deps.taskStore, taskId, deps.interactionLog).catch(() => {});
  cleanupReflectWorktree(task);
}

/**
 * Cancel a task: stop all active sessions, mark aborted,
 * log the event, and fire-and-forget worktree cleanup.
 */
export async function cancelTask(
  taskId: string,
  deps: LifecycleDeps,
): Promise<void> {
  const task = deps.taskStore.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  await stopAllLiveSessions(task, deps, 'aborted');
  deps.queue?.purgeTask(taskId);

  // Release worktree leases for this task
  releaseTaskLeases(task, taskId, deps);

  deps.taskStore.cancelTask(taskId);

  await deps.interactionLog?.append({
    type: 'task_cancelled',
    taskId,
    agentId: task.sessions[0]?.tmuxSession ?? '',
    reason: 'user_cancelled',
    durationMs: Date.now() - task.createdAt.getTime(),
    timestamp: nowISO(),
  });

  // Fire-and-forget worktree cleanup — does not block the caller
  cleanupTaskWorktrees(deps.taskStore, taskId, deps.interactionLog).catch(() => {});
  cleanupReflectWorktree(task);
}

// ---------------------------------------------------------------------------
// Pending task promotion — launch queued tasks when slots open
// ---------------------------------------------------------------------------

export interface PromotionDeps {
  taskStore: TaskStore;
  adapterRegistry: AdapterRegistry;
  lifecycleDeps: AgentLifecycleDeps;
  broadcastToAll: (msg: ServerMessage) => void;
  serverCwd: string;
  /** Live getter for max concurrent tasks. Falls back to static default if not provided. */
  getMaxActiveTasks?: () => number;
}

/**
 * Promote pending tasks to inProgress up to the concurrency limit.
 * Called after task completion, cancellation, and on startup after reconciliation.
 * Returns the number of tasks promoted.
 */
export async function promotePendingTasks(deps: PromotionDeps): Promise<number> {
  const { taskStore, adapterRegistry, lifecycleDeps, broadcastToAll, serverCwd } = deps;
  const maxActive = deps.getMaxActiveTasks?.() ?? MAX_ACTIVE_TASKS;
  let promoted = 0;
  const seen = new Set<string>();

  while (taskStore.getActiveCount() < maxActive) {
    const pending = taskStore.getNextPending();
    if (!pending) break;

    // Safety: prevent infinite loop if a task stays pending after launch
    if (seen.has(pending.id)) {
      console.error(`[promotion] Task ${pending.id} still pending after launch — breaking to prevent infinite loop`);
      taskStore.cancelTask(pending.id);
      break;
    }
    seen.add(pending.id);

    try {
      const adapter = adapterRegistry.get(pending.agentType);
      const launchPrompt = pending.launchNote ? `${pending.launchNote}\n\n${pending.prompt}` : pending.prompt;
      await adapter.launch(pending.id, launchPrompt, pending.cwd);
      const launched = taskStore.getTask(pending.id);
      if (!launched) throw new Error(`Task disappeared after launch: ${pending.id}`);
      await registerNewAgent(launched, lifecycleDeps);
      promoted++;
    } catch (err) {
      // If launch fails, cancel the task rather than leaving it pending forever
      console.error(`[promotion] Failed to launch pending task ${pending.id}:`, err);
      taskStore.cancelTask(pending.id);
    }
  }

  if (promoted > 0) {
    const monitor = lifecycleDeps.monitor as Monitor;
    broadcastToAll(createSnapshotMessage({ monitor, serverCwd, relationTaskStore: taskStore }));
  }

  return promoted;
}

// ---------------------------------------------------------------------------
// Lease management helpers (Phase 1b)
// ---------------------------------------------------------------------------

/**
 * Release worktree leases held by a task's sessions.
 * Called on task completion/cancellation to free the lease for cleanup.
 */
function releaseTaskLeases(task: Task, taskId: string, deps: LifecycleDeps): void {
  if (!deps.leaseService) return;
  for (const session of task.sessions) {
    if (session.gitIsWorktree && session.cwd) {
      deps.leaseService.release(session.cwd, taskId);
    }
  }
}
