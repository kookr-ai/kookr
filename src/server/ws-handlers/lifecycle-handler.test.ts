import { describe, expect, test, vi } from 'vitest';
import { TaskStore } from '../../core/tasks.js';
import { Monitor } from '../../core/monitor.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { LifecycleHandler, type LifecycleHandlerDeps } from './lifecycle-handler.js';

const mockCleanupTaskWorktrees = vi.fn(async () => undefined);
vi.mock('../../adapters/git-worktree.js', () => ({
  cleanupTaskWorktrees: (...args: unknown[]) => mockCleanupTaskWorktrees(...args),
}));

function addSession(taskStore: TaskStore, taskId: string, tmuxSession = 'kookr-session'): void {
  taskStore.addSession(taskId, {
    tmuxSession,
    agentType: 'claude-code',
    cwd: '/repo-wt',
    createdAt: new Date(),
  });
}

function makeDeps(taskStore: TaskStore, overrides: Partial<LifecycleHandlerDeps> = {}) {
  const queue = new AttentionQueue();
  const monitor = new Monitor(taskStore, queue);
  const stop = vi.fn(async () => undefined);
  const deps: LifecycleHandlerDeps = {
    send: vi.fn(),
    taskStore,
    monitor,
    queue,
    ralphLoopService: {
      cancelLoop: vi.fn((task) => {
        taskStore.getTaskForMutation(task.id)!.ralphLoop!.status = 'cancelled';
        return { ok: true, value: 'cancelled', changed: true };
      }),
    } as never,
    getLifecycleDeps: () => ({
      adapter: { stop },
      monitor,
      taskStore,
      hookWatcher: { stop: vi.fn() },
      watchdog: { unregisterAgent: vi.fn() },
    } as never),
    tryPromotePending: vi.fn(async () => undefined),
    ...overrides,
  };
  return { deps, stop };
}

