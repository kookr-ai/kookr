import { persistTaskState, serializeSnoozed, type SnapshotPolicy } from '../core/task-persistence.js';
import type { TaskSqliteStore } from '../core/task-sqlite-store.js';
import type { AttentionQueue } from '../core/attention-queue.js';
import type { PersistenceHealthRecorder } from '../core/persistence-health.js';
import type { SnoozeSuppressionTracker } from '../core/snooze-suppression.js';
import type { TaskStore } from '../core/tasks.js';

export const DEFAULT_TASK_STATE_SAVE_COALESCE_MS = 1_000;

/**
 * Bounded retry schedule for a coalesced save that failed on a transient write
 * error (issue #2775). Without this, a failed timer-driven save left the dirty
 * flag set but re-armed no timer, so recovery waited for an unrelated mutation
 * or the next periodic force flush. Backoff is exponential from the base delay,
 * doubling each attempt and clamped to the max, then auto-retry stops after the
 * attempt cap (dirty state is preserved for the periodic force flush and close
 * paths, and each failure is still recorded for persistence-health alerting).
 */
export const DEFAULT_TASK_STATE_SAVE_RETRY_BASE_MS = 500;
export const DEFAULT_TASK_STATE_SAVE_RETRY_MAX_MS = 30_000;
export const DEFAULT_TASK_STATE_SAVE_RETRY_MAX_ATTEMPTS = 6;

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
  /** Base delay for the first transient-failure retry (issue #2775). */
  retryBaseMs?: number;
  /** Upper clamp on the exponential retry backoff. */
  retryMaxMs?: number;
  /** How many automatic retries to schedule before yielding to force flush. */
  retryMaxAttempts?: number;
  /** Injectable clock for retry-age reporting; defaults to Date.now. */
  now?: () => number;
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
  private retryTimer: TimerHandle | null = null;
  private retryAttempt = 0;
  private retryStartedAtMs: number | null = null;
  private inFlight: Promise<void> | null = null;
  private latestReason: TaskStateSaveReason = 'flush';
  private readonly coalesceMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly retryMaxAttempts: number;
  private readonly now: () => number;
  private readonly taskStateSaver: NonNullable<TaskStateSaveSchedulerDeps['taskStateSaver']>;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;

  constructor(private readonly deps: TaskStateSaveSchedulerDeps) {
    this.coalesceMs = deps.coalesceMs ?? DEFAULT_TASK_STATE_SAVE_COALESCE_MS;
    this.retryBaseMs = deps.retryBaseMs ?? DEFAULT_TASK_STATE_SAVE_RETRY_BASE_MS;
    this.retryMaxMs = deps.retryMaxMs ?? DEFAULT_TASK_STATE_SAVE_RETRY_MAX_MS;
    this.retryMaxAttempts = deps.retryMaxAttempts ?? DEFAULT_TASK_STATE_SAVE_RETRY_MAX_ATTEMPTS;
    this.now = deps.now ?? (() => Date.now());
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
    // A pending retry timer already owns recovery; piggyback on it rather than
    // arming a second concurrent timer.
    if (this.timer || this.retryTimer) return;
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.flush(this.latestReason).catch((err) => {
        console.error(`[tasks-save] coalesced save failed after ${this.coalesceMs}ms window:`, err);
        this.scheduleRetry();
      });
    }, this.coalesceMs);
  }

  /**
   * Current automatic-retry state for a persisting transient failure, or null
   * once a durable write clears the accounting. Note this stays non-null after
   * the attempt cap is reached (no timer is armed, but the dirty state is still
   * awaiting a write); `ageMs` is how long the dirty state has been awaiting a
   * successful write since the first failed attempt (issue #2775).
   */
  retryState(): { attempt: number; ageMs: number } | null {
    if (this.retryStartedAtMs === null) return null;
    return { attempt: this.retryAttempt, ageMs: this.now() - this.retryStartedAtMs };
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
      // A durable write clears any in-progress retry accounting (issue #2775):
      // the next transient failure starts a fresh backoff schedule.
      this.retryAttempt = 0;
      this.retryStartedAtMs = null;
    } catch (err) {
      this.deps.persistenceHealth?.recordFailure('task_state', err);
      console.error(`[tasks-save] ${reason} save failed:`, err);
      throw err;
    }
  }

  /**
   * Re-arm a bounded, backing-off retry after a timer-driven save failed while
   * dirty state remains (issue #2775). Stops after the attempt cap; the dirty
   * flag is preserved so the periodic force flush and close paths still recover.
   */
  private scheduleRetry(): void {
    if (!this.dirty) return;
    if (this.inFlight || this.timer || this.retryTimer) return;
    if (this.retryStartedAtMs === null) this.retryStartedAtMs = this.now();
    // The attempt cap is global until a durable write resets it (see saveNow):
    // a persistent failure many minutes on is no longer "transient", so we stop
    // amplifying it and hand recovery to the periodic force flush. A new mutation
    // burst after the cap still gets its one coalesced attempt but no fresh
    // backoff schedule until a save finally succeeds.
    if (this.retryAttempt >= this.retryMaxAttempts) {
      const ageMs = this.now() - this.retryStartedAtMs;
      console.error(
        `[tasks-save] giving up automatic retry after ${this.retryAttempt} attempts (dirty age ${ageMs}ms); ` +
          `dirty state preserved for the next periodic force flush`,
      );
      return;
    }
    const delay = Math.min(this.retryBaseMs * 2 ** this.retryAttempt, this.retryMaxMs);
    this.retryAttempt += 1;
    const ageMs = this.now() - this.retryStartedAtMs;
    console.error(
      `[tasks-save] re-arming task-state save retry #${this.retryAttempt} in ${delay}ms (dirty age ${ageMs}ms)`,
    );
    this.retryTimer = this.setTimeoutFn(() => {
      this.retryTimer = null;
      void this.flush(this.latestReason).catch((err) => {
        console.error(`[tasks-save] retried save failed after ${delay}ms backoff:`, err);
        this.scheduleRetry();
      });
    }, delay);
  }

  private clearPendingTimer(): void {
    if (this.timer) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    if (this.retryTimer) {
      this.clearTimeoutFn(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
