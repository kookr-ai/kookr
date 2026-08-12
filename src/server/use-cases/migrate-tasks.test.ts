import { describe, test, expect, vi } from 'vitest';
import { migrateTasks, resolveMigratable, type MigrateTasksDeps } from './migrate-tasks.js';
import type { Task, TaskStore } from '../../core/tasks.js';
import type { LaunchOpts, LaunchResult } from '../launch-service.js';
import { PendingQueueFullError, SpawnBurstLimitError } from '../launch-service.js';

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? 't1',
    prompt: 'p',
    userPrompt: 'do the thing',
    cwd: overrides.cwd ?? '/repo',
    agentType: 'grok-build',
    status: 'terminated',
    sessions: [],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  } as Task;
}

function fakeStore(tasks: Task[]): TaskStore & { links: Record<string, string> } {
  const map = new Map(tasks.map((t) => [t.id, t]));
  const links: Record<string, string> = {};
  return {
    links,
    getAllTasks: () => [...map.values()],
    getTask: (id: string) => map.get(id),
    setMigrationLink: (src: string, cont: string) => {
      links[src] = cont;
      const t = map.get(src);
      if (t) (t as Task).migratedToTaskId = cont;
    },
  } as unknown as TaskStore & { links: Record<string, string> };
}

function baseDeps(store: TaskStore, over: Partial<MigrateTasksDeps> = {}): MigrateTasksDeps {
  let counter = 0;
  return {
    taskStore: store,
    launchTask: vi.fn(async (opts: LaunchOpts): Promise<LaunchResult> => {
      counter++;
      return { task: { id: `new-${counter}` }, queued: false } as LaunchResult;
    }),
    availableAgentTypes: () => ['claude-code', 'codex-cli', 'grok-build'],
    hasLiveSession: () => false,
    cwdExists: () => true,
    isGitRepo: async () => true,
    readWorktree: async (_cwd, shared) => ({ isGitRepo: true, uncommitted: [], shared }),
    ...over,
  };
}

