import type { TaskStore } from '../../core/tasks.js';
import type { Monitor } from '../../core/monitor.js';
import type { AgentAdapter } from '../../adapters/agent-adapter.js';
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
}

export async function deleteTask(deps: DeleteTaskDeps, taskId: string): Promise<boolean> {
  const task = deps.taskStore.getTask(taskId);
  if (!task) return false;

  for (const session of task.sessions) {
    if (session.lastStatus !== 'completed' && session.lastStatus !== 'aborted') {
      await cleanupSessionResources(session.tmuxSession, deps);
    }
  }

  deps.taskStore.deleteTask(taskId);
  return true;
}
