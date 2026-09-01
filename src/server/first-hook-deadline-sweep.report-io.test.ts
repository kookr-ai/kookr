/**
 * Report-I/O isolation tests for the first-hook-miss reaper (issue #2852).
 *
 * Mirrors `hung-task-reaper.report-io.test.ts`: mocks `node:fs/promises` to
 * simulate a wedged/full data directory and proves the same bounded, best-effort
 * report behavior for the first-hook-miss reaper. Kept out of the main suite so
 * that suite can use the real filesystem.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const fsControl = vi.hoisted(() => ({
  writeFileImpl: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: (...args: unknown[]) => fsControl.writeFileImpl(...args),
}));

import { TaskStore } from '../core/tasks.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { DEFAULT_FIRST_HOOK_DEADLINE_MS } from '../core/first-hook-deadline.js';
import {
  FirstHookMissMetrics,
  reapFirstHookMiss,
  type FirstHookMissEvidenceBundle,
} from './first-hook-deadline-sweep.js';

const REG = Date.parse('2026-08-04T12:00:00.000Z');
const NOW = new Date(REG + DEFAULT_FIRST_HOOK_DEADLINE_MS + 1_000);

function makeTask(taskStore: TaskStore) {
  const task = taskStore.createTask({ prompt: 'Do something', cwd: '/tmp' });
  taskStore.addSession(task.id, {
    tmuxSession: `kookr-${task.id}`,
    agentType: 'claude-code',
    cwd: '/tmp',
    createdAt: new Date('2026-08-04T00:00:00.000Z'),
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

function evidence(): FirstHookMissEvidenceBundle {
  return {
    waitedMs: DEFAULT_FIRST_HOOK_DEADLINE_MS + 1_000,
    deadlineMs: DEFAULT_FIRST_HOOK_DEADLINE_MS,
    registeredAt: REG,
    firstHookAt: 0,
    mcpStartupAt: 0,
    paneContent: 'stuck',
  };
}

describe('reapFirstHookMiss — bounded best-effort report write (issue #2852)', () => {
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

  test('a never-settling report write does not delay termination or the miss counter', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    const adapterStop = vi.fn(async () => undefined);
    const metrics = new FirstHookMissMetrics();
    fsControl.writeFileImpl.mockImplementation(() => new Promise<void>(() => {}));

    const result = await reapFirstHookMiss(task, evidence(), {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore, adapterStop),
      metrics,
      reportsDir: '/does/not/matter',
      reportPersistTimeoutMs: 25,
      now: () => NOW,
    });

    expect(adapterStop).toHaveBeenCalledWith(task.sessions[0].tmuxSession);
    expect(taskStore.getTask(task.id)?.status).toBe('terminated');
    expect(taskStore.getActiveCount()).toBe(0);
    expect(metrics.getSnapshot().firstHookMissTotal).toBe(1);
    expect(result.reportPersistence).toBe('timeout');
    expect(result.reportPath).toBeUndefined();
  });

  test('a rejected report write is observed as error without an unhandled rejection', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    fsControl.writeFileImpl.mockRejectedValue(new Error('ENOSPC: no space left on device'));

    const result = await reapFirstHookMiss(task, evidence(), {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      reportsDir: '/does/not/matter',
      now: () => NOW,
    });

    expect(taskStore.getTask(task.id)?.status).toBe('terminated');
    expect(result.reportPersistence).toBe('error');
    expect(result.reportPath).toBeUndefined();

    await new Promise((r) => setTimeout(r, 0));
    expect(unhandled).toEqual([]);
  });

  test('a fast successful write still resolves ok with a report path', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    fsControl.writeFileImpl.mockResolvedValue(undefined);

    const result = await reapFirstHookMiss(task, evidence(), {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      reportsDir: '/reports',
      now: () => NOW,
    });

    expect(result.reportPersistence).toBe('ok');
    expect(result.reportPath).toContain(task.id);
  });
});
