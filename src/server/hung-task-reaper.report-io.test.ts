/**
 * Report-I/O isolation tests for the hung-task reaper (issue #2852).
 *
 * These live in their own file because they mock `node:fs/promises` to simulate
 * a wedged/full data directory — a never-settling or rejecting report write.
 * The main suite (`hung-task-reaper.test.ts`) uses the real filesystem for its
 * happy-path assertions, so the module mock is kept out of it.
 *
 * What they prove:
 * - A report write that never settles cannot delay task termination or capacity
 *   release: the reaper terminates first, then bounds the write.
 * - A rejected report write is observed (status `error`) without escaping as an
 *   unhandled promise rejection.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Hoisted controls for the mocked fs writer. `writeFile` behavior is swapped
// per test; `mkdir` always resolves so only the file write is under test.
const fsControl = vi.hoisted(() => ({
  writeFileImpl: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: (...args: unknown[]) => fsControl.writeFileImpl(...args),
}));

import { TaskStore } from '../core/tasks.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { reapHungTask, type HungTaskReapEvidence } from './hung-task-reaper.js';

function makeTask(taskStore: TaskStore) {
  const task = taskStore.createTask({ prompt: 'Do something', cwd: '/tmp' });
  taskStore.addSession(task.id, {
    tmuxSession: `kookr-${task.id}`,
    agentType: 'claude-code',
    cwd: '/tmp',
    createdAt: new Date('2026-06-19T00:00:00.000Z'),
  });
  return taskStore.getTask(task.id)!;
}

function lifecycleDeps(taskStore: TaskStore, adapterStop = vi.fn(async () => undefined)) {
  return {
    adapter: { stop: adapterStop },
    monitor: { unregisterAgent: vi.fn(), getAgentEvents: vi.fn(() => []) },
    taskStore,
    queue: new AttentionQueue(),
    hookWatcher: { stop: vi.fn() },
    watchdog: { unregisterAgent: vi.fn() },
  };
}

function evidence(): HungTaskReapEvidence {
  return {
    silentForMs: 3 * 60 * 60 * 1000,
    thresholdMs: 3 * 60 * 60 * 1000,
    lastHookEventAt: Date.parse('2026-06-20T21:00:00.000Z'),
    lastPaneChangeAt: Date.parse('2026-06-20T21:00:00.000Z'),
    lastTokenActivityAt: Date.parse('2026-06-20T21:00:00.000Z'),
    paneContent: 'frozen pane',
  };
}

describe('reapHungTask — bounded best-effort report write (issue #2852)', () => {
  let unhandled: unknown[];
  const onUnhandled = (err: unknown) => unhandled.push(err);

  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
    fsControl.writeFileImpl.mockReset();
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  test('a never-settling report write does not delay termination or capacity release', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    const adapterStop = vi.fn(async () => undefined);
    // The write never resolves — the pathological wedged-directory case.
    fsControl.writeFileImpl.mockImplementation(() => new Promise<void>(() => {}));

    const result = await reapHungTask(task, evidence(), {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore, adapterStop),
      reportsDir: '/does/not/matter',
      reportPersistTimeoutMs: 25, // short bound so the test is fast
      now: () => new Date('2026-06-21T00:00:00.000Z'),
    });

    // The session was killed and the slot freed even though the report is stuck.
    expect(adapterStop).toHaveBeenCalledWith(task.sessions[0].tmuxSession);
    expect(taskStore.getTask(task.id)?.status).toBe('terminated');
    expect(taskStore.getActiveCount()).toBe(0);
    // Report abandoned, and the failure is surfaced (not silently swallowed).
    expect(result.reportPersistence).toBe('timeout');
    expect(result.reportPath).toBeUndefined();
    expect(result.outcome).toBe('terminated');
  });

  test('a rejected report write is observed as error without an unhandled rejection', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    fsControl.writeFileImpl.mockRejectedValue(new Error('ENOSPC: no space left on device'));

    const result = await reapHungTask(task, evidence(), {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      reportsDir: '/does/not/matter',
      now: () => new Date('2026-06-21T00:00:00.000Z'),
    });

    expect(taskStore.getTask(task.id)?.status).toBe('terminated');
    expect(result.reportPersistence).toBe('error');
    expect(result.reportPath).toBeUndefined();

    // Give any stray rejection a tick to surface, then assert none did.
    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).toEqual([]);
  });

  test('a fast successful write still resolves ok with a report path', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    fsControl.writeFileImpl.mockResolvedValue(undefined);

    const result = await reapHungTask(task, evidence(), {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      reportsDir: '/reports',
      now: () => new Date('2026-06-21T00:00:00.000Z'),
    });

    expect(result.reportPersistence).toBe('ok');
    expect(result.reportPath).toContain(task.id);
    expect(fsControl.writeFileImpl).toHaveBeenCalledTimes(1);
  });
});
