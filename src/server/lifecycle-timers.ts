import type { Monitor } from '../core/monitor.js';
import type { Task, TaskStore } from '../core/tasks.js';
import type { Anomaly } from '../core/types.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { AgentAdapter } from '../adapters/agent-adapter.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';
import type { TokenTracker } from '../core/token-tracker.js';
import type { Watchdog } from '../core/watchdog.js';
import type { BudgetChecker } from '../core/budget-checker.js';
import type { HookFileWatcher } from './hook-watcher.js';
import type { TerminalBackend } from '../adapters/terminal-backend.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import type { ShadowDetectorRegistry } from '../core/shadow-detector.js';
import type { QuotaAdapter } from '../adapters/quota-adapter.js';
import type { SnoozeSuppressionTracker } from '../core/snooze-suppression.js';
import { reconcile } from './reconciliation.js';
import type { WorktreeRegistry } from '../adapters/git-worktree-registry.js';
import { saveTasks, saveTasksWithSnapshotPolicy, serializeSnoozed } from '../core/task-persistence.js';
import { cleanupSessionResources, promotePendingTasks, type LifecycleDeps, type AgentLifecycleDeps } from './agent-lifecycle.js';
import { createSnapshotMessage } from './use-cases/get-snapshot.js';
import type { CheckpointCycler } from '../core/checkpoint-cycler.js';
import { getCyclableSessions, isCycleDisabled } from '../core/checkpoint-cycler.js';

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
  /** Optional v5 checkpoint cycler — ticked from the existing token scan interval. */
  checkpointCycler?: CheckpointCycler;
  /**
   * Optional budget threshold checker (issue #98). When provided and configured with a
   * positive threshold, the token scan tick fires a `budget_exceeded` anomaly the first
   * time a task's observed cost crosses the warning (threshold) and critical (2x)
   * levels. Reactive only — may overshoot by one turn.
   */
  budgetChecker?: BudgetChecker;
  /** Authoritative git worktree registry, refreshed when dashboard clients are connected. */
  worktreeRegistry?: WorktreeRegistry;
  /** Repo path used for single-repo worktree registry refreshes. */
  worktreeRegistryRepoPath?: string;
  /** Live dashboard client count; registry polling is skipped when zero. */
  getDashboardClientCount?: () => number;
}

export interface TimerHandles {
  tokenScanInterval: ReturnType<typeof setInterval>;
  watchdogInterval: ReturnType<typeof setInterval>;
  livenessInterval: ReturnType<typeof setInterval>;
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
  const activeSession = task.sessions.find(
    (s) => s.lastStatus !== 'completed' && s.lastStatus !== 'aborted',
  );
  if (!activeSession) return false;
  const anomaly = budgetChecker.check(task.id, activeSession.tmuxSession, costUsd);
  if (!anomaly) return false;
  enqueue(activeSession.tmuxSession, anomaly);
  return true;
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
        }
      }
      if (changed) {
        broadcastToAll(createSnapshotMessage({ monitor, serverCwd }));
      }

      // v5 checkpoint cycle: each tick, ask the cycler whether any session
      // should be prompted to write CHECKPOINT.md. The cycler reads its own
      // context-fill metric from the transcript and returns one action per
      // session that crosses the threshold. Actions are dispatched via
      // `adapter.sendInput` (NOT `terminal.sendKeys`) so that adapter-specific
      // input semantics — Codex CLI's bracketed-paste handling, etc. — are
      // honoured. Fail-open everywhere — a cycler error never breaks the
      // token scan.
      if (deps.checkpointCycler && !isCycleDisabled()) {
        try {
          const sessions = getCyclableSessions(taskStore);
          const actions = await deps.checkpointCycler.tick(sessions);
          for (const action of actions) {
            if (action.kind === 'send_user_message' || action.kind === 'send_input') {
              try {
                await adapter.sendInput(action.tmuxName, action.text);
              } catch (sendErr) {
                console.error('[checkpoint-cycler] sendInput failed:', sendErr);
              }
            }
          }
        } catch (cyclerErr) {
          console.error('[checkpoint-cycler] tick failed:', cyclerErr);
        }
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
        if (monitor.applyWatchdogVerdict(agentId, verdict, { paneCaptureSucceeded })) {
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

    if (changed) {
      broadcastToAll(createSnapshotMessage({ monitor, serverCwd }));
    }
  }, 5_000);

  // --- Periodic liveness check ---
  const lifecycleDeps: LifecycleDeps = {
    adapter, monitor, taskStore, hookWatcher, watchdog, shadowRegistry, tokenTracker,
    suppressionTracker: deps.suppressionTracker,
    checkpointCycler: deps.checkpointCycler,
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
          });
        }
        broadcastToAll(createSnapshotMessage({ monitor, serverCwd }));
      }
    } catch (err) {
      console.error('Error during liveness check:', err);
    }
  }, livenessIntervalMs);

  // --- Periodic task persistence ---
  // Uses saveTasksWithSnapshotPolicy with 'daily' so the first successful
  // save of each local day copies tasks.json to tasks.json.daily.YYYYMMDD.
  // Snapshot failures are logged inside the helper and never block the save.
  const saveInterval = setInterval(async () => {
    try {
      const snoozedFindings = serializeSnoozed(queue, taskStore);
      const suppressionState = deps.suppressionTracker?.export();
      await saveTasksWithSnapshotPolicy(
        taskStore.getAllTasks(),
        tasksFile,
        'daily',
        taskStore.getLifetimeSpendUsd(),
        snoozedFindings,
        suppressionState,
      );
    } catch (err) {
      console.error('Error saving tasks:', err);
    }
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
    saveInterval,
    quotaPollTimeout,
  };
}

export function clearAllTimers(handles: TimerHandles): void {
  clearInterval(handles.watchdogInterval);
  clearInterval(handles.tokenScanInterval);
  clearInterval(handles.livenessInterval);
  clearInterval(handles.saveInterval);
  if (handles.quotaPollTimeout) clearTimeout(handles.quotaPollTimeout);
}
