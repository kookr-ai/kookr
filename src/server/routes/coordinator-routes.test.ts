import { describe, test, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../core/tasks.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { Monitor } from '../../core/monitor.js';
import type { CoordinatorRouteDeps } from './shared.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { buildCoordinatorSnapshotState } from '../coordinator/detectors.js';
import { buildCoordinatorDetectorTasks } from '../use-cases/get-snapshot.js';
import { registerCoordinatorRoutes } from './coordinator-routes.js';

function mkApp(deps: Partial<CoordinatorRouteDeps>): Hono {
  const app = new Hono();
  registerCoordinatorRoutes(app, deps as unknown as CoordinatorRouteDeps);
  return app;
}

function broadcastNoop(_msg: ServerMessage): void {
  /* no-op */
}

function mkLoopDeps(taskStore = new TaskStore()): CoordinatorRouteDeps {
  const queue = new AttentionQueue();
  const monitor = new Monitor(taskStore, queue);
  return {
    taskStore,
    monitor,
    queue,
    broadcastToAll: broadcastNoop,
    serverCwd: '/server',
    adapter: {} as never,
  } as CoordinatorRouteDeps;
}

describe('POST /api/coordinator/acknowledgements', () => {
  test('acknowledges one done-not-cleared task without hiding peer recommendations', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'coordinator-ack-route-'));
    const taskStore = new TaskStore();
    const first = taskStore.createTask('First done task', '/repo');
    const second = taskStore.createTask('Second done task', '/repo');
    taskStore.startTask(first.id);
    taskStore.startTask(second.id);
    taskStore.completeTask(first.id);
    taskStore.completeTask(second.id);
    taskStore.getTaskForMutation(first.id)!.completionDigest = { bullets: ['done'], filesChanged: [] };
    taskStore.getTaskForMutation(second.id)!.completionDigest = { bullets: ['done'], filesChanged: [] };
    const broadcastToAll = vi.fn();
    try {
      const app = mkApp({ ...mkLoopDeps(taskStore), broadcastToAll, kookrDir: tempDir });

      const res = await app.request('/api/coordinator/acknowledgements', {
        method: 'POST',
        body: JSON.stringify({
          taskId: first.id,
          detectorId: 'done_not_cleared',
        }),
        headers: { 'Content-Type': 'application/json' },
      });

      expect(res.status).toBe(200);
      const message = broadcastToAll.mock.calls[0]?.[0] as Extract<ServerMessage, { type: 'snapshot' }>;
      expect(message.type).toBe('snapshot');
      expect(message.coordinator?.chips.map((chip) => chip.taskId)).toEqual([second.id]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('POST /api/coordinator/mark-prior-done', () => {
  function mergedPrState(taskId: string) {
    return {
      taskId,
      prs: [{
        status: 'merged',
        checks: [{ name: 'CI', status: 'completed', conclusion: 'success' }],
      }],
      issues: [],
      changes: [],
      lastScanAt: new Date(),
    };
  }

  test('rejects prior tasks that are not safely terminal', async () => {
    const taskStore = new TaskStore();
    const parent = taskStore.createTask('Parent task', '/repo');
    const child = taskStore.createTask('Child task', '/repo', undefined, parent.id);
    const chain = buildCoordinatorSnapshotState({
      tasks: buildCoordinatorDetectorTasks(taskStore.listTasks(), []),
    }, []).chains[child.id]!;
    const githubScanner = { refreshTaskState: vi.fn().mockResolvedValue(undefined) };
    const app = mkApp({
      ...mkLoopDeps(taskStore),
      githubScanner,
      githubStateStore: { getTaskState: vi.fn() } as never,
    });

    const res = await app.request('/api/coordinator/mark-prior-done', {
      method: 'POST',
      body: JSON.stringify({
        taskId: child.id,
        priorTaskIds: [parent.id],
        concurrencyToken: chain.concurrencyToken,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining('only terminated tasks can be marked done automatically'),
    });
    expect(githubScanner.refreshTaskState).toHaveBeenCalledWith(parent.id);
  });

  test('rejects submitted prior ids that do not match the refreshed chain strip', async () => {
    const taskStore = new TaskStore();
    const parent = taskStore.createTask('Parent task', '/repo');
    const child = taskStore.createTask('Child task', '/repo', undefined, parent.id);
    const unrelated = taskStore.createTask('Unrelated task', '/repo');
    taskStore.startTask(parent.id);
    taskStore.startTask(unrelated.id);
    taskStore.terminateTask(parent.id);
    taskStore.terminateTask(unrelated.id);
    const chain = buildCoordinatorSnapshotState({
      tasks: buildCoordinatorDetectorTasks(taskStore.listTasks(), []),
    }, []).chains[child.id]!;
    const app = mkApp({
      ...mkLoopDeps(taskStore),
      githubScanner: { refreshTaskState: vi.fn().mockResolvedValue(undefined) } as never,
      githubStateStore: { getTaskState: vi.fn(() => mergedPrState(unrelated.id)) } as never,
    });

    const res = await app.request('/api/coordinator/mark-prior-done', {
      method: 'POST',
      body: JSON.stringify({
        taskId: child.id,
        priorTaskIds: [unrelated.id],
        concurrencyToken: chain.concurrencyToken,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'Submitted prior tasks no longer match the refreshed chain strip.',
    });
    expect(taskStore.getTask(unrelated.id)?.status).toBe('terminated');
  });

  test('rejects duplicate submitted prior ids even when every id belongs to the chain', async () => {
    const taskStore = new TaskStore();
    const parent = taskStore.createTask('Parent task', '/repo');
    const blocker = taskStore.createTask('Blocker task', '/repo');
    const child = taskStore.createTask('Child task', '/repo', undefined, parent.id);
    taskStore.setTaskEdges(child.id, { blocked_by: [`task:${blocker.id}`] });
    taskStore.startTask(parent.id);
    taskStore.startTask(blocker.id);
    taskStore.terminateTask(parent.id);
    taskStore.terminateTask(blocker.id);
    const chain = buildCoordinatorSnapshotState({
      tasks: buildCoordinatorDetectorTasks(taskStore.listTasks(), []),
    }, []).chains[child.id]!;
    expect(chain.priorTaskIds.sort()).toEqual([blocker.id, parent.id].sort());
    const app = mkApp({
      ...mkLoopDeps(taskStore),
      githubScanner: { refreshTaskState: vi.fn().mockResolvedValue(undefined) } as never,
      githubStateStore: { getTaskState: vi.fn(() => mergedPrState(parent.id)) } as never,
    });

    const res = await app.request('/api/coordinator/mark-prior-done', {
      method: 'POST',
      body: JSON.stringify({
        taskId: child.id,
        priorTaskIds: [parent.id, parent.id],
        concurrencyToken: chain.concurrencyToken,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: 'Submitted prior tasks no longer match the refreshed chain strip.',
    });
    expect(taskStore.getTask(parent.id)?.status).toBe('terminated');
    expect(taskStore.getTask(blocker.id)?.status).toBe('terminated');
  });

  test.each([
    {
      name: 'non-passing post-merge CI',
      taskPatch: (_taskStore: TaskStore, _parentId: string) => {},
      state: (taskId: string) => ({
        ...mergedPrState(taskId),
        prs: [{
          status: 'merged',
          checks: [{ name: 'CI', status: 'completed', conclusion: 'failure' }],
        }],
      }),
      error: 'non-passing post-merge CI: CI',
    },
    {
      name: 'dirty worktree health',
      taskPatch: (taskStore: TaskStore, parentId: string) => {
        taskStore.addSession(parentId, {
          tmuxSession: 'dirty-session',
          agentType: 'claude-code',
          cwd: '/repo-wt',
          createdAt: new Date(),
          worktreeHealth: 'dirty',
          lastStatus: 'completed',
        });
      },
      state: mergedPrState,
      error: 'worktree is dirty',
    },
  ])('rejects $name before completing prior tasks', async ({ taskPatch, state, error }) => {
    const taskStore = new TaskStore();
    const parent = taskStore.createTask('Parent task', '/repo');
    const child = taskStore.createTask('Child task', '/repo', undefined, parent.id);
    taskStore.startTask(parent.id);
    // Attach any fixture session while the task is still inProgress, THEN
    // terminate — the realistic ordering. A terminal task cannot gain a new
    // session (issue #1588 guard), and real terminated-with-session tasks got
    // their sessions before termination anyway.
    taskPatch(taskStore, parent.id);
    taskStore.terminateTask(parent.id);
    const chain = buildCoordinatorSnapshotState({
      tasks: buildCoordinatorDetectorTasks(taskStore.listTasks(), []),
    }, []).chains[child.id]!;
    const app = mkApp({
      ...mkLoopDeps(taskStore),
      githubScanner: { refreshTaskState: vi.fn().mockResolvedValue(undefined) } as never,
      githubStateStore: { getTaskState: vi.fn(() => state(parent.id)) } as never,
    });

    const res = await app.request('/api/coordinator/mark-prior-done', {
      method: 'POST',
      body: JSON.stringify({
        taskId: child.id,
        priorTaskIds: [parent.id],
        concurrencyToken: chain.concurrencyToken,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining(error) });
    expect(taskStore.getTask(parent.id)?.status).toBe('terminated');
  });

  test('marks matching terminated prior tasks done through the lifecycle path after click-time GitHub verification passes', async () => {
    const taskStore = new TaskStore();
    const parent = taskStore.createTask('Parent task', '/repo');
    const child = taskStore.createTask('Child task', '/repo', undefined, parent.id);
    taskStore.startTask(parent.id);
    taskStore.terminateTask(parent.id);
    const chain = buildCoordinatorSnapshotState({
      tasks: buildCoordinatorDetectorTasks(taskStore.listTasks(), []),
    }, []).chains[child.id]!;
    const broadcastToAll = vi.fn();
    const app = mkApp({
      ...mkLoopDeps(taskStore),
      broadcastToAll,
      githubScanner: { refreshTaskState: vi.fn().mockResolvedValue(undefined) } as never,
      githubStateStore: { getTaskState: vi.fn(() => mergedPrState(parent.id)) } as never,
    });

    const res = await app.request('/api/coordinator/mark-prior-done', {
      method: 'POST',
      body: JSON.stringify({
        taskId: child.id,
        priorTaskIds: [parent.id],
        concurrencyToken: chain.concurrencyToken,
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, completedTaskIds: [parent.id] });
    expect(taskStore.getTask(parent.id)?.status).toBe('completed');
    expect(broadcastToAll).toHaveBeenCalledOnce();
  });
});