describe('migrateTasks', () => {
  test('migrates a single grok task to claude with lineage + substitution hop', async () => {
    const store = fakeStore([task()]);
    const deps = baseDeps(store);
    const res = await migrateTasks(deps, {
      scope: { kind: 'ids', taskIds: ['t1'] },
      targetAgent: 'claude-code',
    });
    expect(res.results).toEqual([
      expect.objectContaining({ taskId: 't1', outcome: 'migrated', newTaskId: 'new-1' }),
    ]);
    expect(store.links['t1']).toBe('new-1');
    const launchArg = (deps.launchTask as ReturnType<typeof vi.fn>).mock.calls[0][0] as LaunchOpts;
    expect(launchArg.agentType).toBe('claude-code');
    expect(launchArg.migratedFromTaskId).toBe('t1');
    expect(launchArg.priorAgentSubstitutions).toEqual([
      { reason: 'task_migrate', from: 'grok-build', to: 'claude-code' },
    ]);
    // No deterministic idempotency key — a fixed key would let the 24h ledger
    // replay a dead successor and falsely report `migrated` (correctness #2).
    expect(launchArg.idempotencyKey).toBeUndefined();
    expect(launchArg.prompt).toContain('do the thing');
  });

  test('re-migrating after the prior continuation died launches fresh (not deduped)', async () => {
    // Source already has a successor, but that successor is terminal (died).
    const source = task({ id: 's', migratedToTaskId: 'dead' });
    const dead = task({ id: 'dead', status: 'terminated', agentType: 'claude-code' });
    const store = fakeStore([source, dead]);
    const deps = baseDeps(store);
    const res = await migrateTasks(deps, {
      scope: { kind: 'ids', taskIds: ['s'] },
      targetAgent: 'claude-code',
    });
    // alreadyMigrated is false (successor terminal) → a NEW continuation launches.
    expect(res.results[0].outcome).toBe('migrated');
    expect(store.links['s']).not.toBe('dead');
    expect((deps.launchTask as ReturnType<typeof vi.fn>).mock.calls[0][0].idempotencyKey).toBeUndefined();
  });

  test('a LIVE successor blocks re-migration (already_migrated)', async () => {
    const source = task({ id: 's', migratedToTaskId: 'live' });
    const live = task({ id: 'live', status: 'inProgress', agentType: 'claude-code' });
    const store = fakeStore([source, live]);
    const res = await migrateTasks(baseDeps(store), {
      scope: { kind: 'ids', taskIds: ['s'] },
      targetAgent: 'claude-code',
    });
    expect(res.results[0]).toMatchObject({ outcome: 'blocked', reason: 'already_migrated' });
  });

  test('a queued continuation reports outcome "queued"', async () => {
    const store = fakeStore([task()]);
    const deps = baseDeps(store, {
      launchTask: vi.fn(async () => ({ task: { id: 'q1' }, queued: true })) as unknown as MigrateTasksDeps['launchTask'],
    });
    const res = await migrateTasks(deps, { scope: { kind: 'ids', taskIds: ['t1'] }, targetAgent: 'claude-code' });
    expect(res.results[0]).toMatchObject({ outcome: 'queued', newTaskId: 'q1' });
  });

  test('spawn_burst and launch_failed map to bounded blocked outcomes', async () => {
    const store = fakeStore([task()]);
    const burst = baseDeps(store, {
      launchTask: vi.fn(async () => { throw new SpawnBurstLimitError(5); }) as unknown as MigrateTasksDeps['launchTask'],
    });
    expect((await migrateTasks(burst, { scope: { kind: 'ids', taskIds: ['t1'] }, targetAgent: 'claude-code' })).results[0]).toMatchObject({ outcome: 'blocked', reason: 'spawn_burst' });
    const failed = baseDeps(store, {
      launchTask: vi.fn(async () => { throw new Error('boom'); }) as unknown as MigrateTasksDeps['launchTask'],
    });
    expect((await migrateTasks(failed, { scope: { kind: 'ids', taskIds: ['t1'] }, targetAgent: 'claude-code' })).results[0]).toMatchObject({ outcome: 'blocked', reason: 'launch_failed' });
  });

  test('a blocked (queue_full) migrate does NOT terminate an inProgress source', async () => {
    const src = task({ id: 'ip', status: 'inProgress' });
    const store = fakeStore([src]);
    const terminateTask = vi.fn(async () => {});
    const deps = baseDeps(store, {
      hasLiveSession: () => false,
      terminateTask,
      launchTask: vi.fn(async () => { throw new PendingQueueFullError(24); }) as unknown as MigrateTasksDeps['launchTask'],
    });
    const res = await migrateTasks(deps, { scope: { kind: 'ids', taskIds: ['ip'] }, targetAgent: 'claude-code' });
    expect(res.results[0]).toMatchObject({ outcome: 'blocked', reason: 'queue_full' });
    expect(terminateTask).not.toHaveBeenCalled(); // source not quiesced on a retryable failure
  });

  test('all + fromAgent filter migrates only that agent\'s interrupted tasks', async () => {
    const store = fakeStore([
      task({ id: 'g1', cwd: '/a' }),
      task({ id: 'c1', cwd: '/b', agentType: 'claude-code' }),
      task({ id: 'g2', cwd: '/c', status: 'completed' }),
    ]);
    const res = await migrateTasks(baseDeps(store), {
      scope: { kind: 'all', fromAgent: 'grok-build' },
      targetAgent: 'claude-code',
    });
    const migrated = res.results.filter((r) => r.outcome === 'migrated').map((r) => r.taskId);
    expect(migrated).toEqual(['g1']); // g2 completed→blocked, c1 filtered out
    const byId = Object.fromEntries(res.results.map((r) => [r.taskId, r]));
    expect(byId['g2']).toMatchObject({ outcome: 'blocked', reason: 'status_not_migratable' });
    expect(byId['c1']).toBeUndefined(); // filtered out by fromAgent, not in results
  });

  test('per-worktree dedup: two tasks in one cwd → one migrates, one contended', async () => {
    const store = fakeStore([
      task({ id: 'a', cwd: '/shared', updatedAt: new Date('2026-01-02') }),
      task({ id: 'b', cwd: '/shared', updatedAt: new Date('2026-01-01') }),
    ]);
    const res = await migrateTasks(baseDeps(store), {
      scope: { kind: 'ids', taskIds: ['a', 'b'] },
      targetAgent: 'claude-code',
    });
    const byId = Object.fromEntries(res.results.map((r) => [r.taskId, r.outcome]));
    expect(byId['a']).toBe('migrated'); // newest wins
    expect(byId['b']).toBe('blocked');
    expect(res.results.find((r) => r.taskId === 'b')?.reason).toBe('worktree_contended');
  });

  test('queue_full surfaces as a bounded blocked outcome, not a throw', async () => {
    const store = fakeStore([task()]);
    const deps = baseDeps(store, {
      launchTask: vi.fn(async () => {
        throw new PendingQueueFullError(24);
      }) as unknown as MigrateTasksDeps['launchTask'],
    });
    const res = await migrateTasks(deps, { scope: { kind: 'ids', taskIds: ['t1'] }, targetAgent: 'claude-code' });
    expect(res.results[0]).toMatchObject({ outcome: 'blocked', reason: 'queue_full' });
  });

  test('setAsDefault is applied only when a migration succeeded', async () => {
    const store = fakeStore([task()]);
    const setDefaultAgent = vi.fn(async () => ({ updated: true }));
    const res = await migrateTasks(baseDeps(store, { setDefaultAgent }), {
      scope: { kind: 'ids', taskIds: ['t1'] },
      targetAgent: 'claude-code',
      setAsDefault: true,
    });
    expect(res.defaultUpdated).toBe(true);
    expect(setDefaultAgent).toHaveBeenCalledWith('claude-code');
  });

  test('setAsDefault suppressed when every migration fails', async () => {
    const store = fakeStore([task({ status: 'completed' })]);
    const setDefaultAgent = vi.fn(async () => ({ updated: true }));
    const res = await migrateTasks(baseDeps(store, { setDefaultAgent }), {
      scope: { kind: 'ids', taskIds: ['t1'] },
      targetAgent: 'claude-code',
      setAsDefault: true,
    });
    expect(res.defaultUpdated).toBe(false);
    expect(res.defaultUpdateReason).toBe('no_successful_migration');
    expect(setDefaultAgent).not.toHaveBeenCalled();
  });

  test('ids scope migrates a user-cancelled task (explicit selection = opt-in)', async () => {
    const store = fakeStore([task({ status: 'cancelled' })]);
    const res = await migrateTasks(baseDeps(store), {
      scope: { kind: 'ids', taskIds: ['t1'] },
      targetAgent: 'claude-code',
    });
    expect(res.results[0].outcome).toBe('migrated');
  });

  test('all scope excludes cancelled unless includeCancelled', async () => {
    const store = fakeStore([task({ status: 'cancelled' })]);
    const res = await migrateTasks(baseDeps(store), {
      scope: { kind: 'all', fromAgent: 'grok-build' },
      targetAgent: 'claude-code',
    });
    expect(res.results.find((r) => r.taskId === 't1')?.outcome).toBe('blocked');
    const res2 = await migrateTasks(baseDeps(store), {
      scope: { kind: 'all', fromAgent: 'grok-build', includeCancelled: true },
      targetAgent: 'claude-code',
    });
    expect(res2.results.find((r) => r.taskId === 't1')?.outcome).toBe('migrated');
  });

  test('same-agent target routes to restore', async () => {
    const store = fakeStore([task()]);
    const res = await migrateTasks(baseDeps(store), {
      scope: { kind: 'ids', taskIds: ['t1'] },
      targetAgent: 'grok-build',
    });
    expect(res.results[0]).toMatchObject({ outcome: 'blocked', reason: 'same_agent_use_restore' });
  });

  test('unknown ids report not_found', async () => {
    const store = fakeStore([task()]);
    const { blocked } = await resolveMigratable(baseDeps(store), 'claude-code', { taskIds: ['nope'] });
    expect(blocked).toEqual([{ taskId: 'nope', outcome: 'blocked', reason: 'not_found' }]);
  });
});
