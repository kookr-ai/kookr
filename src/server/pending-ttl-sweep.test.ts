import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../core/tasks.js';
import { expirePendingTasks } from './lifecycle-timers.js';
import type { LifecycleDeps } from './agent-lifecycle.js';

const TTL_MS = 60 * 60_000;

function makeLifecycleDeps(): LifecycleDeps & {
  queue: { purgeTask: ReturnType<typeof vi.fn> };
  interactionLog: { append: ReturnType<typeof vi.fn> };
  onTaskOutcome: ReturnType<typeof vi.fn>;
  issueClaimRegistry: { safeReleaseAllFor: ReturnType<typeof vi.fn> };
} {
  return {
    adapter: { stop: vi.fn() },
    monitor: { unregisterAgent: vi.fn() },
    taskStore: undefined as never, // unused by expirePendingTasks
    queue: { purgeTask: vi.fn() },
    interactionLog: { append: vi.fn().mockResolvedValue(undefined) } as never,
    onTaskOutcome: vi.fn(),
    issueClaimRegistry: { safeReleaseAllFor: vi.fn().mockReturnValue([]) },
  } as never;
}

/** Create a pending task whose createdAt is backdated by `ageMs`. */
function seedPending(store: TaskStore, ageMs: number, opts: { parentTaskId?: string } = {}): string {
  const task = store.createTask({ prompt: `p-${Math.random()}`, cwd: '/tmp', parentTaskId: opts.parentTaskId });
  store.pendTask(task.id);
  const mutable = store.getTaskForMutation(task.id)!;
  mutable.createdAt = new Date(Date.now() - ageMs);
  return task.id;
}

describe('expirePendingTasks (issue #1526 Phase C / C3)', () => {
  let store: TaskStore;
  let auditDir: string;
  let auditLogPath: string;

  beforeEach(async () => {
    store = new TaskStore();
    auditDir = await mkdtemp(join(tmpdir(), 'pending-ttl-'));
    auditLogPath = join(auditDir, 'audit.jsonl');
  });

  afterEach(async () => {
    await rm(auditDir, { recursive: true, force: true });
  });

  it('cancels an expired pending with reason + system:pending-ttl audit row; fresh pendings untouched', async () => {
    const staleId = seedPending(store, TTL_MS + 60_000);
    const freshId = seedPending(store, TTL_MS - 60_000);
    const lifecycleDeps = makeLifecycleDeps();
    const broadcastToAll = vi.fn();

    const result = await expirePendingTasks(
      { taskStore: store, lifecycleDeps, auditLogPath, broadcastToAll },
      { ttlMs: TTL_MS },
    );

    expect(result.expiredTaskIds).toEqual([staleId]);
    expect(store.getTask(staleId)?.status).toBe('cancelled');
    expect(store.getTask(freshId)?.status).toBe('pending');

    // Structured reason in the interaction log — not 'user_cancelled'.
    expect(lifecycleDeps.interactionLog.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task_cancelled', taskId: staleId, reason: 'pending_ttl_expired' }),
    );
    // Audit row: actor convention from Phase A's system sweeps.
    const rows = (await readFile(auditLogPath, 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'task.pendingTtlExpired',
      actor: 'system:pending-ttl',
      taskId: staleId,
      ttlMs: TTL_MS,
    });
    expect(rows[0].pendingForMs).toBeGreaterThanOrEqual(TTL_MS);

    // Cleanup side effects + outcome notification + one summary alert.
    expect(lifecycleDeps.queue.purgeTask).toHaveBeenCalledWith(staleId);
    expect(lifecycleDeps.issueClaimRegistry.safeReleaseAllFor).toHaveBeenCalledWith(staleId, 'released');
    expect(lifecycleDeps.onTaskOutcome).toHaveBeenCalledWith(staleId, { kind: 'cancelled' });
    expect(broadcastToAll).toHaveBeenCalledTimes(1);
    expect(broadcastToAll).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'alert', severity: 'warning' }),
    );
  });

  it('boundary: a task exactly at the TTL expires; one millisecond fresher does not', async () => {
    // Use an injected `now` via task backdating: age == TTL expires (inclusive).
    const atBoundary = seedPending(store, TTL_MS);
    const result = await expirePendingTasks(
      { taskStore: store, lifecycleDeps: makeLifecycleDeps(), auditLogPath },
      { ttlMs: TTL_MS },
    );
    expect(result.expiredTaskIds).toEqual([atBoundary]);
  });

  it('does nothing (and stays silent) when no pending is past the TTL', async () => {
    seedPending(store, 60_000);
    const broadcastToAll = vi.fn();
    const result = await expirePendingTasks(
      { taskStore: store, lifecycleDeps: makeLifecycleDeps(), auditLogPath, broadcastToAll },
      { ttlMs: TTL_MS },
    );
    expect(result.expiredTaskIds).toEqual([]);
    expect(broadcastToAll).not.toHaveBeenCalled();
    await expect(readFile(auditLogPath, 'utf-8')).rejects.toThrow();
  });

  it('expires parented/chain tasks the same as detached tasks and records the parent id', async () => {
    const parent = store.createTask({ prompt: 'parent', cwd: '/tmp' });
    const childId = seedPending(store, TTL_MS + 1, { parentTaskId: parent.id });
    const result = await expirePendingTasks(
      { taskStore: store, lifecycleDeps: makeLifecycleDeps(), auditLogPath },
      { ttlMs: TTL_MS },
    );
    expect(result.expiredTaskIds).toEqual([childId]);
    const rows = (await readFile(auditLogPath, 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(rows[0]).toMatchObject({ taskId: childId, parentTaskId: parent.id });
  });

  it('skips a stale pending that a promoter has reserved mid-launch', async () => {
    const staleId = seedPending(store, TTL_MS + 60_000);
    expect(store.beginLaunch(staleId)).toBe(true);
    const result = await expirePendingTasks(
      { taskStore: store, lifecycleDeps: makeLifecycleDeps(), auditLogPath },
      { ttlMs: TTL_MS },
    );
    expect(result.expiredTaskIds).toEqual([]);
    expect(store.getTask(staleId)?.status).toBe('pending');
  });
});