describe('LifecycleHandler lifecycle commands', () => {
  test('forwards the per-task cleanup override to the shared lifecycle', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Keep worktree', '/repo');
    addSession(taskStore, task.id);
    const { deps } = makeDeps(taskStore);
    const handler = new LifecycleHandler(deps);

    await handler.handle({ type: 'completeTask', taskId: task.id, cleanupWorktree: false });

    expect(mockCleanupTaskWorktrees).not.toHaveBeenCalled();
  });

  test('completeTask delegates active Ralph completion to shared partial policy', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Ralph loop', '/repo');
    addSession(taskStore, task.id);
    taskStore.getTaskForMutation(task.id)!.ralphLoop = { status: 'running', iteration: 3 } as never;
    const { deps, stop } = makeDeps(taskStore);
    const handler = new LifecycleHandler(deps);

    await handler.handle({ type: 'completeTask', taskId: task.id });

    expect(taskStore.getTask(task.id)?.status).toBe('inProgress');
    expect(taskStore.getTask(task.id)?.sessions[0].lastStatus).toBe('completed');
    expect(stop).toHaveBeenCalledWith('kookr-session');
    expect(deps.tryPromotePending).not.toHaveBeenCalled();
  });

  test('cancelTask delegates Ralph cancellation before stopping the owner session', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Ralph loop', '/repo');
    addSession(taskStore, task.id);
    taskStore.getTaskForMutation(task.id)!.ralphLoop = { status: 'running', iteration: 1 } as never;
    const order: string[] = [];
    const { deps } = makeDeps(taskStore, {
      ralphLoopService: {
        cancelLoop: vi.fn((loopTask) => {
          order.push('cancelLoop');
          taskStore.getTaskForMutation(loopTask.id)!.ralphLoop!.status = 'cancelled';
          return { ok: true, value: 'cancelled', changed: true };
        }),
      } as never,
      getLifecycleDeps: () => ({
        adapter: {
          stop: vi.fn(async () => {
            order.push('stop');
            expect(taskStore.getTask(task.id)?.ralphLoop?.status).toBe('cancelled');
          }),
        },
        monitor: new Monitor(taskStore, new AttentionQueue()),
        taskStore,
      } as never),
    });
    const handler = new LifecycleHandler(deps);

    await handler.handle({ type: 'cancelTask', taskId: task.id });

    expect(order).toEqual(['cancelLoop', 'stop']);
    expect(taskStore.getTask(task.id)?.status).toBe('cancelled');
    expect(deps.tryPromotePending).toHaveBeenCalledOnce();
  });

  test('clearCompleted delegates finished-task deletion through the shared command', async () => {
    const taskStore = new TaskStore();
    const completed = taskStore.createTask('Done', '/repo');
    addSession(taskStore, completed.id, 'kookr-done');
    taskStore.completeTask(completed.id);
    const active = taskStore.createTask('Running', '/repo');
    addSession(taskStore, active.id, 'kookr-active');
    const takePredeleteSnapshot = vi.fn(async () => undefined);
    const { deps } = makeDeps(taskStore, { takePredeleteSnapshot });
    const handler = new LifecycleHandler(deps);

    await handler.handle({ type: 'clearCompleted' });

    expect(takePredeleteSnapshot).toHaveBeenCalledOnce();
    expect(taskStore.getTask(completed.id)).toBeUndefined();
    expect(taskStore.getTask(active.id)?.status).toBe('inProgress');
  });

  test('batchAbortTasks aborts active tasks and broadcasts a concise result summary', async () => {
    const taskStore = new TaskStore();
    const live = taskStore.createTask('live', '/repo');
    addSession(taskStore, live.id, 'kookr-live');
    const done = taskStore.createTask('done', '/repo');
    addSession(taskStore, done.id, 'kookr-done');
    taskStore.completeTask(done.id);
    const broadcastToAll = vi.fn();
    const { deps, stop } = makeDeps(taskStore, {
      broadcastToAll,
      deletionAuditActor: () => ({ source: 'websocket', actorId: 'conn-1' }),
    });
    const handler = new LifecycleHandler(deps);

    await handler.handle({ type: 'batchAbortTasks', taskIds: [live.id, done.id, 'missing'] });

    expect(taskStore.getTask(live.id)?.status).toBe('cancelled');
    expect(stop).toHaveBeenCalledWith('kookr-live');
    // done was already terminal → no second teardown of its session.
    expect(stop).not.toHaveBeenCalledWith('kookr-done');
    expect(broadcastToAll).toHaveBeenCalledWith(expect.objectContaining({
      type: 'alert',
      summary: 'Aborted 1 task',
      severity: 'info',
    }));
  });

  test('batchAbortTasks drops remote-owned SharedTask IDs before aborting', async () => {
    const taskStore = new TaskStore();
    const live = taskStore.createTask('live', '/repo');
    addSession(taskStore, live.id, 'kookr-live');
    const broadcastToAll = vi.fn();
    const { deps, stop } = makeDeps(taskStore, { broadcastToAll });
    const handler = new LifecycleHandler(deps);

    await handler.handle({ type: 'batchAbortTasks', taskIds: [live.id, 'shared:remote-1'] });

    expect(taskStore.getTask(live.id)?.status).toBe('cancelled');
    expect(stop).toHaveBeenCalledWith('kookr-live');
    // The shared id must be filtered *before* the command, not merely resolved
    // to not_found there. If it reached the command, total would be 2 and the
    // details would read "1 not found"; filtered, only the single local task is
    // considered, so details reads "1 selected".
    expect(broadcastToAll).toHaveBeenCalledWith(expect.objectContaining({
      type: 'alert',
      summary: 'Aborted 1 task',
      details: '1 selected',
    }));
  });

  test('batchAbortTasks flags partial failures with a warning-severity summary', async () => {
    const taskStore = new TaskStore();
    const bad = taskStore.createTask('bad', '/repo');
    addSession(taskStore, bad.id, 'kookr-bad');
    const broadcastToAll = vi.fn();
    const { deps } = makeDeps(taskStore, { broadcastToAll });
    deps.getLifecycleDeps = () => ({
      adapter: { stop: vi.fn(async () => { throw new Error('stop failed'); }) },
      monitor: deps.monitor,
      taskStore,
      hookWatcher: { stop: vi.fn() },
      watchdog: { unregisterAgent: vi.fn() },
    } as never);
    const handler = new LifecycleHandler(deps);

    await handler.handle({ type: 'batchAbortTasks', taskIds: [bad.id] });

    expect(taskStore.getTask(bad.id)?.status).toBe('inProgress');
    expect(broadcastToAll).toHaveBeenCalledWith(expect.objectContaining({
      type: 'alert',
      summary: 'Aborted 0 tasks',
      severity: 'warning',
    }));
  });
});
