import { saveTasksWithSnapshotPolicy, serializeSnoozed, type SnapshotPolicy } from '../core/task-persistence.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { PersistenceHealthRecorder } from '../core/persistence-health.js';
import type { SnoozeSuppressionTracker } from '../core/snooze-suppression.js';
import type { TaskStore } from '../core/tasks.js';

export const DEFAULT_TASK_STATE_SAVE_COALESCE_MS = 1_000;

export type TaskStateSaveReason =
  | 'task_edges_mutation'
  | 'task_relation_mutation'
  | 'periodic'
  | 'flush'
  | 'close';

type TimerHandle = ReturnType<typeof setTimeout>;

export interface TaskStateSaveSchedulerDeps {
  taskStore: TaskStore;
  tasksFile: string;
  queue?: AttentionQueue;
  suppressionTracker?: SnoozeSuppressionTracker;
  persistenceHealth?: PersistenceHealthRecorder;
  coalesceMs?: number;
  taskStateSaver?: typeof saveTasksWithSnapshotPolicy;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface FlushTaskStateSaveOptions {
  force?: boolean;
  policy?: SnapshotPolicy;
}

export interface TaskStateSaveSchedulerLike {
  requestSave(reason: TaskStateSaveReason): void;
  flush(reason?: TaskStateSaveReason, options?: FlushTaskStateSaveOptions): Promise<void>;
  close(): Promise<void>;
}

/**
 * Coalesces bursty mutation-triggered task-state saves while preserving explicit
 * force-flush paths for periodic ticks and shutdown. The maximum crash-loss
 * window for mutation-only changes is the coalescing delay plus write time.
 */
export class TaskStateSaveScheduler implements TaskStateSaveSchedulerLike {
  private dirty = false;
  private timer: TimerHandle | null = null;
  private inFlight: Promise<void> | null = null;
  private latestReason: TaskStateSaveReason = 'flush';
  private readonly coalesceMs: number;
  private readonly taskStateSaver: typeof saveTasksWithSnapshotPolicy;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  constructor(private readonly deps: TaskStateSaveSchedulerDeps) {
    this.coalesceMs = deps.coalesceMs ?? DEFAULT_TASK_STATE_SAVE_COALESCE_MS;
    this.taskStateSaver = deps.taskStateSaver ?? saveTasksWithSnapshotPolicy;
    this.setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  }

  requestSave(reason: TaskStateSaveReason): void {
    this.dirty = true;
    this.latestReason = reason;
    if (this.inFlight) return;
    if (this.timer) return;
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.flush(this.latestReason).catch((err) => {
        console.error(`[tasks-save] coalesced save failed after ${this.coalesceMs}ms window:`, err);
      });
    }, this.coalesceMs);
  }

  async flush(reason: TaskStateSaveReason = 'flush', options: FlushTaskStateSaveOptions = {}): Promise<void> {
    this.clearPendingTimer();
    if (this.inFlight) await this.inFlight;
    if (!this.dirty && options.force !== true) return;

    do {
      this.dirty = false;
      const save = this.saveNow(options.policy ?? 'none', reason);
      this.inFlight = save;
      try {
        await save;
      } catch (err) {
        this.dirty = true;
        throw err;
      } finally {
        if (this.inFlight === save) this.inFlight = null;
      }
      if (this.inFlight) await this.inFlight;
    } while (this.dirty);
  }

  async close(): Promise<void> {
    await this.flush('close');
  }

  private async saveNow(policy: SnapshotPolicy, reason: TaskStateSaveReason): Promise<void> {
    const snoozes = this.deps.queue ? serializeSnoozed(this.deps.queue, this.deps.taskStore) : undefined;
    const suppressionState = this.deps.suppressionTracker?.export();
    try {
      await this.taskStateSaver(
        this.deps.taskStore.getAllTasks(),
        this.deps.tasksFile,
        policy,
        this.deps.taskStore.getLifetimeSpendUsd(),
        snoozes,
        suppressionState,
        this.deps.taskStore.listRelations(),
      );
      this.deps.persistenceHealth?.recordSuccess('task_state');
    } catch (err) {
      this.deps.persistenceHealth?.recordFailure('task_state', err);
      console.error(`[tasks-save] ${reason} save failed:`, err);
      throw err;
    }
  }

  private clearPendingTimer(): void {
    if (!this.timer) return;
    this.clearTimeoutFn(this.timer);
    this.timer = null;
  }
}
