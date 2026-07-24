import { describe, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function lifecycleDeps(taskStore: TaskStore) {
  return {
    adapter: { stop: vi.fn(async () => undefined) },
    monitor: { unregisterAgent: vi.fn(), getAgentEvents: vi.fn(() => []) },
    taskStore,
    queue: new AttentionQueue(),
    hookWatcher: { stop: vi.fn() },
    watchdog: { unregisterAgent: vi.fn() },
  };
}

function evidence(overrides: Partial<HungTaskReapEvidence> = {}): HungTaskReapEvidence {
  return {
    silentForMs: 3 * 60 * 60 * 1000,
    thresholdMs: 3 * 60 * 60 * 1000,
    lastHookEventAt: Date.parse('2026-06-20T21:00:00.000Z'),
    lastPaneChangeAt: Date.parse('2026-06-20T21:00:00.000Z'),
    lastTokenActivityAt: Date.parse('2026-06-20T21:00:00.000Z'),
    paneContent: Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n'),
    ...overrides,
  };
}

async function readAuditRows(auditLogPath: string): Promise<Record<string, unknown>[]> {
  try {
    const content = await readFile(auditLogPath, 'utf-8');
    return content.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

describe('reapHungTask', () => {
  test('terminates the task, kills the session, and frees the slot', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    const adapterStop = vi.fn(async () => undefined);

    await reapHungTask(task, evidence(), {
      taskStore,
      lifecycleDeps: { ...lifecycleDeps(taskStore), adapter: { stop: adapterStop } },
      now: () => new Date('2026-06-21T00:00:00.000Z'),
    });

    expect(taskStore.getTask(task.id)?.status).toBe('terminated');
    expect(adapterStop).toHaveBeenCalledWith(task.sessions[0].tmuxSession);
    // 'terminated' is not counted by getActiveCount — slot is freed.
    expect(taskStore.getActiveCount()).toBe(0);
  });

  test('purges the attention-queue entry for the session', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    const queue = new AttentionQueue();
    const purgeSpy = vi.spyOn(queue, 'purgeTask');
    const deps = { ...lifecycleDeps(taskStore), queue };

    await reapHungTask(task, evidence(), {
      taskStore,
      lifecycleDeps: deps,
      now: () => new Date('2026-06-21T00:00:00.000Z'),
    });

    expect(purgeSpy).toHaveBeenCalledWith(task.id);
  });

  test('writes a markdown report with task id, timeline, and a bounded pane tail', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    const reportsDir = await mkdtemp(join(tmpdir(), 'kookr-reports-'));

    const result = await reapHungTask(task, evidence(), {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      reportsDir,
      now: () => new Date('2026-06-21T00:00:00.000Z'),
    });

    expect(result.reportPath).toBeDefined();
    const files = await readdir(reportsDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(task.id);

    const content = await readFile(result.reportPath!, 'utf-8');
    expect(content).toContain(task.id);
    expect(content).toContain('Liveness timeline');
    // Pane tail is capped at 50 lines out of the 80 fed in.
    expect(content).not.toContain('line 29');
    expect(content).toContain('line 30');
    expect(content).toContain('line 79');
  });

  test('writes an audit row with actor system:hung-task-reaper', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    const auditLogPath = join(await mkdtemp(join(tmpdir(), 'kookr-audit-')), 'audit.jsonl');

    await reapHungTask(task, evidence(), {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      auditLogPath,
      now: () => new Date('2026-06-21T00:00:00.000Z'),
    });

    const rows = await readAuditRows(auditLogPath);
    const expectedEvidence = evidence();
    expect(rows).toEqual([{
      type: 'task.hungTaskReap',
      timestamp: expect.any(String),
      actor: 'system:hung-task-reaper',
      taskId: task.id,
      silentForMs: expectedEvidence.silentForMs,
      thresholdMs: expectedEvidence.thresholdMs,
      evidence: {
        lastHookEventAt: expectedEvidence.lastHookEventAt,
        lastPaneChangeAt: expectedEvidence.lastPaneChangeAt,
        lastTokenActivityAt: expectedEvidence.lastTokenActivityAt,
      },
      // No reportsDir passed to this test — no reportPath key at all.
    }]);
  });

  test('broadcasts a warning alert', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);
    const broadcastToAll = vi.fn();

    await reapHungTask(task, evidence(), {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      broadcastToAll,
      now: () => new Date('2026-06-21T00:00:00.000Z'),
    });

    expect(broadcastToAll).toHaveBeenCalledTimes(1);
    expect(broadcastToAll).toHaveBeenCalledWith(expect.objectContaining({ type: 'alert', severity: 'warning' }));
  });

  test('terminating still succeeds when reportsDir/auditLogPath are absent', async () => {
    const taskStore = new TaskStore();
    const task = makeTask(taskStore);

    const result = await reapHungTask(task, evidence(), {
      taskStore,
      lifecycleDeps: lifecycleDeps(taskStore),
      now: () => new Date('2026-06-21T00:00:00.000Z'),
    });

    expect(result.reportPath).toBeUndefined();
    expect(taskStore.getTask(task.id)?.status).toBe('terminated');
  });
});
