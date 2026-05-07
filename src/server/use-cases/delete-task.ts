import type { TaskStore } from '../../core/tasks.js';
import type { Monitor } from '../../core/monitor.js';
import type { AgentAdapter } from '../../adapters/agent-adapter.js';
import type { AttentionQueue } from '../../core/attention-queue.js';
import type { HookFileWatcher } from '../hook-watcher.js';
import type { Watchdog } from '../../core/watchdog.js';
import type { ShadowDetectorRegistry } from '../../core/shadow-detector.js';
import type { SnoozeSuppressionTracker } from '../../core/snooze-suppression.js';
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
}

export async function deleteTask(deps: DeleteTaskDeps, taskId: string): Promise<boolean> {
  const task = deps.taskStore.getTask(taskId);
  if (!task) return false;

  for (const session of task.sessions) {
    if (session.lastStatus !== 'completed' && session.lastStatus !== 'aborted') {
      await cleanupSessionResources(session.tmuxSession, deps);
    }
  }

  // Snoozes are keyed by taskId — clear the task's snooze before the task
  // record disappears (otherwise the next save logs an orphan-snooze warning).
  deps.queue?.purgeTask(taskId);
  deps.taskStore.deleteTask(taskId);
  return true;
}
