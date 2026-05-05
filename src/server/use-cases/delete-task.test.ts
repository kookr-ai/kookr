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
});
