import type { TaskStore } from '../../core/tasks.js';
import type { Monitor } from '../../core/monitor.js';
import type { AgentAdapter } from '../../adapters/agent-adapter.js';
import type { AttentionQueue } from '../../core/attention-queue.js';
import type { HookFileWatcher } from '../hook-watcher.js';
import type { Watchdog } from '../../core/watchdog.js';
import type { ShadowDetectorRegistry } from '../../core/shadow-detector.js';
import type { SnoozeSuppressionTracker } from '../../core/snooze-suppression.js';
import type { ActivityLedger } from '../../core/activity-ledger.js';
import type { HookIngestion } from '../hook-ingestion.js';
import { cleanupSessionResources } from '../agent-lifecycle.js';

export interface DeleteTaskDeps {
  taskStore: TaskStore;
  adapter: Pick<AgentAdapter, 'stop'>;
  monitor: Pick<Monitor, 'unregisterAgent'>;
  hookWatcher?: Pick<HookFileWatcher, 'stop'>;
  watchdog?: Pick<Watchdog, 'unregisterAgent'>;
  shadowRegistry?: Pick<ShadowDetectorRegistry, 'unregisterAgent'>;
  suppressionTracker?: Pick<SnoozeSuppressionTracker, 'reset'>;
  /** Optional queue — used to clear the task's task-keyed snooze. */
  queue?: Pick<AttentionQueue, 'purgeTask'>;
  /** Prune per-session activity ledger files on task deletion.
   *  See rfc-activity-log-reliability §7. */
  activityLedger?: Pick<ActivityLedger, 'pruneSession'>;
  /** Drop in-memory ingestion counters / dedup cache / sequence counter
   *  for each Kookr session belonging to the deleted task. */
  hookIngestion?: Pick<HookIngestion, 'forgetSession'>;
}

export async function deleteTask(deps: DeleteTaskDeps, taskId: string): Promise<boolean> {
  const task = deps.taskStore.getTask(taskId);
  if (!task) return false;

  for (const session of task.sessions) {
    if (session.lastStatus !== 'completed' && session.lastStatus !== 'aborted') {
      await cleanupSessionResources(session.tmuxSession, deps);
    } else {
      // A session can become terminal before its hook JSONL file is created.
      // In that race, the hook watcher may still hold a poll-until-exists
      // sentinel even though there is no live process left to stop.
      deps.monitor.unregisterAgent(session.tmuxSession);
      deps.hookWatcher?.stop(session.tmuxSession);
      deps.watchdog?.unregisterAgent(session.tmuxSession);
      deps.shadowRegistry?.unregisterAgent(session.tmuxSession);
      deps.suppressionTracker?.reset(session.tmuxSession);
    }

    // Always drop activity-log bookkeeping, even for completed/aborted
    // sessions whose terminal resources were freed by a previous lifecycle
    // event. The ledger file would otherwise linger after the task vanishes.
    deps.hookIngestion?.forgetSession(session.tmuxSession);
    if (deps.activityLedger) {
      try {
        await deps.activityLedger.pruneSession(session.tmuxSession);
      } catch {
        // Pruning is best-effort cleanup — never fail a delete on stale
        // ledger filesystem state. The orphan ledger file is harmless.
      }
    }
  }

  // Snoozes are keyed by taskId — clear the task's snooze before the task
  // record disappears (otherwise the next save logs an orphan-snooze warning).
  deps.queue?.purgeTask(taskId);
  deps.taskStore.deleteTask(taskId);
  return true;
}
