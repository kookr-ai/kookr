import type { TaskStore } from '../core/tasks.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { SnoozeSuppressionTracker } from '../core/snooze-suppression.js';
import type { PersistenceHealthRecorder } from '../core/persistence-health.js';
import type { TaskStateSaveSchedulerLike } from './task-state-save-scheduler.js';
import { saveTasksWithSnapshotPolicy, serializeSnoozed } from '../core/task-persistence.js';
import { getDetectionStats, type DetectionStats } from '../core/detection-stats.js';

/**
 * Deps for the periodic persistence save tick (extracted from
 * `lifecycle-timers.ts`, issue #1822). Structurally a subset of `TimerDeps`,
 * so the scheduler can pass its own deps straight through.
 */
export interface PersistenceSaveTickDeps {
  taskStore: TaskStore;
  queue: AttentionQueue;
  tasksFile: string;
  suppressionTracker?: SnoozeSuppressionTracker;
  detectionStatsStore?: { save(stats: DetectionStats): Promise<void> };
  persistenceHealth?: PersistenceHealthRecorder;
  taskStateSaveScheduler?: TaskStateSaveSchedulerLike;
  taskStateSaver?: typeof saveTasksWithSnapshotPolicy;
  getDetectionStatsSnapshot?: () => DetectionStats;
}

/**
 * Run one periodic task-state persistence tick. Uses
 * `saveTasksWithSnapshotPolicy` with `'daily'` so the first successful save of
 * each local day copies `tasks.json` to `tasks.json.daily.YYYYMMDD`. Snapshot
 * failures are logged inside the helper and never block the save. When a
 * coalescing scheduler is wired, the tick force-flushes it as a backstop
 * instead of serializing directly.
 */
export async function runPersistenceSaveTick(deps: PersistenceSaveTickDeps): Promise<void> {
  try {
    if (deps.taskStateSaveScheduler) {
      await deps.taskStateSaveScheduler.flush('periodic', { force: true, policy: 'daily' });
    } else {
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
    }
  } catch (err) {
    if (!deps.taskStateSaveScheduler) deps.persistenceHealth?.recordFailure('task_state', err);
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
