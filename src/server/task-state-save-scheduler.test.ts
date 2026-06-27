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

  test('coalesces bursty mutation requests into one tasks.json write', async () => {
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
      expect.arrayContaining([expect.objectContaining({ prompt: 'A' })]),
      '/tmp/tasks.json',
      'none',
      0,
      undefined,
      undefined,
      [],
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
    expect(taskStateSaver.mock.calls[1][0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ prompt: 'A' }),
        expect.objectContaining({ prompt: 'B' }),
      ]),
    );
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
    expect(taskStateSaver).toHaveBeenCalledWith([], '/tmp/tasks.json', 'daily', 0, [], undefined, []);
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
});
