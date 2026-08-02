import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Task } from '../core/tasks.js';
import { aSession, aTask } from '../core/__fixtures__/task-builders.js';
import {
  reclaimAgedFinishedAwaitingAckTasks,
  FinishedAwaitingAckTtlReclaimMetrics,
} from './finished-awaiting-ack-ttl-sweep.js';
import type { LifecycleDeps } from './agent-lifecycle.js';

// Mock cleanupTaskWorktrees (fire-and-forget in completeTask)
const mockCleanupTaskWorktrees = vi.fn().mockResolvedValue(undefined);
vi.mock('../adapters/git-worktree.js', () => ({
  cleanupTaskWorktrees: (...args: unknown[]) => mockCleanupTaskWorktrees(...args),
}));

// Mock removeReflectWorktree (fire-and-forget reflect-worktree reclaim on terminal transitions)
vi.mock('./use-cases/request-task-reflect.js', () => ({
  removeReflectWorktree: vi.fn().mockResolvedValue(true),
}));

const NOW = new Date('2026-08-02T12:00:00.000Z');
const TTL_MS = 15 * 60_000;

function makeFaaTask(overrides: Partial<Task> = {}): Task {
  return aTask({
    id: 'task-1',
    status: 'inProgress',
    sessions: [aSession({ tmuxSession: 'kookr-abc', lastStatus: 'inProgress' })],
    pendingSignal: {
      kind: 'completion_ready',
      raisedAt: new Date(NOW.getTime() - TTL_MS - 60_000).toISOString(),
    },
    ...overrides,
  });
}

function makeMockTaskStore(tasks: Task[]) {
  return {
    listTasks: vi.fn(() => tasks),
    getTask: vi.fn((id: string) => tasks.find((t) => t.id === id)),
    completeTask: vi.fn(),
    updateSession: vi.fn(),
    updateSessionWorktreeHealth: vi.fn(),
    setCriteriaVerdict: vi.fn(),
    clearPendingSignal: vi.fn(),
  } as any;
}

function makeLifecycleDeps(taskStore: any, overrides: Partial<LifecycleDeps> = {}): LifecycleDeps {
  return {
    adapter: { stop: vi.fn().mockResolvedValue(undefined) },
    monitor: { unregisterAgent: vi.fn() },
    taskStore,
    interactionLog: { append: vi.fn().mockResolvedValue(undefined) } as any,
    hookWatcher: { stop: vi.fn() },
    watchdog: { unregisterAgent: vi.fn() },
    queue: { purgeTask: vi.fn() },
    issueClaimRegistry: { safeReleaseAllFor: vi.fn().mockReturnValue([]) },
    onTaskOutcome: vi.fn(),
    ...overrides,
  };
}

describe('reclaimAgedFinishedAwaitingAckTasks (issue #1884)', () => {
  let auditDir: string;
  let auditLogPath: string;

  beforeEach(async () => {
    auditDir = await mkdtemp(join(tmpdir(), 'faa-ttl-'));
    auditLogPath = join(auditDir, 'audit.jsonl');
  });

  afterEach(async () => {
    await rm(auditDir, { recursive: true, force: true });
  });

  it('force-completes an aged finishedAwaitingAck task with reason finished_awaiting_ack_ttl + system:finished-awaiting-ack-ttl audit row', async () => {
    const task = makeFaaTask();
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const broadcastToAll = vi.fn();
    const metrics = new FinishedAwaitingAckTtlReclaimMetrics();

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      {
        taskStore,
        lifecycleDeps,
        auditLogPath,
        broadcastToAll,
        isHoldingOpenPr: () => false,
        metrics,
      },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual(['task-1']);
    expect(taskStore.completeTask).toHaveBeenCalledWith('task-1');
    expect(taskStore.clearPendingSignal).toHaveBeenCalledWith('task-1');

    expect(lifecycleDeps.interactionLog!.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task_completed', taskId: 'task-1', reason: 'finished_awaiting_ack_ttl' }),
    );

    const rows = (await readFile(auditLogPath, 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'task.finishedAwaitingAckTtlReclaimed',
      actor: 'system:finished-awaiting-ack-ttl',
      taskId: 'task-1',
      reason: 'finished_awaiting_ack_ttl',
      ttlMs: TTL_MS,
    });
    expect(rows[0].ageMs).toBeGreaterThanOrEqual(TTL_MS);

    expect(broadcastToAll).toHaveBeenCalledTimes(1);
    expect(broadcastToAll).toHaveBeenCalledWith(expect.objectContaining({ type: 'alert', severity: 'warning' }));

    expect(metrics.getSnapshot()).toEqual({ reclaimedTotal: 1 });
  });

  it('exempts a stranded-PR task (isHoldingOpenPr === true) — the merge_required path is never clobbered', async () => {
    const task = makeFaaTask({ id: 'stranded' });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const isHoldingOpenPr = vi.fn(() => true);

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      { taskStore, lifecycleDeps, auditLogPath, isHoldingOpenPr },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
    expect(isHoldingOpenPr).toHaveBeenCalledWith(task);
    await expect(readFile(auditLogPath, 'utf-8')).rejects.toThrow();
  });

  it('exempts every candidate (fail-safe) when isHoldingOpenPr is not wired at all', async () => {
    const task = makeFaaTask({ id: 'no-predicate' });
    const taskStore = makeMockTaskStore([task]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      { taskStore, lifecycleDeps, auditLogPath },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(taskStore.completeTask).not.toHaveBeenCalled();
  });

  it('is a no-op (and stays silent) when lifecycleDeps is absent', async () => {
    const task = makeFaaTask();
    const taskStore = makeMockTaskStore([task]);
    const broadcastToAll = vi.fn();

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      { taskStore, auditLogPath, broadcastToAll, isHoldingOpenPr: () => false },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(broadcastToAll).not.toHaveBeenCalled();
  });

  it('does nothing (and stays silent) when no finishedAwaitingAck task is past the TTL', async () => {
    const fresh = makeFaaTask({
      id: 'fresh',
      pendingSignal: { kind: 'completion_ready', raisedAt: new Date(NOW.getTime() - 60_000).toISOString() },
    });
    const taskStore = makeMockTaskStore([fresh]);
    const lifecycleDeps = makeLifecycleDeps(taskStore);
    const broadcastToAll = vi.fn();

    const result = await reclaimAgedFinishedAwaitingAckTasks(
      { taskStore, lifecycleDeps, auditLogPath, broadcastToAll, isHoldingOpenPr: () => false },
      { now: NOW, ttlMs: TTL_MS },
    );

    expect(result.reclaimedTaskIds).toEqual([]);
    expect(broadcastToAll).not.toHaveBeenCalled();
    await expect(readFile(auditLogPath, 'utf-8')).rejects.toThrow();
  });
});
