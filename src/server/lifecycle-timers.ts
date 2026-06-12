import type { Monitor } from '../core/monitor.js';
import { isActiveStatus, type Task, type TaskStore } from '../core/tasks.js';
import type { AgentActivityMeta, AgentEvent, Anomaly, TokenUsage } from '../core/types.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { AgentAdapter } from '../adapters/agent-adapter.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import type { TokenTracker } from '../core/token-tracker.js';
import type { Watchdog } from '../core/watchdog.js';
import type { BudgetChecker } from '../core/budget-checker.js';
import type { ProgressBudgetBurnDiagnostics } from '../core/progress-budget-burn-diagnostics.js';
import type { HookFileWatcher } from './hook-watcher.js';
import type { TerminalBackend } from '../adapters/terminal-backend.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { ShadowDetectorRegistry } from '../core/shadow-detector.js';
import type { QuotaAdapter } from '../adapters/quota-adapter.js';
import type { SnoozeSuppressionTracker } from '../core/snooze-suppression.js';
import type { SessionInfo } from '../core/session-read-model.js';
import { reconcile } from './reconciliation.js';
import type { WorktreeRegistry } from '../adapters/git-worktree-registry.js';
import { saveTasks, saveTasksWithSnapshotPolicy, serializeSnoozed } from '../core/task-persistence.js';
import { cleanupSessionResources, promotePendingTasks, type LifecycleDeps, type AgentLifecycleDeps } from './agent-lifecycle.js';
import { createSnapshotMessage } from './use-cases/get-snapshot.js';
import { getDetectionStats, type DetectionStats } from '../core/detection-stats.js';
import type { UserInputDeliverySnapshot } from '../shared/contracts/user-input-delivery.js';
import type { PersistenceHealthRecorder } from '../core/persistence-health.js';

export interface TimerDeps {
  monitor: Monitor;
  taskStore: TaskStore;
  queue: AttentionQueue;
  adapter: AgentAdapter;
  adapterRegistry: AdapterRegistry;
  tokenTracker: TokenTracker;
  watchdog: Watchdog;
  hookWatcher: HookFileWatcher;
  terminalBackend: TerminalBackend;
  hooksDir: string;
  tasksFile: string;
  serverCwd: string;
  saveIntervalMs: number;
  livenessIntervalMs: number;
  broadcastToAll: (msg: ServerMessage) => void;
  /** Optional shadow detector registry — runs shadow strategies alongside real detection. */
  shadowRegistry?: ShadowDetectorRegistry;
  /** Agent lifecycle deps — needed for pending task promotion. */
  agentLifecycleDeps?: AgentLifecycleDeps;
  /** Optional quota adapter for plan usage polling. */
  quotaAdapter?: QuotaAdapter;
  /** Live getter for max concurrent tasks. */
  getMaxActiveTasks?: () => number;
  /** Optional suppression tracker for snooze storm auto-suppress. */
  suppressionTracker?: SnoozeSuppressionTracker;
  /** Optional durable store for cumulative detector telemetry (persisted on the save tick). */
  detectionStatsStore?: { save(stats: DetectionStats): Promise<void> };
  /** In-memory tracker for runtime persistence failures. */
  persistenceHealth?: PersistenceHealthRecorder;
  /** Test seam for task-state persistence. */
  taskStateSaver?: typeof saveTasksWithSnapshotPolicy;
  /** Test seam for detection-stats snapshot gathering. */
  getDetectionStatsSnapshot?: () => DetectionStats;
  /**
   * Optional budget threshold checker (issue #98). When provided and configured with a
   * positive threshold, the token scan tick fires a `budget_exceeded` anomaly the first
   * time a task's observed cost crosses the warning (threshold) and critical (2x)
   * levels. Reactive only — may overshoot by one turn.
   */
  budgetChecker?: BudgetChecker;
  /** Diagnostics-only progress-aware budget-burn sampler. Never mutates the attention queue. */
  progressBudgetBurnDiagnostics?: ProgressBudgetBurnDiagnostics;
  /** Authoritative git worktree registry, refreshed when dashboard clients are connected. */
  worktreeRegistry?: WorktreeRegistry;
  /** Repo path used for single-repo worktree registry refreshes. */
  worktreeRegistryRepoPath?: string;
  /** Live dashboard client count; registry polling is skipped when zero. */
  getDashboardClientCount?: () => number;
  activityMetaProvider?: { getActivityMeta(kookrSessionId: string): AgentActivityMeta | undefined };
  /** True when promoted launches should be audited as running without permission prompts. */
  bypassAllPermissions?: boolean;
  /** Optional closed-loop retry service for unconfirmed mid-session input deliveries. */
  userInputDeliveries?: {
    sweepUnsubmittedDeliveries(): Promise<number>;
    /**
     * Forwarded to tick-driven snapshot broadcasts so they carry the
     * pending-delivery state — without it the frontend's snapshot merge
     * clears `userInputDeliveries` on every tick broadcast (#935).
     */
    getSnapshot(sessionId: string): UserInputDeliverySnapshot[];
  };
}

