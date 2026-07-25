import { describe, it, expect } from 'vitest';
import { listExpiredPendingTasks, DEFAULT_PENDING_TASK_TTL_MS } from './pending-task-ttl.js';
import type { Task } from './task-read-model.js';

const NOW = new Date('2026-07-25T12:00:00Z');

function pendingTask(overrides: Partial<Task> = {}): Task {
  const createdAt = overrides.createdAt ?? new Date(NOW.getTime() - 5 * 60_000);
  return {
    id: overrides.id ?? `task-${Math.random().toString(36).slice(2)}`,
    prompt: 'do work',
    cwd: '/tmp',
    agentType: 'claude-code',
    status: 'pending',
    sessions: [],
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  } as Task;
}

describe('listExpiredPendingTasks (issue #1526 Phase C / C3)', () => {
  const ttlMs = 60 * 60_000; // 1h for readable offsets

  it('selects pendings older than the TTL and leaves fresh ones untouched', () => {
    const stale = pendingTask({ id: 'stale', createdAt: new Date(NOW.getTime() - ttlMs - 1) });
    const fresh = pendingTask({ id: 'fresh', createdAt: new Date(NOW.getTime() - ttlMs + 60_000) });
    const expired = listExpiredPendingTasks([fresh, stale], { now: NOW, ttlMs });
    expect(expired.map((e) => e.task.id)).toEqual(['stale']);
    expect(expired[0].pendingForMs).toBe(ttlMs + 1);
  });

  it('boundary: exactly at the TTL expires (inclusive)', () => {
    const boundary = pendingTask({ id: 'boundary', createdAt: new Date(NOW.getTime() - ttlMs) });
    const justUnder = pendingTask({ id: 'under', createdAt: new Date(NOW.getTime() - ttlMs + 1) });
    const expired = listExpiredPendingTasks([boundary, justUnder], { now: NOW, ttlMs });
    expect(expired.map((e) => e.task.id)).toEqual(['boundary']);
  });

  it('ignores non-pending statuses regardless of age', () => {
    const old = new Date(NOW.getTime() - 10 * ttlMs);
    const tasks = [
      pendingTask({ id: 'open', status: 'open', createdAt: old }),
      pendingTask({ id: 'inProgress', status: 'inProgress', createdAt: old }),
      pendingTask({ id: 'completed', status: 'completed', createdAt: old }),
      pendingTask({ id: 'cancelled', status: 'cancelled', createdAt: old }),
    ];
    expect(listExpiredPendingTasks(tasks, { now: NOW, ttlMs })).toEqual([]);
  });

  it('skips a pending task that a promoter has reserved for launch', () => {
    const stale = pendingTask({ id: 'reserved', createdAt: new Date(NOW.getTime() - 2 * ttlMs) });
    const expired = listExpiredPendingTasks([stale], {
      now: NOW,
      ttlMs,
      hasFreshLaunchReservation: (id) => id === 'reserved',
    });
    expect(expired).toEqual([]);
  });

  it('skips a pending task that somehow has sessions (launched once)', () => {
    const withSession = pendingTask({
      id: 'has-session',
      createdAt: new Date(NOW.getTime() - 2 * ttlMs),
      sessions: [{ tmuxSession: 'kookr-x', agentType: 'claude-code', cwd: '/tmp', createdAt: NOW } as Task['sessions'][number]],
    });
    expect(listExpiredPendingTasks([withSession], { now: NOW, ttlMs })).toEqual([]);
  });

  it('parented (chain) tasks expire the same as detached tasks', () => {
    const child = pendingTask({
      id: 'child',
      parentTaskId: 'parent-1',
      createdAt: new Date(NOW.getTime() - 2 * ttlMs),
    });
    const expired = listExpiredPendingTasks([child], { now: NOW, ttlMs });
    expect(expired.map((e) => e.task.id)).toEqual(['child']);
  });

  it('returns oldest-first', () => {
    const older = pendingTask({ id: 'older', createdAt: new Date(NOW.getTime() - 3 * ttlMs) });
    const newer = pendingTask({ id: 'newer', createdAt: new Date(NOW.getTime() - 2 * ttlMs) });
    const expired = listExpiredPendingTasks([newer, older], { now: NOW, ttlMs });
    expect(expired.map((e) => e.task.id)).toEqual(['older', 'newer']);
  });

  it('defaults the TTL to 240 minutes', () => {
    expect(DEFAULT_PENDING_TASK_TTL_MS).toBe(240 * 60_000);
    const justUnderDefault = pendingTask({
      id: 'under-default',
      createdAt: new Date(NOW.getTime() - DEFAULT_PENDING_TASK_TTL_MS + 1),
    });
    const overDefault = pendingTask({
      id: 'over-default',
      createdAt: new Date(NOW.getTime() - DEFAULT_PENDING_TASK_TTL_MS),
    });
    const expired = listExpiredPendingTasks([justUnderDefault, overDefault], { now: NOW });
    expect(expired.map((e) => e.task.id)).toEqual(['over-default']);
  });
});
