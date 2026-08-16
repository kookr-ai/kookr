import type { Task, TaskStore } from '../core/tasks.js';
import type { TerminationCause } from '../core/task-status.js';
import type { Monitor } from '../core/monitor.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { Watchdog } from '../core/watchdog.js';
import type { AgentEvent } from '../core/types.js';
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
import { evaluateCriteriaVerdict } from '../core/criteria-verdict.js';
import type { TelegramTaskOutcome } from '../shared/contracts/telegram.js';
import type { TaskTailStore } from '../core/task-tail-store.js';
import {
  stampTaskCompletionProvenance,
  type CompletionPath,
} from '../core/lesson-decision.js';
import { appendAuditRow } from '../core/audit-log.js';
import {
  planTerminalClassification,
  type TerminalClassificationPlan,
  type ProviderTransientRetryRequest,
  type ProviderTransientAlertRequest,
} from '../core/silent-failure-classifier.js';

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
  /** Live default used by completion paths that omit a per-task override. */
  getCleanupWorktreeOnComplete?: () => boolean;
  /** Configured root for ephemeral reflection worktrees. */
  reflectWorktreesDir?: string;
  /**
   * Issue-claim registry (RFC rfc-issue-ownership-lock). Carried here so the
   * reconcile call sites (lifecycle-timers) can release claims for
   * reconcile-driven terminal transitions (R9). Absent when
   * KOOKR_ISSUE_CLAIMS is off.
   */
  issueClaimRegistry?: {
    safeReleaseAllFor(
      taskId: string,
      reason?: 'released' | 'dead_reclaim' | 'orphan_reclaim',
    ): Array<{ repo: string; number: number }>;
  };
  /**
   * Optional remote-chat back-channel for terminal task outcomes. Implementers
   * must isolate their own failures so lifecycle transitions cannot be blocked.
   */
  onTaskOutcome?: (taskId: string, outcome: TelegramTaskOutcome) => void;
  /**
   * Notify the schedule service when a task reaches a terminal outcome so
   * consecutiveFailures / auto-pause stay accurate (issue #2353). Optional —
   * absent in tests / minimal wirings. Must not throw into the lifecycle path.
   */
  recordScheduleTaskTerminal?: (
    taskId: string,
    status: 'completed' | 'cancelled',
  ) => void | Promise<void>;
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

  // AI-generate a short task name. Tasks are now named from birth (issue
  // #1554): a task with no explicit name carries the deterministic placeholder
  // and `autoNamed=true`, which the LLM namer may upgrade. Skip only when the
  // name is authoritative (explicit playbook/user name, `autoNamed` absent).
  if (!task.name || task.autoNamed) {
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
  adapter: {
    stop(tmuxName: string): Promise<void>;
    /** Optional — when present, session stop paths snapshot a durable tail first. */
    captureDisplay?(tmuxName: string): Promise<string>;
  };
  monitor: { unregisterAgent(agentId: string): void; getAgentEvents?(agentId: string): AgentEvent[] };
  taskStore: TaskStore;
  interactionLog?: DeferredInteractionLogWriter;
  hookWatcher?: { stop(tmuxName: string): void };
  watchdog?: { unregisterAgent(agentId: string): void };
  shadowRegistry?: { unregisterAgent(agentId: string): void };
  tokenTracker?: {
    unregister(transcriptPath: string): void;
    /**
     * Drop every transcript for a task on terminal transition (issue #1620,
     * change d). Covers subagent (sidechain) transcripts registered under the
     * parent task id, which the per-session {@link unregister} path never
     * reached — leaving them re-scanned every 5s for the process lifetime.
     */
    unregisterTask?(taskId: string): void;
  };
  suppressionTracker?: { reset(agentId: string): void };
  /** Optional queue — used to clear task-keyed snoozes on terminal transitions. */
  queue?: Pick<AttentionQueue, 'purgeTask'>;
  terminalInputCoordinator?: Pick<TerminalInputCoordinator, 'cleanupSession'>;
  /** Workspace lease service — releases leases on task completion (Phase 1b). */
  leaseService?: { release(worktreePath: string, ownerId: string): boolean };
  /** Workspace attempt repository — records cleanup attempts (Phase 1b). */
  attemptRepository?: import('../core/workspace-attempt-repository.js').WorkspaceAttemptRepository;
  /**
   * Issue-claim registry — releases issue-ownership claims on terminal
   * transitions (RFC rfc-issue-ownership-lock R8/R9b). Absent when
   * KOOKR_ISSUE_CLAIMS is off; safeReleaseAllFor never throws.
   */
  issueClaimRegistry?: {
    safeReleaseAllFor(
      taskId: string,
      reason?: 'released' | 'dead_reclaim' | 'orphan_reclaim',
    ): Array<{ repo: string; number: number }>;
  };
  /** Live default used when a completion request omits its per-task override. */
  getCleanupWorktreeOnComplete?: () => boolean;
  /** Configured root for ephemeral reflection worktrees. */
  reflectWorktreesDir?: string;
  /**
   * Optional remote-chat back-channel for terminal task outcomes. Implementers
   * must isolate their own failures so lifecycle transitions cannot be blocked.
   */
  onTaskOutcome?: (taskId: string, outcome: TelegramTaskOutcome) => void;
  /**
   * Notify the schedule service on terminal task outcomes so consecutiveFailures
   * / auto-pause stay accurate for live terminate paths (timeout reaper,
   * issue #2353). Optional — absent in tests / minimal wirings. Must not throw
   * into the lifecycle path (wrapped by the caller).
   */
  recordScheduleTaskTerminal?: (
    taskId: string,
    status: 'completed' | 'cancelled',
  ) => void | Promise<void>;
  /**
   * Durable terminal-tail store (rfc-task-tail-retrieval). When set, live
   * sessions are snapshotted before `adapter.stop` so completed tasks remain
   * peekable for the configured retention window.
   */
  taskTailStore?: Pick<TaskTailStore, 'save' | 'removeByTaskId'>;
  /**
   * In-memory GitHub ref store. Delete and clear-completed drop the finished
   * task's rows so a later poll cannot walk orphan refs after the task
   * record is gone. Terminal-but-still-present tasks are skipped by the
   * scanner itself and keep their last-known snapshot.
   */
  githubStateStore?: Pick<
    import('../core/github-state-store.js').GitHubStateStore,
    'removeTask'
  >;
  /**
   * Shared `audit.jsonl` path (issue #1712). When set, the silent-failure guard
   * writes `task.reclassifiedFailed` / `task.retrySpawned` rows so a
   * reclassified provider-transient failure and any auto-retry are queryable.
   * Best-effort — a missing path simply skips the audit rows.
   */
  auditLogPath?: string;
  /**
   * Bounded auto-retry hook for a schedule-provenance `provider_transient`
   * failure (issue #1712). Absent → no auto-retry (reclassification + alert
   * still fire); the schedule's own next cron remains the backstop.
   */
  providerTransientRetry?: (req: ProviderTransientRetryRequest) => void | Promise<void>;
  /**
   * Operator-alert hook fired when a `provider_transient` failure exhausts its
   * retry budget (issue #1712). Absent → no alert. The real implementation
   * raises a critical operator alert — the 2026-07-30 incident starved silently
   * because an exhausted retryable failure produced no operator signal at all.
   */
  providerTransientAlert?: (req: ProviderTransientAlertRequest) => void | Promise<void>;
}

