import { describe, expect, it, vi } from 'vitest';
import { GitHubStateStore } from '../../core/github-state-store.js';
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

  it('refuses deletion while an exact probe cleanup marker owns a possible session', async () => {
    const taskStore = {
      getTask: vi.fn().mockReturnValue({
        id: 'task-1',
        sessions: [],
        launchAdmission: {
          status: 'probing',
          sessionId: 'kookr-create-before-attach',
        },
      }),
      deleteTask: vi.fn(),
    } as any;
    const stop = vi.fn();

    await expect(deleteTask({
      taskStore,
      adapter: { stop } as any,
      monitor: { unregisterAgent: vi.fn() } as any,
    }, 'task-1')).rejects.toThrow(/cleanup is in progress/);

    expect(stop).not.toHaveBeenCalled();
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

  it('drops GitHub store rows for the deleted task', async () => {
    const taskStore = {
      getTask: vi.fn().mockReturnValue({
        id: 'task-1',
        sessions: [{ tmuxSession: 'done-1', lastStatus: 'completed' }],
      }),
      deleteTask: vi.fn(),
    } as any;
    const githubStateStore = new GitHubStateStore();
    const ref = {
      type: 'pr' as const,
      owner: 'kookr-ai',
      repo: 'kookr',
      number: 42,
      url: 'https://github.com/kookr-ai/kookr/pull/42',
      taskId: 'task-1',
      detectedAt: new Date(),
      detectedFrom: 'agent-1',
    };
    githubStateStore.addReference(ref);
    githubStateStore.updatePRState({
      ref,
      title: 'Fix poll leak',
      status: 'open',
      mergeable: 'MERGEABLE',
      author: 'alice',
      branch: 'fix',
      baseBranch: 'main',
      reviewDecision: null,
      reviewers: [],
      unresolvedThreads: [],
      totalComments: 0,
      checks: [],
      lastFetchedAt: new Date(),
    });

    const ok = await deleteTask({
      taskStore,
      adapter: { stop: vi.fn().mockResolvedValue(undefined) },
      monitor: { unregisterAgent: vi.fn() } as any,
      githubStateStore,
    } as any, 'task-1');

    expect(ok).toBe(true);
    expect(taskStore.deleteTask).toHaveBeenCalledWith('task-1');
    expect(githubStateStore.getReferences('task-1')).toHaveLength(0);
    expect(githubStateStore.getPRState({ owner: 'kookr-ai', repo: 'kookr', number: 42 })).toBeNull();
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