export interface PersistenceSaveTickDeps {
  taskStore: TaskStore;
  queue: AttentionQueue;
  tasksFile: string;
  suppressionTracker?: SnoozeSuppressionTracker;
  detectionStatsStore?: { save(stats: DetectionStats): Promise<void> };
  persistenceHealth?: PersistenceHealthRecorder;
  taskStateSaver?: typeof saveTasksWithSnapshotPolicy;
  getDetectionStatsSnapshot?: () => DetectionStats;
}

export interface TimerHandles {
  tokenScanInterval: ReturnType<typeof setInterval>;
  watchdogInterval: ReturnType<typeof setInterval>;
  livenessInterval: ReturnType<typeof setInterval>;
  snoozeExpiryInterval: ReturnType<typeof setInterval>;
  saveInterval: ReturnType<typeof setInterval>;
  quotaPollTimeout: ReturnType<typeof setTimeout> | null;
}

/**
 * Pure helper for the token-scan budget check (issue #98). Extracted so the
 * wire-up is testable without booting `startLifecycleTimers` and its real
 * intervals. Picks the first active session on the task, asks the BudgetChecker
 * whether to fire, and routes the resulting anomaly through the caller-supplied
 * enqueue callback. Returns true when an anomaly was enqueued, so the caller
 * can trigger a snapshot broadcast.
 *
 * Skips silently when the checker is absent, threshold is disabled, no active
 * session is available, or the checker returns null.
 */
export function runBudgetCheck(
  task: Task,
  costUsd: number,
  budgetChecker: BudgetChecker | undefined,
  enqueue: (agentId: string, anomaly: Anomaly) => void,
): boolean {
  if (!budgetChecker || budgetChecker.getThresholdUsd() <= 0) return false;
  const activeSession = findFirstActiveSession(task);
  if (!activeSession) return false;
  const anomaly = budgetChecker.check(task.id, activeSession.tmuxSession, costUsd);
  if (!anomaly) return false;
  enqueue(activeSession.tmuxSession, anomaly);
  return true;
}

export function findFirstActiveSession(task: Task): SessionInfo | undefined {
  return task.sessions.find(
    (s) => s.lastStatus !== 'completed' && s.lastStatus !== 'aborted',
  );
}

export function runProgressBudgetBurnDiagnosticSample(
  task: Task,
  usage: TokenUsage,
  diagnostics: Pick<ProgressBudgetBurnDiagnostics, 'sample'> | undefined,
  getAgentEvents: (agentId: string) => AgentEvent[],
): boolean {
  const activeSession = findFirstActiveSession(task);
  if (!activeSession || !diagnostics) return false;

  return diagnostics.sample({
    task,
    agentId: activeSession.tmuxSession,
    usage,
    events: getAgentEvents(activeSession.tmuxSession),
  }) !== null;
}

export function restoreExpiredSnoozes(queue: AttentionQueue, taskStore: TaskStore): boolean {
  const expired = queue.expireDue();
  if (expired.length === 0) return false;
  let changed = false;

  for (const entry of expired) {
    if (!entry.anomaly) {
      changed = true;
      continue;
    }

    if (entry.key === entry.agentId) {
      queue.enqueue(entry.agentId, entry.anomaly);
      changed = true;
      continue;
    }

    const task = taskStore.getTask(entry.key);
    if (!task || !isActiveStatus(task.status)) {
      changed = true;
      continue;
    }

    const liveSession = [...task.sessions].reverse().find(
      (session) => session.lastStatus !== 'completed'
        && session.lastStatus !== 'aborted'
        && !session.crashRecovered,
    );
    if (liveSession) {
      queue.enqueue(liveSession.tmuxSession, { ...entry.anomaly, agentId: liveSession.tmuxSession });
      changed = true;
    } else {
      queue.importSnoozed([{ ...entry, expiredPendingRestore: true }]);
    }
  }

  return changed;
}

