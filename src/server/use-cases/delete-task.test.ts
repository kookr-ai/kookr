import { describe, expect, it, vi } from 'vitest';
import { deleteTask } from './delete-task.js';

describe('deleteTask use case', () => {
  it('returns false when the task does not exist', async () => {
    const taskStore = {
      getTask: vi.fn().mockReturnValue(undefined),
      deleteTask: vi.fn(),
    } as any;

    const result = await deleteTask({
      taskStore,
      adapter: { stop: vi.fn() } as any,
      monitor: { unregisterAgent: vi.fn() } as any,
    }, 'missing');

    expect(result).toBe(false);
    expect(taskStore.deleteTask).not.toHaveBeenCalled();
  });

  it('stops active sessions and deletes the task', async () => {
    const taskStore = {
      getTask: vi.fn().mockReturnValue({
        id: 'task-1',
        sessions: [
          { tmuxSession: 'live-1', lastStatus: 'inProgress' },
          { tmuxSession: 'done-1', lastStatus: 'completed' },
        ],
      }),
      deleteTask: vi.fn(),
    } as any;

    const adapter = { stop: vi.fn().mockResolvedValue(undefined) };
    const monitor = { unregisterAgent: vi.fn() };
    const hookWatcher = { stop: vi.fn() };
    const watchdog = { unregisterAgent: vi.fn() };

    const result = await deleteTask({
      taskStore,
      adapter,
      monitor,
      hookWatcher,
      watchdog,
    }, 'task-1');

    expect(result).toBe(true);
    expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect(adapter.stop).toHaveBeenCalledWith('live-1');
    expect(monitor.unregisterAgent).toHaveBeenCalledWith('live-1');
    expect(hookWatcher.stop).toHaveBeenCalledWith('live-1');
    expect(watchdog.unregisterAgent).toHaveBeenCalledWith('live-1');
    expect(taskStore.deleteTask).toHaveBeenCalledWith('task-1');
  });

  it('prunes the activity ledger and clears HookIngestion bookkeeping for every session', async () => {
    const taskStore = {
      getTask: vi.fn().mockReturnValue({
        id: 'task-1',
        sessions: [
          { tmuxSession: 'live-1', lastStatus: 'inProgress' },
          { tmuxSession: 'done-1', lastStatus: 'completed' },
        ],
      }),
      deleteTask: vi.fn(),
    } as any;

    const activityLedger = { pruneSession: vi.fn().mockResolvedValue(undefined) };
    const hookIngestion = { forgetSession: vi.fn() };

    await deleteTask({
      taskStore,
      adapter: { stop: vi.fn().mockResolvedValue(undefined) },
      monitor: { unregisterAgent: vi.fn() } as any,
      activityLedger,
      hookIngestion,
    } as any, 'task-1');

    // Both sessions get their ledger pruned + ingestion bookkeeping forgotten,
    // including the already-completed one whose terminal resources were
    // already released.
    expect(activityLedger.pruneSession).toHaveBeenCalledWith('live-1');
    expect(activityLedger.pruneSession).toHaveBeenCalledWith('done-1');
    expect(hookIngestion.forgetSession).toHaveBeenCalledWith('live-1');
    expect(hookIngestion.forgetSession).toHaveBeenCalledWith('done-1');
  });

  it('stops hook watchers for terminal sessions before deleting the task', async () => {
    const taskStore = {
      getTask: vi.fn().mockReturnValue({
        id: 'task-1',
        sessions: [
          { tmuxSession: 'aborted-before-hook-file', lastStatus: 'aborted' },
          { tmuxSession: 'completed-before-hook-file', lastStatus: 'completed' },
        ],
      }),
      deleteTask: vi.fn(),
    } as any;

    const adapter = { stop: vi.fn().mockResolvedValue(undefined) };
    const monitor = { unregisterAgent: vi.fn() };
    const hookWatcher = { stop: vi.fn() };
    const watchdog = { unregisterAgent: vi.fn() };
    const shadowRegistry = { unregisterAgent: vi.fn() };
    const suppressionTracker = { reset: vi.fn() };

    const result = await deleteTask({
      taskStore,
      adapter,
      monitor,
      hookWatcher,
      watchdog,
      shadowRegistry,
      suppressionTracker,
    }, 'task-1');

    expect(result).toBe(true);
    expect(adapter.stop).not.toHaveBeenCalled();
    expect(monitor.unregisterAgent).toHaveBeenCalledWith('aborted-before-hook-file');
    expect(monitor.unregisterAgent).toHaveBeenCalledWith('completed-before-hook-file');
    expect(hookWatcher.stop).toHaveBeenCalledWith('aborted-before-hook-file');
    expect(hookWatcher.stop).toHaveBeenCalledWith('completed-before-hook-file');
    expect(watchdog.unregisterAgent).toHaveBeenCalledWith('aborted-before-hook-file');
    expect(watchdog.unregisterAgent).toHaveBeenCalledWith('completed-before-hook-file');
    expect(shadowRegistry.unregisterAgent).toHaveBeenCalledWith('aborted-before-hook-file');
    expect(shadowRegistry.unregisterAgent).toHaveBeenCalledWith('completed-before-hook-file');
    expect(suppressionTracker.reset).toHaveBeenCalledWith('aborted-before-hook-file');
    expect(suppressionTracker.reset).toHaveBeenCalledWith('completed-before-hook-file');
    expect(taskStore.deleteTask).toHaveBeenCalledWith('task-1');
  });

  it('treats activity-ledger pruning as best-effort — does not fail the delete on filesystem error', async () => {
    const taskStore = {
      getTask: vi.fn().mockReturnValue({
        id: 'task-1',
        sessions: [{ tmuxSession: 'live-1', lastStatus: 'inProgress' }],
      }),
      deleteTask: vi.fn(),
    } as any;

    const activityLedger = { pruneSession: vi.fn().mockRejectedValue(new Error('EBUSY')) };
    const hookIngestion = { forgetSession: vi.fn() };

    const ok = await deleteTask({
      taskStore,
      adapter: { stop: vi.fn().mockResolvedValue(undefined) },
      monitor: { unregisterAgent: vi.fn() } as any,
      activityLedger,
      hookIngestion,
    } as any, 'task-1');

    expect(ok).toBe(true);
    expect(taskStore.deleteTask).toHaveBeenCalledWith('task-1');
    // Ingestion bookkeeping is still cleared even when the ledger prune fails.
    expect(hookIngestion.forgetSession).toHaveBeenCalledWith('live-1');
  });
});
