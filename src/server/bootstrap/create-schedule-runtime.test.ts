import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { TaskStore } from '../../core/tasks.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import type { LaunchServiceDeps } from '../launch-service.js';
import { createScheduleRuntime, unwindCatchUpDuplicate } from './create-schedule-runtime.js';

describe('createScheduleRuntime', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  test('loads schedule state and wires schedule broadcasts through the server broadcaster', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-schedule-'));
    const messages: ServerMessage[] = [];

    const runtime = await createScheduleRuntime({
      kookrDir: tempDir,
      taskStore: new TaskStore(),
      launchServiceDeps: {} as LaunchServiceDeps,
      getMaxActiveTasks: () => 5,
      broadcastToAll: (msg) => messages.push(msg),
    });

    expect(runtime.scheduleStore.list()).toEqual([]);
    runtime.scheduleService.recordRunnerStarted('auto');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({
      type: 'schedules',
      schedules: [],
      status: expect.objectContaining({
        catchUpMode: 'auto',
        catchUpEnabled: true,
        schedulerHealthy: true,
        runnerStartedAt: expect.any(String),
      }),
    }));
  });

  // issue #1914: the catch-up lease-CAS unwind hook wired into the runner.
  describe('unwindCatchUpDuplicate', () => {
    test('terminates an inProgress duplicate as a non-recoverable supervisor kill', () => {
      const store = new TaskStore();
      const task = store.createTask({ prompt: 'catch-up', cwd: '/cwd', launchSource: 'schedule' });
      store.startTask(task.id);

      unwindCatchUpDuplicate(store, task.id, 'relaunch lease taken mid-fire by other-actuator');

      const after = store.getTask(task.id)!;
      expect(after.status).toBe('terminated');
      // `supervisor` is non-recoverable (crash-recovery skips it), so the
      // duplicate is not relaunched after the lease holder already owns the work.
      expect(after.terminationReason).toBe('supervisor');
      expect(after.terminationDetail).toBe(
        'catch-up duplicate unwound — relaunch lease taken mid-fire by other-actuator',
      );
    });

    test('cancels a pending (queued) duplicate rather than throwing on an invalid terminate transition', () => {
      const store = new TaskStore();
      const task = store.createTask({ prompt: 'catch-up', cwd: '/cwd', launchSource: 'schedule' });
      store.pendTask(task.id);
      expect(store.getTask(task.id)!.status).toBe('pending');

      // `pending → terminated` is not a valid transition; the hook must cancel
      // instead of letting terminateTask throw and abort the catch-up loop.
      expect(() =>
        unwindCatchUpDuplicate(store, task.id, 'relaunch lease taken mid-fire by other-actuator'),
      ).not.toThrow();
      expect(store.getTask(task.id)!.status).toBe('cancelled');
    });

    test('terminates an open (not-yet-started) duplicate', () => {
      const store = new TaskStore();
      const task = store.createTask({ prompt: 'catch-up', cwd: '/cwd', launchSource: 'schedule' });
      expect(store.getTask(task.id)!.status).toBe('open');

      unwindCatchUpDuplicate(store, task.id, 'relaunch lease entered backoff mid-fire');

      expect(store.getTask(task.id)!.status).toBe('terminated');
    });

    test('is a no-op for an unknown task id', () => {
      const store = new TaskStore();
      expect(() => unwindCatchUpDuplicate(store, 'nope', 'detail')).not.toThrow();
    });

    test('swallows a throwing terminal transition so the catch-up loop is never aborted', () => {
      // Best-effort contract: if the task went terminal between the status read
      // and the write (here simulated by a throwing store), the hook logs rather
      // than propagating — a throw would abort the once-per-boot catch-up loop.
      const throwingStore = {
        getTask: () => ({ id: 't1', status: 'inProgress' }) as any,
        cancelTask: () => {
          throw new Error('should not be reached for inProgress');
        },
        terminateTask: () => {
          throw new Error('raced to terminal');
        },
      };
      expect(() => unwindCatchUpDuplicate(throwingStore, 't1', 'detail')).not.toThrow();
    });
  });
});