export function startLifecycleTimers(deps: TimerDeps): TimerHandles {
  const {
    monitor, taskStore, queue, adapter, tokenTracker, watchdog,
    hookWatcher, terminalBackend, hooksDir, tasksFile, serverCwd,
    saveIntervalMs, livenessIntervalMs, broadcastToAll,
    shadowRegistry,
  } = deps;

  // Permission resolution is detected through authoritative signals:
  // 1. Keystroke detection in the terminal bridge (immediate, for Kookr UI)
  // 2. PostToolUse hook events via the event pipeline (definitive proof)
  // 3. Watchdog hook file recovery (backup, every 5s)
  // No pane-snapshot polling needed — raw pane diffs produce false positives
  // (multi-frame rendering, cursor changes, scrolling output).

  // --- Periodic token usage scan ---
  const tokenScanInterval = setInterval(async () => {
    try {
      // Freshness probe: ask which transcripts grew on disk since the last
      // scanAll. Used to keep the watchdog from minting stale_agent during a
      // long streaming turn whose `usage` block hasn't finalized yet. Must run
      // BEFORE scanAll so the byte-delta hasn't been consumed yet.
      const growths = await tokenTracker.scanGrowth();
      for (const g of growths) {
        const task = taskStore.getTask(g.taskId);
        if (!task) continue;
        for (const session of task.sessions) {
          if (session.lastStatus !== 'completed' && session.lastStatus !== 'aborted') {
            watchdog.recordTokenActivity(session.tmuxSession);
          }
        }
      }
      await tokenTracker.scanAll();
      let changed = false;
      for (const taskId of tokenTracker.getTrackedTaskIds()) {
        const usage = tokenTracker.getUsage(taskId);
        if (usage) {
          const task = taskStore.getTask(taskId);
          if (!task) continue;
          const prev = task.tokenUsage;
          if (!prev || prev.costUsd !== usage.costUsd || prev.inputTokens !== usage.inputTokens || prev.outputTokens !== usage.outputTokens) {
            taskStore.updateTokenUsage(taskId, usage);
            changed = true;
            // Notify watchdog that agent is actively consuming tokens
            for (const session of task.sessions) {
              if (session.lastStatus !== 'completed' && session.lastStatus !== 'aborted') {
                watchdog.recordTokenActivity(session.tmuxSession);
              }
            }
          }

          // Budget threshold check (issue #98). Reactive — fires at most once per
          // severity level per task, routed through the same attention queue the
          // watchdog uses.
          if (runBudgetCheck(task, usage.costUsd, deps.budgetChecker, (aid, a) => queue.enqueue(aid, a))) {
            changed = true;
          }

          runProgressBudgetBurnDiagnosticSample(
            task,
            usage,
            deps.progressBudgetBurnDiagnostics,
            (agentId) => monitor.getAgentEvents(agentId),
          );
        }
      }
      if (changed) {
        broadcastToAll(createSnapshotMessage({
          monitor,
          serverCwd,
          activityMetaProvider: deps.activityMetaProvider,
          relationTaskStore: taskStore,
          userInputDeliveryProvider: deps.userInputDeliveries,
        }));
      }
    } catch (err) {
      console.error('Error scanning token usage:', err);
    }
  }, 5_000);

  // --- Periodic watchdog tick ---
  //
  // Hook-file recovery: ask the HookFileWatcher to drain any new lines since
  // its last offset. Recovered events flow through the normal adapter.onEvent
  // pipeline (monitor.processEvents + watchdog.recordEvents), which is the
  // same path the fs.watch listener uses. One reader, one offset map — the
  // watchdog tick is a trigger, not a parser.
  const watchdogInterval = setInterval(async () => {
    const agents = watchdog.getTrackedAgents();
    let changed = false;

    for (const agentId of agents) {
      try {
        // Capture pane output
        let paneContent = '';
        let paneCaptureSucceeded = true;
        try {
          paneContent = await adapter.captureDisplay(agentId);
        } catch {
          // Session might be dead — liveness check will handle it
          paneCaptureSucceeded = false;
        }

        // Backup read path: hook-watcher already tails the file via fs.watch
        // and a 3s backup poll, but the watchdog tick forces a drain here so
        // stuck-detection never waits on a dropped fs.watch event. The drain
        // updates the single offset map and dispatches any recovered lines
        // through adapter.onEvent — no parallel parsing, no parallel offset.
        try {
          await hookWatcher.drainNow(agentId);
        } catch {
          // Drain failures are non-critical — next tick retries.
        }

        // Hook events have already propagated into watchdog via recordEvents
        // in the event-pipeline; the tick only evaluates state now.
        const verdict = watchdog.tick(agentId, paneContent, []);

        // Monitor is the single owner of the Anomaly union. Hand the verdict
        // to it and let Monitor decide whether to enqueue, suppress, or clear —
        // this replaces the former in-place reconciliation between Monitor
        // and Watchdog that lived in this file (issue #367 sub-goal 3).
        const watchdogActionable = verdict.status === 'needs_input'
          || verdict.status === 'permission_blocked'
          || verdict.status === 'stale_agent'
          || verdict.status === 'hook_disconnected';

        if (monitor.applyWatchdogVerdict(agentId, verdict, { paneCaptureSucceeded, paneText: paneContent })) {
          changed = true;
        }

        if (
          !watchdogActionable
          && monitor.sampleFindingEvidence(agentId, paneCaptureSucceeded ? paneContent : undefined)
        ) {
          changed = true;
        }

        // Run shadow strategies (fire-and-forget, never affects real detection)
        if (shadowRegistry) {
          const realAnomaly = monitor.getCurrentAnomaly(agentId);
          shadowRegistry.evaluate(agentId, { paneText: paneContent, realAnomaly });
        }
      } catch (err) {
        console.error(`Watchdog error for ${agentId}:`, err);
      }
    }

    try {
      if (await deps.userInputDeliveries?.sweepUnsubmittedDeliveries()) {
        changed = true;
      }
    } catch (err) {
      console.error('Error sweeping unsubmitted user-input deliveries:', err);
    }

    if (changed) {
      broadcastToAll(createSnapshotMessage({
        monitor,
        serverCwd,
        activityMetaProvider: deps.activityMetaProvider,
        relationTaskStore: taskStore,
        userInputDeliveryProvider: deps.userInputDeliveries,
      }));
    }
  }, 5_000);

  // --- Periodic liveness check ---
  const lifecycleDeps: LifecycleDeps = {
    adapter, monitor, taskStore, hookWatcher, watchdog, shadowRegistry, tokenTracker,
    queue,
    suppressionTracker: deps.suppressionTracker,
  };

  const livenessInterval = setInterval(async () => {
    try {
      if (
        deps.worktreeRegistry
        && deps.worktreeRegistryRepoPath
        && (deps.getDashboardClientCount?.() ?? 0) > 0
      ) {
        await deps.worktreeRegistry.refresh(deps.worktreeRegistryRepoPath);
      }
      const result = await reconcile(taskStore, terminalBackend, deps.worktreeRegistry);

      // Clean up resources for dead sessions via centralized lifecycle
      for (const tmuxName of result.markedCompleted) {
        await cleanupSessionResources(tmuxName, lifecycleDeps);
      }

      if (
        result.markedCompleted.length > 0
        || result.tasksCompleted.length > 0
        || result.tasksTerminated.length > 0
        || result.worktreesMissing.length > 0
        || result.worktreesStale.length > 0
        || result.worktreesChanged.length > 0
      ) {
        // Promote pending tasks when slots open from auto-transitioned sessions
        // (completed via backfill, or terminated via the new dead-session path).
        if (deps.agentLifecycleDeps) {
          await promotePendingTasks({
            taskStore,
            adapterRegistry: deps.adapterRegistry,
            lifecycleDeps: deps.agentLifecycleDeps,
            broadcastToAll, serverCwd,
            getMaxActiveTasks: deps.getMaxActiveTasks,
            bypassAllPermissions: deps.bypassAllPermissions,
          });
        }
        broadcastToAll(createSnapshotMessage({
          monitor,
          serverCwd,
          activityMetaProvider: deps.activityMetaProvider,
          relationTaskStore: taskStore,
          userInputDeliveryProvider: deps.userInputDeliveries,
        }));
      }
    } catch (err) {
      console.error('Error during liveness check:', err);
    }
  }, livenessIntervalMs);

  const snoozeExpiryInterval = setInterval(() => {
    try {
      if (restoreExpiredSnoozes(queue, taskStore)) {
        broadcastToAll(createSnapshotMessage({
          monitor,
          serverCwd,
          activityMetaProvider: deps.activityMetaProvider,
          relationTaskStore: taskStore,
          userInputDeliveryProvider: deps.userInputDeliveries,
        }));
      }
    } catch (err) {
      console.error('Error expiring snoozes:', err);
    }
  }, 1_000);

  // --- Periodic task persistence ---
  // Uses saveTasksWithSnapshotPolicy with 'daily' so the first successful
  // save of each local day copies tasks.json to tasks.json.daily.YYYYMMDD.
  // Snapshot failures are logged inside the helper and never block the save.
  const saveInterval = setInterval(async () => {
    await runPersistenceSaveTick(deps);
  }, saveIntervalMs);

  // --- Periodic quota usage polling (optional) ---
  // Uses setTimeout chain (not setInterval) so each tick respects the adapter's
  // current interval, which changes dynamically during backoff and recovery.
  let quotaPollTimeout: ReturnType<typeof setTimeout> | null = null;
  if (deps.quotaAdapter) {
    const quotaAdapter = deps.quotaAdapter;

    async function pollQuota(): Promise<void> {
      try {
        const changed = await quotaAdapter.poll();
        if (changed) {
          const quota = quotaAdapter.getLatest();
          if (quota) broadcastToAll({ type: 'quotaStatus', quota });
        }
      } catch {
        // non-critical
      }
      // Schedule next poll using the adapter's (possibly updated) interval
      quotaPollTimeout = setTimeout(pollQuota, quotaAdapter.getCurrentIntervalMs());
    }

    // Fire immediately on startup
    void pollQuota();
  }

  return {
    tokenScanInterval,
    watchdogInterval,
    livenessInterval,
    snoozeExpiryInterval,
    saveInterval,
    quotaPollTimeout,
  };
}

