import { persistTaskState, serializeSnoozed, type SnapshotPolicy } from '../core/task-persistence.js';
import type { TaskSqliteStore } from '../core/task-sqlite-store.js';
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
  /** When set, saves flush dirty rows to SQLite instead of rewriting tasks.json. */
  sqliteStore?: TaskSqliteStore | null;
  queue?: AttentionQueue;
  suppressionTracker?: SnoozeSuppressionTracker;
  persistenceHealth?: PersistenceHealthRecorder;
  coalesceMs?: number;
  /**
   * Optional override for the persist path. Defaults to {@link persistTaskState}.
   * Tests may inject a mock. The legacy full-array saver signature is no longer
   * the default; inject via this hook when a test needs to observe flushes.
   */
  taskStateSaver?: (opts: {
    taskStore: TaskStore;
    tasksFile: string;
    policy: SnapshotPolicy;
    snoozes?: ReturnType<typeof serializeSnoozed>;
    suppressionState?: ReturnType<SnoozeSuppressionTracker['export']>;
    sqliteStore?: TaskSqliteStore | null;
    forceFull?: boolean;
  }) => Promise<void>;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface FlushTaskStateSaveOptions {
  force?: boolean;
  policy?: SnapshotPolicy;
  /** Force a full rewrite of every task row (predelete / recovery). */
  forceFull?: boolean;
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
 *
 * With the SQLite backend (#1755) each flush writes only dirty rows; a force
 * flush with an empty dirty set becomes a cheap WAL checkpoint.
 */
export class TaskStateSaveScheduler implements TaskStateSaveSchedulerLike {
  private dirty = false;
  private timer: TimerHandle | null = null;
  private inFlight: Promise<void> | null = null;
  private latestReason: TaskStateSaveReason = 'flush';
  private readonly coalesceMs: number;
  private readonly taskStateSaver: NonNullable<TaskStateSaveSchedulerDeps['taskStateSaver']>;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  constructor(private readonly deps: TaskStateSaveSchedulerDeps) {
    this.coalesceMs = deps.coalesceMs ?? DEFAULT_TASK_STATE_SAVE_COALESCE_MS;
    this.taskStateSaver = deps.taskStateSaver ?? (async (opts) => {
      await persistTaskState(opts);
    });
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
      const save = this.saveNow(options.policy ?? 'none', reason, options.forceFull === true);
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

  private async saveNow(
    policy: SnapshotPolicy,
    reason: TaskStateSaveReason,
    forceFull: boolean,
  ): Promise<void> {
    const snoozes = this.deps.queue ? serializeSnoozed(this.deps.queue, this.deps.taskStore) : undefined;
    const suppressionState = this.deps.suppressionTracker?.export();
    try {
      await this.taskStateSaver({
        taskStore: this.deps.taskStore,
        tasksFile: this.deps.tasksFile,
        policy,
        snoozes,
        suppressionState,
        sqliteStore: this.deps.sqliteStore,
        forceFull,
      });
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
