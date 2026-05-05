import type { AdapterRegistry } from '../adapters/agent-adapter.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { DeferredInteractionLogWriter } from '../core/interaction-log.js';
import { deserializeSnoozed, type LoadTasksResult } from '../core/task-persistence.js';
import type { TaskStore } from '../core/tasks.js';
import type { Monitor } from '../core/monitor.js';
import type { SnoozeSuppressionTracker } from '../core/snooze-suppression.js';
import type { Watchdog } from '../core/watchdog.js';
import type { ServerMessage } from '../shared/protocol.js';
import { promotePendingTasks, registerNewAgent, type AgentLifecycleDeps } from './agent-lifecycle.js';
import { recoverCrashedSessions, type CrashRecoveryResult } from './crash-recovery.js';
import type { HookFileWatcher } from './hook-watcher.js';
import type { ReconciliationResult } from './reconciliation.js';

interface StartupRecoveryDeps {
  taskStore: TaskStore;
  queue: AttentionQueue;
  monitor: Monitor;
  watchdog: Watchdog;
  hookWatcher: HookFileWatcher;
  suppressionTracker: SnoozeSuppressionTracker;
  interactionLog: DeferredInteractionLogWriter;
  adapterRegistry: AdapterRegistry;
  reconcileResult: ReconciliationResult;
  persisted: LoadTasksResult;
  lifecycleDeps: AgentLifecycleDeps;
}

interface PromotePendingStartupTasksDeps {
  taskStore: TaskStore;
  adapterRegistry: AdapterRegistry;
  lifecycleDeps: AgentLifecycleDeps;
  broadcastToAll: (msg: ServerMessage) => void;
  serverCwd: string;
}

export async function runStartupRecoveryPhase({
  taskStore,
  queue,
  monitor,
  watchdog,
  hookWatcher,
  suppressionTracker,
  interactionLog,
  adapterRegistry,
  reconcileResult,
  persisted,
  lifecycleDeps,
}: StartupRecoveryDeps): Promise<CrashRecoveryResult | null> {
  let startupRecoverySummary: CrashRecoveryResult | null = null;

  if (process.env.KOOKR_AUTO_RELAUNCH === 'false') {
    console.log('[crash-recovery] Disabled (KOOKR_AUTO_RELAUNCH=false), skipping');
  } else if (reconcileResult.markedCompleted.length > 0) {
    const recoveryResult = await recoverCrashedSessions(taskStore, adapterRegistry, reconcileResult);

    for (const entry of recoveryResult.relaunched) {
      const task = taskStore.getTask(entry.taskId);
      if (task) {
        await registerNewAgent(task, lifecycleDeps);
      }
      if (entry.mode === 'resumed') {
        console.log(
          `[crash-recovery] Resumed task ${entry.taskId} → tmux ${entry.newTmux}`,
        );
      } else {
        const reason = entry.fallbackReason ?? 'unknown';
        console.log(
          `[crash-recovery] Fresh-launched task ${entry.taskId}: ${reason} → tmux ${entry.newTmux}`,
        );
      }
    }
    for (const { tmux, reason } of recoveryResult.skipped) {
      console.warn(`[crash-recovery] Skipped ${tmux}: ${reason}`);
    }
    for (const { tmux, error } of recoveryResult.failed) {
      console.error(`[crash-recovery] Failed ${tmux}: ${error}`);
    }

    if (recoveryResult.relaunched.length > 0 || recoveryResult.failed.length > 0) {
      startupRecoverySummary = recoveryResult;
      await interactionLog.append({
        type: 'crash_recovery',
        relaunched: recoveryResult.relaunched.length,
        skipped: recoveryResult.skipped.length,
        failed: recoveryResult.failed.length,
        details: recoveryResult,
        timestamp: new Date().toISOString(),
      });
      const resumedCount = recoveryResult.relaunched.filter((e) => e.mode === 'resumed').length;
      const freshCount = recoveryResult.relaunched.length - resumedCount;
      console.log(
        `[crash-recovery] Recovery complete: ${resumedCount} resumed, ${freshCount} fresh, `
        + `${recoveryResult.skipped.length} skipped, ${recoveryResult.failed.length} failed`,
      );
    }
  }

  const deserialized = deserializeSnoozed(persisted.snoozedFindings, taskStore);
  if (deserialized.length > 0) {
    queue.importSnoozed(deserialized);
    console.log(`[snooze] Restored ${deserialized.length} snoozed finding(s)`);
  }

  if (persisted.suppressionState && persisted.suppressionState.length > 0) {
    suppressionTracker.import(persisted.suppressionState);
    console.log(`[suppression] Restored ${persisted.suppressionState.length} suppression state(s)`);
  }

  for (const tmuxName of reconcileResult.resumed) {
    monitor.registerAgent(tmuxName);
    const resumedTask = taskStore.findTaskBySession(tmuxName);
    const resumedSession = resumedTask?.sessions.find((session) => session.tmuxSession === tmuxName);
    watchdog.registerAgent(tmuxName, resumedSession?.lastEventAt);
    hookWatcher.watch(tmuxName, { replayExisting: true });
  }

  return startupRecoverySummary;
}

export async function promotePendingStartupTasks({
  taskStore,
  adapterRegistry,
  lifecycleDeps,
  broadcastToAll,
  serverCwd,
}: PromotePendingStartupTasksDeps): Promise<void> {
  const promoted = await promotePendingTasks({
    taskStore,
    adapterRegistry,
    lifecycleDeps,
    broadcastToAll,
    serverCwd,
  });

  if (promoted > 0) {
    console.log(`[startup] Promoted ${promoted} pending task(s) to active`);
  }
}