export async function runPersistenceSaveTick(deps: PersistenceSaveTickDeps): Promise<void> {
  try {
    const snoozes = serializeSnoozed(deps.queue, deps.taskStore);
    const suppressionState = deps.suppressionTracker?.export();
    const taskStateSaver = deps.taskStateSaver ?? saveTasksWithSnapshotPolicy;
    await taskStateSaver(
      deps.taskStore.getAllTasks(),
      deps.tasksFile,
      'daily',
      deps.taskStore.getLifetimeSpendUsd(),
      snoozes,
      suppressionState,
      deps.taskStore.listRelations(),
    );
    deps.persistenceHealth?.recordSuccess('task_state');
  } catch (err) {
    deps.persistenceHealth?.recordFailure('task_state', err);
    console.error('Error saving tasks:', err);
  }
  // Persist cumulative detector telemetry on the same cadence so FP/FN/
  // suppression rates survive restarts. Isolated from the task save so a
  // stats-write failure neither blocks nor is mislabelled as a task error.
  if (!deps.detectionStatsStore) return;
  try {
    await deps.detectionStatsStore.save((deps.getDetectionStatsSnapshot ?? getDetectionStats)());
    deps.persistenceHealth?.recordSuccess('detection_stats');
  } catch (err) {
    deps.persistenceHealth?.recordFailure('detection_stats', err);
    console.error('Error saving detection stats:', err);
  }
}

export function clearAllTimers(handles: TimerHandles): void {
  clearInterval(handles.watchdogInterval);
  clearInterval(handles.tokenScanInterval);
  clearInterval(handles.livenessInterval);
  clearInterval(handles.snoozeExpiryInterval);
  clearInterval(handles.saveInterval);
  if (handles.quotaPollTimeout) clearTimeout(handles.quotaPollTimeout);
}
