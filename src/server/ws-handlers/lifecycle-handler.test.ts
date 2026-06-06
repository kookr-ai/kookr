import { describe, expect, test, vi } from 'vitest';
import { TaskStore } from '../../core/tasks.js';
import { Monitor } from '../../core/monitor.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { LifecycleHandler, type LifecycleHandlerDeps } from './lifecycle-handler.js';

vi.mock('../../adapters/git-worktree.js', () => ({
  cleanupTaskWorktrees: vi.fn(async () => undefined),
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
});