/** Resolve the owning task for a session without requiring a full TaskStore mock. */
function findOwningTask(taskStore: TaskStore, tmuxName: string): Task | undefined {
  const store = taskStore as TaskStore & {
    findTaskBySession?: (name: string) => Task | undefined;
    listTasks?: () => Task[];
  };
  if (typeof store.findTaskBySession === 'function') {
    return store.findTaskBySession(tmuxName);
  }
  if (typeof store.listTasks === 'function') {
    return store.listTasks().find((t) => t.sessions.some((s) => s.tmuxSession === tmuxName));
  }
  return undefined;
}

function unregisterTranscript(tmuxName: string, deps: LifecycleDeps): void {
  if (!deps.tokenTracker) return;
  const task = findOwningTask(deps.taskStore, tmuxName);
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
 * Best-effort snapshot of a session's terminal output into the durable
 * task-tail store. Never throws — completion must not fail because capture
 * or disk write failed (rfc-task-tail-retrieval R6).
 */
async function persistSessionTailBestEffort(
  taskId: string,
  tmuxName: string,
  deps: LifecycleDeps,
): Promise<void> {
  if (!deps.taskTailStore || !deps.adapter.captureDisplay) return;
  try {
    const text = await deps.adapter.captureDisplay(tmuxName);
    await deps.taskTailStore.save({ taskId, sessionId: tmuxName, text });
  } catch (err) {
    console.warn(
      `[lifecycle] task-tail capture failed for ${tmuxName} (task ${taskId}):`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Clean up all resources associated with a single agent session.
 * Stops tmux, unregisters from monitor/watchdog/shadow, and stops hook watcher.
 * Safe to call on already-dead sessions (adapter.stop is a graceful no-op).
 * When a task id can be resolved, captures a durable terminal tail before stop.
 */
export async function cleanupSessionResources(
  tmuxName: string,
  deps: LifecycleDeps,
): Promise<void> {
  const owningTask = findOwningTask(deps.taskStore, tmuxName);
  if (owningTask) {
    await persistSessionTailBestEffort(owningTask.id, tmuxName, deps);
  }
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
      // cleanupSessionResources snapshots the tail before stop (when store is wired).
      await cleanupSessionResources(session.tmuxSession, deps);
      deps.taskStore.updateSession(task.id, session.tmuxSession, { lastStatus: finalSessionStatus });
    }
  }
  // The task is now terminal: drop any remaining transcripts for it — notably
  // subagent (sidechain) transcripts, which per-session unregister never
  // touched (issue #1620, change d).
  deps.tokenTracker?.unregisterTask?.(task.id);
}

function completeLiveSessionsInBackground(task: Task, deps: LifecycleDeps): void {
  for (const session of task.sessions) {
    if (session.lastStatus !== 'completed' && session.lastStatus !== 'aborted') {
      deps.taskStore.updateSession(task.id, session.tmuxSession, { lastStatus: 'completed' });
      unregisterTranscript(session.tmuxSession, deps);
      forgetSessionBookkeeping(session.tmuxSession, deps);
      void (async () => {
        await persistSessionTailBestEffort(task.id, session.tmuxSession, deps);
        await deps.adapter.stop(session.tmuxSession);
      })().catch((err) => {
        console.warn(
          `[lifecycle] background cleanup failed for ${session.tmuxSession}:`,
          err instanceof Error ? err.message : err,
        );
      });
    }
  }
  // Terminal transition: drop remaining transcripts (incl. subagent sidechains)
  // so they stop being re-scanned every 5s (issue #1620, change d).
  deps.tokenTracker?.unregisterTask?.(task.id);
}

/**
 * Reclaim a reflect task's ephemeral worktree on terminal transition, so it is
 * removed immediately instead of lingering until the next startup or scheduled
 * lifecycle-timer sweep (issue #1860). No-op for non-reflect tasks.
 * Fire-and-forget: never blocks or fails the transition;
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
function cleanupReflectWorktree(task: Task, deps: LifecycleDeps): void {
  const worktreePath = task.reflectMeta?.worktreePath;
  if (!worktreePath) return;
  const removal = deps.reflectWorktreesDir
    ? removeReflectWorktree(worktreePath, deps.reflectWorktreesDir)
    : removeReflectWorktree(worktreePath);
  void removal.catch(() => {});
}

function markCompletedMissingWorktreesCleanedUp(task: Task, deps: LifecycleDeps): void {
  for (const session of task.sessions) {
    if (isMissingWorktreeHealth(session.worktreeHealth)) {
      deps.taskStore.updateSessionWorktreeHealth(task.id, session.tmuxSession, 'cleaned_up');
    }
  }
}

function captureCompletionEvents(task: Task, deps: LifecycleDeps): AgentEvent[] {
  const getAgentEvents = deps.monitor.getAgentEvents;
  if (!getAgentEvents) return [];
  return task.sessions.flatMap((session) => getAgentEvents.call(deps.monitor, session.tmuxSession));
}

function scheduleNoEventCriteriaVerdict(task: Task, events: AgentEvent[], deps: LifecycleDeps): void {
  if (!task.criteria?.trim() || events.length > 0) return;
  void (async () => {
    const verdict = await evaluateCriteriaVerdict({
      criteria: task.criteria,
      events,
      llmClient: null,
    });
    if (!verdict) return;
    deps.taskStore.setCriteriaVerdict(task.id, verdict);
  })().catch((err) => {
    console.warn(
      `[completion] criteria verdict failed for ${task.id}:`,
      err instanceof Error ? err.message : err,
    );
  });
}

function notifyTaskOutcome(deps: LifecycleDeps, taskId: string, outcome: TelegramTaskOutcome): void {
  try {
    deps.onTaskOutcome?.(taskId, outcome);
  } catch (err) {
    console.warn('[lifecycle] onTaskOutcome threw:', err);
  }
}

/**
 * Complete a task: mark completed immediately, then stop active sessions in
 * the background so a slow terminal shutdown does not block the dashboard.
 */
export async function completeTask(
  taskId: string,
  deps: LifecycleDeps,
  opts: {
    cleanupWorktree?: boolean;
    /** Actor source for completionPath stamping (issue #1608). */
    actorSource?: string;
    /** Override inferred completion path. */
    completionPath?: CompletionPath;
    /** Override default lessonGateExempt when undecided. */
    lessonGateExempt?: string;
    /** When true, do not stamp lessonGateExempt (decision already verified). */
    decisionSatisfied?: boolean;
    /**
     * Override the interaction-log `task_completed` reason (default
     * `'user_marked'`). Used by system-driven force-completes — e.g. the
     * finishedAwaitingAck TTL reclaim (issue #1884) stamps
     * `'finished_awaiting_ack_ttl'`, meta FAA auto-complete (issue #2070)
     * stamps `'finished_awaiting_ack_auto_complete'`, and the ack-path reaper
     * (issue #2170) stamps `'finished_awaiting_ack_ack_reap'`, and the
     * terminal-success verdict auto-complete (issue #2532) — an agent parked in
     * `needs_input` with an unambiguous success verdict — stamps
     * `'terminal_success_auto_complete'`, so the log distinguishes autonomous
     * slot reclaim from a manual ack.
     */
    interactionLogReason?:
      | 'user_marked'
      | 'finished_awaiting_ack_ttl'
      | 'finished_awaiting_ack_capacity_pressure'
      | 'finished_awaiting_ack_auto_complete'
      | 'finished_awaiting_ack_ack_reap'
      | 'terminal_success_auto_complete';
  } = {},
): Promise<void> {
  const task = deps.taskStore.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  const completionEvents = captureCompletionEvents(task, deps);

  // Silent-failure integrity guard (issue #1712). A terminal turn that made
  // ZERO tool calls and whose final message is a provider/transport error
  // (`529 Overloaded`, `API Error`, 429/5xx, rate limit) is never a real
  // completion — it is a `provider_transient` failure. Recording it `completed`
  // is exactly what starved the pipeline on 2026-07-30 (task dae17e59). Only an
  // in-progress task can be reclassified: acking an already-terminated task to
  // `completed` is a deliberate operator action, not a silent failure.
  if (task.status === 'inProgress') {
    const plan = planTerminalClassification({
      events: completionEvents,
      provenanceKind: task.provenance?.kind,
      priorRetryAttempts: task.retryAttempt ?? 0,
    });
    if (plan.reclassifyToFailed) {
      await reclassifyProviderTransientFailure(task, plan, deps);
      return;
    }
  }

  // Stamp completion provenance on the live record before the status
  // transition so yield v2 can join decision buckets onto the path
  // (issue #1608). Uses getTaskForMutation so the stamp survives.
  // Optional-call: unit fixtures often mock TaskStore with only the methods
  // the scenario needs — missing getTaskForMutation must not crash complete.
  const getForMutation = (
    deps.taskStore as TaskStore & {
      getTaskForMutation?: (id: string) => Task | undefined;
    }
  ).getTaskForMutation;
  const mutable = typeof getForMutation === 'function' ? getForMutation.call(deps.taskStore, taskId) : undefined;
  if (mutable) {
    stampTaskCompletionProvenance(mutable, {
      actorSource: opts.actorSource,
      explicitPath: opts.completionPath,
      gateExempt: opts.lessonGateExempt,
      decisionSatisfied: opts.decisionSatisfied,
    });
  }

  completeLiveSessionsInBackground(task, deps);
  deps.queue?.purgeTask(taskId);
  deps.taskStore.completeTask(taskId);
  markCompletedMissingWorktreesCleanedUp(task, deps);
  scheduleNoEventCriteriaVerdict(task, completionEvents, deps);

  await deps.interactionLog?.append({
    type: 'task_completed',
    taskId,
    agentId: task.sessions[0]?.tmuxSession ?? '',
    reason: opts.interactionLogReason ?? 'user_marked',
    durationMs: Date.now() - task.createdAt.getTime(),
    timestamp: nowISO(),
  });

  // Release worktree leases for this task
  releaseTaskLeases(task, taskId, deps);
  // Release issue-ownership claims (RFC R8; safeReleaseAllFor never throws, R9b)
  deps.issueClaimRegistry?.safeReleaseAllFor(taskId, 'released');
  notifyTaskOutcome(deps, taskId, { kind: 'completed' });

  // Fire-and-forget worktree cleanup — does not block the caller. The explicit
  // completion choice wins over the live setting; the historical default is
  // enabled so clients that omit the new field retain the old behavior.
  const shouldCleanupWorktree = opts.cleanupWorktree
    ?? deps.getCleanupWorktreeOnComplete?.()
    ?? true;
  if (shouldCleanupWorktree) {
    cleanupTaskWorktrees(deps.taskStore, taskId, deps.interactionLog).catch(() => {});
  }
  cleanupReflectWorktree(task, deps);
}

/** Cap the audited provider-error detail so a huge final message can't bloat audit.jsonl. */
const MAX_PROVIDER_ERROR_DETAIL = 500;

function truncateProviderErrorDetail(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const trimmed = message.trim();
  return trimmed.length > MAX_PROVIDER_ERROR_DETAIL
    ? `${trimmed.slice(0, MAX_PROVIDER_ERROR_DETAIL)}…`
    : trimmed;
}

/**
 * Reclassify a would-be completion as a `provider_transient` failure (issue
 * #1712): terminate instead of complete, write the audit trail, and either
 * schedule a bounded auto-retry (schedule provenance, budget remaining) or emit
 * one operator alert (budget spent). Retry/alert are optional injected hooks —
 * when unwired, the reclassification + audit still fire, and the schedule's next
 * cron stays the backstop.
 */
async function reclassifyProviderTransientFailure(
  task: Task,
  plan: TerminalClassificationPlan,
  deps: LifecycleDeps,
): Promise<void> {
  const detail = truncateProviderErrorDetail(plan.matchedMessage);
  // Reuse the terminate path so session teardown, lease/claim release, outcome
  // notification, and worktree cleanup all match a normal failed termination.
  await terminateTask(task.id, deps, { reason: 'provider_transient', detail });

  const originalTaskId = task.retryOf ?? task.id;
  const priorRetryAttempts = task.retryAttempt ?? 0;

  await appendAuditRow(deps.auditLogPath, {
    type: 'task.reclassifiedFailed',
    timestamp: nowISO(),
    actor: 'system:silent-failure-classifier',
    taskId: task.id,
    reason: 'provider_transient',
    failureClass: 'provider_transient',
    toolCallCount: plan.toolCallCount,
    provenanceKind: task.provenance?.kind ?? 'unknown',
    priorRetryAttempts,
    originalTaskId,
    ...(detail ? { matchedMessage: detail } : {}),
  });

  if (plan.retry.schedule) {
    await appendAuditRow(deps.auditLogPath, {
      type: 'task.retrySpawned',
      timestamp: nowISO(),
      actor: 'system:silent-failure-classifier',
      taskId: task.id,
      originalTaskId,
      attempt: plan.retry.attempt,
      delayMs: plan.retry.delayMs,
      reason: 'provider_transient',
    });
    try {
      await deps.providerTransientRetry?.({
        originalTaskId,
        failedTaskId: task.id,
        attempt: plan.retry.attempt,
        delayMs: plan.retry.delayMs,
        ...(detail ? { reason: detail } : {}),
      });
    } catch (err) {
      console.warn(
        `[silent-failure] provider-transient retry hook threw for ${task.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  } else if (plan.exhausted) {
    // Durable exhaustion record (issue #1712). The operator alert below is an
    // ephemeral broadcast — lost if no dashboard is connected — so also write a
    // queryable audit row: an exhausted retryable failure must never be silent.
    await appendAuditRow(deps.auditLogPath, {
      type: 'task.retryExhausted',
      timestamp: nowISO(),
      actor: 'system:silent-failure-classifier',
      taskId: task.id,
      originalTaskId,
      attempts: priorRetryAttempts,
      reason: 'provider_transient',
    });
    try {
      await deps.providerTransientAlert?.({
        failedTaskId: task.id,
        originalTaskId,
        attempts: priorRetryAttempts,
        ...(detail ? { reason: detail } : {}),
      });
    } catch (err) {
      console.warn(
        `[silent-failure] provider-transient alert hook threw for ${task.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Terminate a task: session(s) died without user ack. Mirrors completeTask
 * but transitions to 'terminated' so the user must acknowledge (→ completed)
 * or reopen (→ open) before the task is sweepable by "Clear completed".
 *
 * Invoked from reconciliation when all sessions are dead on an in-progress
 * task. See rfc-task-loss-prevention.md D1.
 *
 * `cause` records why the task died (issue #1664); it defaults to `unknown`
 * (a likely crash) when the caller has no better classification.
 */
export async function terminateTask(
  taskId: string,
  deps: LifecycleDeps,
  cause?: TerminationCause,
): Promise<void> {
  const task = deps.taskStore.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  await stopAllLiveSessions(task, deps, 'completed');
  deps.queue?.purgeTask(taskId);
  deps.taskStore.terminateTask(taskId, cause);

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
  // Release issue-ownership claims — dead sessions = confirmed-dead reclaim (RFC R9/R12)
  deps.issueClaimRegistry?.safeReleaseAllFor(taskId, 'dead_reclaim');
  notifyTaskOutcome(deps, taskId, { kind: 'failed' });

  // Live terminate (timeout reaper, session death) must count toward schedule
  // consecutiveFailures so thrashing loops fail-closed-pause (issue #2353).
  // Count as cancelled (non-success); never block terminate on schedule I/O.
  try {
    await deps.recordScheduleTaskTerminal?.(taskId, 'cancelled');
  } catch (err) {
    console.warn(
      `[lifecycle] recordScheduleTaskTerminal failed for ${taskId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // Fire-and-forget worktree cleanup — does not block the caller
  cleanupTaskWorktrees(deps.taskStore, taskId, deps.interactionLog).catch(() => {});
  cleanupReflectWorktree(task, deps);
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
  // Release issue-ownership claims (RFC R8; safeReleaseAllFor never throws, R9b)
  deps.issueClaimRegistry?.safeReleaseAllFor(taskId, 'released');

  deps.taskStore.cancelTask(taskId);
  notifyTaskOutcome(deps, taskId, { kind: 'cancelled' });

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
  cleanupReflectWorktree(task, deps);
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
  /** True when promoted launches should be audited as running without permission prompts. */
  bypassAllPermissions?: boolean;
}

/**
 * Whether a pending task can be expected to release its slot without a human
 * (issue #1526 Phase C / C3, promotion posture guard). Two shapes qualify:
 *
 * - `autoCloseOnSignal: true` — the task auto-completes after its
 *   completion-ready signal's grace period, no manual ack needed;
 * - schedule-fired launches (`metadata.launchSource === 'schedule'`) — they
 *   run under schedule supervision (coalescing, blocking-task staleness gate,
 *   dead-man alerting), so a wedged one is detected and recovered without a
 *   human ack.
 * - idle-refinery launches (`metadata.launchSource === 'idle-refinery'`, issue
 *   #2144) — the autonomous idle-slot refinery only files leaf issues and exits;
 *   it must never park in `finishedAwaitingAck` and re-wedge the last slot it
 *   was spawned into.
 *
 * Everything else (ask-first / no-autoclose tasks) parks in
 * `finishedAwaitingAck` until a human clicks — exactly the class that
 * re-wedged the cap in the 2026-07-24 incident (FM11).
 */
function isSelfReleasingPending(task: Pick<Task, 'autoCloseOnSignal' | 'metadata'>): boolean {
  return task.autoCloseOnSignal === true
    || task.metadata?.launchSource === 'schedule'
    || task.metadata?.launchSource === 'idle-refinery';
}

/**
 * Pick the next pending task to promote (issue #1526 Phase C / C3, FM11
 * anti-re-wedge). With more than one free slot this is plain FIFO — identical
 * to the old `getNextPending()` behavior. When promoting would fill the LAST
 * free slot, self-releasing pendings (see {@link isSelfReleasingPending}) are
 * PREFERRED: the FIFO order is stable-sorted with self-releasing tasks first,
 * never skipping anyone. In the incident, freed slots were instantly refilled
 * by FIFO promotion of ask-first pendings that then parked awaiting ack,
 * re-wedging the cap; this preference keeps the last slot cycling.
 *
 * Pure ordering preference — NO starvation: if only ask-first tasks are
 * pending, the oldest one still promotes into the last slot exactly as
 * before.
 */
export function pickNextPendingForPromotion(taskStore: TaskStore, freeSlots: number): Task | undefined {
  if (freeSlots > 1) return taskStore.getNextPending();
  // Last free slot: FIFO within each posture class, self-releasing first.
  const eligible = taskStore
    .listTasks({ status: 'pending' })
    .filter((task) => !taskStore.hasFreshLaunchReservation(task.id))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  if (eligible.length === 0) return undefined;
  return eligible.find(isSelfReleasingPending) ?? eligible[0];
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

  for (;;) {
    const activeCount = taskStore.getActiveCount();
    if (!(activeCount < maxActive)) break;
    // Posture guard (issue #1526 Phase C / C3): the pick prefers
    // self-releasing tasks when this promotion would fill the last free slot.
    const pending = pickNextPendingForPromotion(taskStore, maxActive - activeCount);
    if (!pending) break;

    // Safety: prevent infinite loop if a task stays pending after launch
    if (seen.has(pending.id)) {
      console.error(`[promotion] Task ${pending.id} still pending after launch — breaking to prevent infinite loop`);
      taskStore.cancelTask(pending.id);
      break;
    }
    seen.add(pending.id);

    // #700 fix: synchronous pick-to-launch reservation. Concurrent
    // promotePendingTasks invocations (5s liveness tick + completion-triggered
    // promotions) all passed getNextPending for the SAME task because its
    // status only flips when the adapter attaches a session, seconds later.
    // beginLaunch is a synchronous CAS — exactly one promoter wins; losers
    // skip (the task no longer shows in getNextPending while reserved).
    if (!taskStore.beginLaunch(pending.id)) continue;

    try {
      const adapter = adapterRegistry.get(pending.agentType);
      const launchPrompt = pending.launchNote ? `${pending.launchNote}\n\n${pending.prompt}` : pending.prompt;
      await adapter.launch(pending.id, launchPrompt, pending.cwd);
      if (deps.bypassAllPermissions === true) {
        const launchPermissionPosture = {
          bypassAllPermissions: true as const,
          mode: 'bypass-all' as const,
          capturedAt: nowISO(),
        };
        taskStore.setLaunchPermissionPosture(pending.id, launchPermissionPosture);
        await lifecycleDeps.interactionLog?.append({
          type: 'task_launch_permission_posture',
          taskId: pending.id,
          agentType: pending.agentType,
          bypassAllPermissions: true,
          mode: 'bypass-all',
          timestamp: launchPermissionPosture.capturedAt,
        });
      } else {
        taskStore.setLaunchPermissionPosture(pending.id, undefined);
      }
      const launched = taskStore.getTask(pending.id);
      if (!launched) throw new Error(`Task disappeared after launch: ${pending.id}`);
      await registerNewAgent(launched, lifecycleDeps);
      promoted++;
    } catch (err) {
      // If launch fails, cancel the task rather than leaving it pending forever
      console.error(`[promotion] Failed to launch pending task ${pending.id}:`, err);
      taskStore.cancelTask(pending.id);
    } finally {
      // Success: addSession already consumed the reservation (task is
      // inProgress). Failure: release so the record isn't left reserved.
      taskStore.endLaunch(pending.id);
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
