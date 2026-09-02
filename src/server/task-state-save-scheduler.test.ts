import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TaskStore } from '../core/tasks.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { PersistenceHealthTracker } from '../core/persistence-health.js';
import { TaskStateSaveScheduler } from './task-state-save-scheduler.js';

describe('TaskStateSaveScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('coalesces bursty mutation requests into one task-state write', async () => {
    const taskStore = new TaskStore();
    taskStore.createTask('A', '/repo');
    const taskStateSaver = vi.fn(async () => undefined);
    const scheduler = new TaskStateSaveScheduler({
      taskStore,
      tasksFile: '/tmp/tasks.json',
      coalesceMs: 50,
      taskStateSaver,
    });

    scheduler.requestSave('task_edges_mutation');
    scheduler.requestSave('task_relation_mutation');
    scheduler.requestSave('task_edges_mutation');

    expect(taskStateSaver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(49);
    expect(taskStateSaver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(taskStateSaver).toHaveBeenCalledTimes(1);
    expect(taskStateSaver).toHaveBeenCalledWith(
      expect.objectContaining({
        taskStore,
        tasksFile: '/tmp/tasks.json',
        policy: 'none',
      }),
    );
  });

  test('close synchronously flushes a pending dirty save and clears the delayed timer', async () => {
    const taskStore = new TaskStore();
    taskStore.createTask('A', '/repo');
    const taskStateSaver = vi.fn(async () => undefined);
    const scheduler = new TaskStateSaveScheduler({
      taskStore,
      tasksFile: '/tmp/tasks.json',
      coalesceMs: 1_000,
      taskStateSaver,
    });

    scheduler.requestSave('task_edges_mutation');
    await scheduler.close();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(taskStateSaver).toHaveBeenCalledTimes(1);
  });

  test('saves again when a mutation arrives while a save is in flight', async () => {
    const taskStore = new TaskStore();
    taskStore.createTask('A', '/repo');
    let releaseFirstSave: (() => void) | undefined;
    let callCount = 0;
    const taskStateSaver = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstSave = resolve;
        });
      }
    });
    const scheduler = new TaskStateSaveScheduler({
      taskStore,
      tasksFile: '/tmp/tasks.json',
      coalesceMs: 1_000,
      taskStateSaver,
    });

    const flush = scheduler.flush('periodic', { force: true });
    await Promise.resolve();
    expect(taskStateSaver).toHaveBeenCalledTimes(1);

    taskStore.createTask('B', '/repo');
    scheduler.requestSave('task_relation_mutation');
    releaseFirstSave?.();
    await flush;

    expect(taskStateSaver).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(taskStateSaver).toHaveBeenCalledTimes(2);
  });

  test('periodic force flush writes even when no mutation is dirty', async () => {
    const taskStore = new TaskStore();
    const queue = new AttentionQueue();
    const tracker = new PersistenceHealthTracker();
    const taskStateSaver = vi.fn(async () => undefined);
    const scheduler = new TaskStateSaveScheduler({
      taskStore,
      queue,
      tasksFile: '/tmp/tasks.json',
      persistenceHealth: tracker,
      taskStateSaver,
    });

    await scheduler.flush('periodic', { force: true, policy: 'daily' });

    expect(taskStateSaver).toHaveBeenCalledTimes(1);
    expect(taskStateSaver).toHaveBeenCalledWith(
      expect.objectContaining({
        taskStore,
        tasksFile: '/tmp/tasks.json',
        policy: 'daily',
        snoozes: [],
      }),
    );
    expect(tracker.snapshot().targets.task_state).toMatchObject({
      totalAttempts: 1,
      consecutiveFailures: 0,
      lastError: null,
    });
  });

  test('records persistence-health failures for scheduled saves', async () => {
    const taskStore = new TaskStore();
    const tracker = new PersistenceHealthTracker();
    const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    let calls = 0;
    const taskStateSaver = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw error;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const scheduler = new TaskStateSaveScheduler({
      taskStore,
      tasksFile: '/tmp/tasks.json',
      coalesceMs: 10,
      persistenceHealth: tracker,
      taskStateSaver,
    });

    scheduler.requestSave('task_edges_mutation');
    await vi.advanceTimersByTimeAsync(10);

    expect(tracker.snapshot().targets.task_state).toMatchObject({
      totalFailures: 1,
      consecutiveFailures: 1,
      lastError: { code: 'ENOSPC', hard: true },
    });
    expect(consoleError).toHaveBeenCalledWith('[tasks-save] task_edges_mutation save failed:', error);
    expect(consoleError).toHaveBeenCalledWith('[tasks-save] coalesced save failed after 10ms window:', error);

    await scheduler.flush('flush');

    expect(taskStateSaver).toHaveBeenCalledTimes(2);
    expect(tracker.snapshot().targets.task_state).toMatchObject({
      totalAttempts: 2,
      totalFailures: 1,
      consecutiveFailures: 0,
      lastError: null,
    });
  });

  test('re-arms a bounded retry after a transient failure without a new mutation or manual flush', async () => {
    const taskStore = new TaskStore();
    taskStore.createTask('A', '/repo');
    let calls = 0;
    const taskStateSaver = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('EIO transient');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const scheduler = new TaskStateSaveScheduler({
      taskStore,
      tasksFile: '/tmp/tasks.json',
      coalesceMs: 10,
      retryBaseMs: 500,
      taskStateSaver,
    });

    scheduler.requestSave('task_edges_mutation');
    await vi.advanceTimersByTimeAsync(10);
    expect(taskStateSaver).toHaveBeenCalledTimes(1);
    expect(scheduler.retryState()).toMatchObject({ attempt: 1 });

    // No further mutation and no manual flush — the retry timer fires on its own.
    await vi.advanceTimersByTimeAsync(499);
    expect(taskStateSaver).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(taskStateSaver).toHaveBeenCalledTimes(2);
    // A successful retry clears the dirty/retry accounting.
    expect(scheduler.retryState()).toBeNull();
  });

  test('uses exponential backoff clamped to the max delay and stops after the attempt cap', async () => {
    const taskStore = new TaskStore();
    taskStore.createTask('A', '/repo');
    const taskStateSaver = vi.fn(async () => {
      throw new Error('EIO persistent');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Params chosen so the clamp actually bites: base*2**attempt exceeds max
    // before the cap (attempt 2 wants 400ms, attempt 3 wants 800ms — both are
    // clamped to 250ms), so dropping the Math.min would change observable timing.
    const scheduler = new TaskStateSaveScheduler({
      taskStore,
      tasksFile: '/tmp/tasks.json',
      coalesceMs: 10,
      retryBaseMs: 100,
      retryMaxMs: 250,
      retryMaxAttempts: 4,
      taskStateSaver,
    });

    scheduler.requestSave('task_edges_mutation');
    await vi.advanceTimersByTimeAsync(10); // coalesced attempt #1
    expect(taskStateSaver).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100); // retry #1 (100ms)
    expect(taskStateSaver).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200); // retry #2 (200ms)
    expect(taskStateSaver).toHaveBeenCalledTimes(3);

    // retry #3 wants 400ms but is clamped to 250ms: nothing fires before 250,
    // and it fires exactly at 250 — an unclamped 400ms delay would not.
    await vi.advanceTimersByTimeAsync(249);
    expect(taskStateSaver).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(taskStateSaver).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(250); // retry #4 (also clamped to 250ms)
    expect(taskStateSaver).toHaveBeenCalledTimes(5);

    // Attempt cap reached: retry age is reported from the first failure (10ms
    // coalesce + 100 + 200 + 250 + 250 elapsed, minus the 10ms start stamp).
    expect(scheduler.retryState()).toEqual({ attempt: 4, ageMs: 800 });
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('giving up automatic retry after 4 attempts'),
    );

    // No further automatic retry is armed once the cap is reached.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(taskStateSaver).toHaveBeenCalledTimes(5);
  });

  test('a mutation after the cap gets one coalesced attempt but no fresh backoff schedule', async () => {
    const taskStore = new TaskStore();
    taskStore.createTask('A', '/repo');
    const taskStateSaver = vi.fn(async () => {
      throw new Error('EIO persistent');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const scheduler = new TaskStateSaveScheduler({
      taskStore,
      tasksFile: '/tmp/tasks.json',
      coalesceMs: 10,
      retryBaseMs: 100,
      retryMaxMs: 400,
      retryMaxAttempts: 2,
      taskStateSaver,
    });

    scheduler.requestSave('task_edges_mutation');
    await vi.advanceTimersByTimeAsync(10 + 100 + 200 + 5_000);
    expect(taskStateSaver).toHaveBeenCalledTimes(3); // coalesce + 2 retries, then give up

    // A brand-new mutation burst after the cap gets its single coalesced attempt,
    // but no fresh backoff schedule until a save finally succeeds.
    scheduler.requestSave('task_relation_mutation');
    await vi.advanceTimersByTimeAsync(10);
    expect(taskStateSaver).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(taskStateSaver).toHaveBeenCalledTimes(4);
  });

  test('preserves dirty state after the cap so a periodic force flush recovers', async () => {
    const taskStore = new TaskStore();
    taskStore.createTask('A', '/repo');
    let calls = 0;
    const taskStateSaver = vi.fn(async () => {
      calls += 1;
      if (calls <= 4) throw new Error('EIO persistent');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const scheduler = new TaskStateSaveScheduler({
      taskStore,
      tasksFile: '/tmp/tasks.json',
      coalesceMs: 10,
      retryBaseMs: 100,
      retryMaxMs: 400,
      retryMaxAttempts: 3,
      taskStateSaver,
    });

    scheduler.requestSave('task_edges_mutation');
    await vi.advanceTimersByTimeAsync(10 + 100 + 200 + 400 + 5_000);
    expect(taskStateSaver).toHaveBeenCalledTimes(4); // cap reached, gave up

    await scheduler.flush('periodic', { force: true });
    expect(taskStateSaver).toHaveBeenCalledTimes(5);
    expect(scheduler.retryState()).toBeNull();
  });

  test('a mutation during retry backoff does not arm a duplicate concurrent writer', async () => {
    const taskStore = new TaskStore();
    taskStore.createTask('A', '/repo');
    let calls = 0;
    const taskStateSaver = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('EIO transient');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const scheduler = new TaskStateSaveScheduler({
      taskStore,
      tasksFile: '/tmp/tasks.json',
      coalesceMs: 10,
      retryBaseMs: 500,
      taskStateSaver,
    });

    scheduler.requestSave('task_edges_mutation');
    await vi.advanceTimersByTimeAsync(10);
    expect(taskStateSaver).toHaveBeenCalledTimes(1);

    // Mutation arrives mid-backoff: it should piggyback on the pending retry
    // rather than arm a second coalesce timer. If a duplicate timer were armed
    // it would fire at +coalesceMs and drive an early save; assert no save fires
    // before the retry deadline so the guard regression is actually caught.
    await vi.advanceTimersByTimeAsync(100);
    scheduler.requestSave('task_relation_mutation');
    await vi.advanceTimersByTimeAsync(390); // just before the 500ms retry deadline
    expect(taskStateSaver).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10); // retry fires at 500ms total

    expect(taskStateSaver).toHaveBeenCalledTimes(2);
    expect(scheduler.retryState()).toBeNull();
  });

  test('close cancels a pending retry timer and flushes once', async () => {
    const taskStore = new TaskStore();
    taskStore.createTask('A', '/repo');
    let calls = 0;
    const taskStateSaver = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('EIO transient');
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const scheduler = new TaskStateSaveScheduler({
      taskStore,
      tasksFile: '/tmp/tasks.json',
      coalesceMs: 10,
      retryBaseMs: 500,
      taskStateSaver,
    });

    scheduler.requestSave('task_edges_mutation');
    await vi.advanceTimersByTimeAsync(10);
    expect(taskStateSaver).toHaveBeenCalledTimes(1);
    expect(scheduler.retryState()).toMatchObject({ attempt: 1 });

    await scheduler.close(); // cancels the retry timer, flushes the dirty state
    expect(taskStateSaver).toHaveBeenCalledTimes(2);
    expect(scheduler.retryState()).toBeNull();

    // The cancelled retry timer must not fire a duplicate write afterwards.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(taskStateSaver).toHaveBeenCalledTimes(2);
  });
});
