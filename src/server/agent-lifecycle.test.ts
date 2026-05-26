import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { Task } from '../core/tasks.js';
import { TaskStore } from '../core/tasks.js';
import {
  registerNewAgent,
  handleTerminalInput,
  handleTerminalKeystroke,
  completeTask,
  cancelTask,
  terminateTask,
  promotePendingTasks,
  type AgentLifecycleDeps,
  type TerminalInputDeps,
  type LifecycleDeps,
  type PromotionDeps,
} from './agent-lifecycle.js';
import type { AgentAdapter } from '../adapters/agent-adapter.js';
import { AdapterRegistry } from '../adapters/agent-adapter.js';

// Mock MAX_ACTIVE_TASKS to 2 for concurrency tests
vi.mock('./config.js', () => ({ MAX_ACTIVE_TASKS: 2 }));

// Mock getProjectId and deriveCanonicalPath so we can control their behavior
const mockGetProjectId = vi.fn();
const mockDeriveCanonicalPath = vi.fn();
vi.mock('../core/project-identity.js', () => ({
  getProjectId: (...args: unknown[]) => mockGetProjectId(...args),
  deriveCanonicalPath: (...args: unknown[]) => mockDeriveCanonicalPath(...args),
}));

// Mock cleanupTaskWorktrees (fire-and-forget in completeTask/cancelTask)
const mockCleanupTaskWorktrees = vi.fn().mockResolvedValue(undefined);
vi.mock('../adapters/git-worktree.js', () => ({
  cleanupTaskWorktrees: (...args: unknown[]) => mockCleanupTaskWorktrees(...args),
}));

// Mock nowISO for deterministic timestamps in interaction log assertions
vi.mock('../core/interaction-log.js', () => ({
  nowISO: () => '2026-03-31T00:00:00.000Z',
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    prompt: 'Fix the bug in auth',
    cwd: '/workspace/project',
    agentType: 'claude-code',
    status: 'inProgress',
    sessions: [{ tmuxSession: 'kookr-abc123', lastStatus: 'inProgress' }],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Task;
}

function makeDeps(overrides: Partial<AgentLifecycleDeps> = {}): AgentLifecycleDeps {
  return {
    monitor: { registerAgent: vi.fn() } as any,
    watchdog: { registerAgent: vi.fn() } as any,
    hookWatcher: { isWatching: vi.fn().mockReturnValue(false), watch: vi.fn() } as any,
    interactionLog: { append: vi.fn().mockResolvedValue(undefined) } as any,
    githubScanner: { isActive: vi.fn().mockReturnValue(false), processTaskPrompt: vi.fn() } as any,
    autoNameTask: vi.fn(),
    ...overrides,
  };
}

describe('registerNewAgent', () => {
  beforeEach(() => {
    mockGetProjectId.mockReset();
    mockDeriveCanonicalPath.mockReset();
    // Default: pass cwd through unchanged so the auto-stamp branch can fire
    // when a projectConfigStore is supplied.
    mockDeriveCanonicalPath.mockImplementation((cwd: string) => cwd);
  });

  test('registers all sessions with monitor', async () => {
    const task = makeTask({
      sessions: [
        { tmuxSession: 'kookr-a', lastStatus: 'inProgress' },
        { tmuxSession: 'kookr-b', lastStatus: 'inProgress' },
      ] as any,
    });
    const deps = makeDeps();

    await registerNewAgent(task, deps);

    expect(deps.monitor.registerAgent).toHaveBeenCalledWith('kookr-a');
    expect(deps.monitor.registerAgent).toHaveBeenCalledWith('kookr-b');
  });

  test('registers all sessions with watchdog', async () => {
    const task = makeTask();
    const deps = makeDeps();

    await registerNewAgent(task, deps);

    expect(deps.watchdog.registerAgent).toHaveBeenCalledWith('kookr-abc123');
  });

  test('starts hook watcher for sessions not already watched', async () => {
    const deps = makeDeps();

    await registerNewAgent(makeTask(), deps);

    expect(deps.hookWatcher.isWatching).toHaveBeenCalledWith('kookr-abc123');
    expect(deps.hookWatcher.watch).toHaveBeenCalledWith('kookr-abc123', { replayExisting: true });
  });

  test('skips hook watcher for sessions already watched', async () => {
    const deps = makeDeps({
      hookWatcher: { isWatching: vi.fn().mockReturnValue(true), watch: vi.fn() } as any,
    });

    await registerNewAgent(makeTask(), deps);

    expect(deps.hookWatcher.watch).not.toHaveBeenCalled();
  });

  test('logs agent_launched to interaction log', async () => {
    const deps = makeDeps();

    await registerNewAgent(makeTask(), deps);

    expect(deps.interactionLog!.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent_launched',
        agentId: 'kookr-abc123',
        taskPrompt: 'Fix the bug in auth',
      }),
    );
  });

  test('works without interactionLog (optional dep)', async () => {
    const deps = makeDeps({ interactionLog: undefined });

    await registerNewAgent(makeTask(), deps);

    // Core registrations still happen even without interaction log
    expect(deps.monitor.registerAgent).toHaveBeenCalledWith('kookr-abc123');
    expect(deps.watchdog.registerAgent).toHaveBeenCalledWith('kookr-abc123');
  });

  test('scans for GitHub references when scanner is active', async () => {
    const deps = makeDeps({
      githubScanner: {
        isActive: vi.fn().mockReturnValue(true),
        processTaskPrompt: vi.fn(),
      } as any,
    });

    await registerNewAgent(makeTask(), deps);

    expect(deps.githubScanner.processTaskPrompt).toHaveBeenCalledWith('task-1');
  });

  test('skips GitHub scan when scanner is inactive', async () => {
    const deps = makeDeps();

    await registerNewAgent(makeTask(), deps);

    expect(deps.githubScanner.processTaskPrompt).not.toHaveBeenCalled();
  });

  test('auto-names task when task has no name', async () => {
    const deps = makeDeps();

    await registerNewAgent(makeTask(), deps);

    expect(deps.autoNameTask).toHaveBeenCalledWith('task-1', 'Fix the bug in auth', '/workspace/project', undefined);
  });

  test('passes criteria to autoNameTask', async () => {
    const deps = makeDeps();
    const task = makeTask({ criteria: 'Must pass all tests' });

    await registerNewAgent(task, deps);

    expect(deps.autoNameTask).toHaveBeenCalledWith('task-1', 'Fix the bug in auth', '/workspace/project', 'Must pass all tests');
  });

  test('skips auto-naming when task already has a name (e.g., playbooks)', async () => {
    const deps = makeDeps();
    const task = makeTask({ name: 'My Playbook' });

    await registerNewAgent(task, deps);

    expect(deps.autoNameTask).not.toHaveBeenCalled();
  });

  test('resolves projectId via getProjectId when taskStore is provided', async () => {
    const mockSetProjectId = vi.fn();
    const deps = makeDeps({
      taskStore: { setProjectId: mockSetProjectId } as any,
    });
    mockGetProjectId.mockResolvedValue('kookr-abc');

    const task = makeTask({ projectId: undefined });
    await registerNewAgent(task, deps);

    // getProjectId is fire-and-forget — wait for it to settle
    await vi.waitFor(() => {
      expect(mockSetProjectId).toHaveBeenCalledWith('task-1', 'kookr-abc');
    });
  });

  test('getProjectId failure does not crash registration', async () => {
    const mockSetProjectId = vi.fn();
    const deps = makeDeps({
      taskStore: { setProjectId: mockSetProjectId } as any,
    });
    mockGetProjectId.mockRejectedValue(new Error('git not found'));

    const task = makeTask({ projectId: undefined });
    await registerNewAgent(task, deps);

    // Wait for the rejected promise to settle — setProjectId should NOT be called
    await vi.waitFor(() => {
      // The catch handler runs asynchronously; verify it settled by checking
      // that getProjectId was called (confirming the promise chain executed)
      expect(mockGetProjectId).toHaveBeenCalled();
    });
    expect(mockSetProjectId).not.toHaveBeenCalled();
  });

  test('uses task.id as agentId fallback when no sessions', async () => {
    const deps = makeDeps();
    const task = makeTask({ sessions: [] as any });

    await registerNewAgent(task, deps);

    expect(deps.interactionLog!.append).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'task-1',
      }),
    );
  });

  test('stamps ProjectConfig.localPath on first task start when configStore is provided', async () => {
    const setLocalPathIfUnset = vi.fn().mockResolvedValue(true);
    const deps = makeDeps({
      taskStore: { setProjectId: vi.fn() } as any,
      projectConfigStore: { setLocalPathIfUnset } as any,
    });
    mockGetProjectId.mockResolvedValue('github.com/org/repo');
    mockDeriveCanonicalPath.mockReturnValue('/canonical/repo');

    const task = makeTask({ projectId: undefined, cwd: '/canonical/repo-prod' });
    await registerNewAgent(task, deps);

    await vi.waitFor(() => {
      expect(setLocalPathIfUnset).toHaveBeenCalledWith(
        'github.com/org/repo',
        '/canonical/repo',
      );
    });
    // Pin that the indirection through deriveCanonicalPath actually happened
    // — a refactor that bypassed the helper and stamped task.cwd directly
    // would still satisfy the previous assertion (since mocks fall through).
    expect(mockDeriveCanonicalPath).toHaveBeenCalledWith('/canonical/repo-prod');
  });

  test('skips localPath stamp when deriveCanonicalPath returns null', async () => {
    const setLocalPathIfUnset = vi.fn().mockResolvedValue(false);
    const deps = makeDeps({
      taskStore: { setProjectId: vi.fn() } as any,
      projectConfigStore: { setLocalPathIfUnset } as any,
    });
    mockGetProjectId.mockResolvedValue('github.com/org/repo');
    mockDeriveCanonicalPath.mockReturnValue(null);

    const task = makeTask({ projectId: undefined, cwd: '/missing' });
    await registerNewAgent(task, deps);

    // Wait for the projectId resolution to complete so the canonical-path
    // branch has had a chance to run too.
    await vi.waitFor(() => {
      expect(mockDeriveCanonicalPath).toHaveBeenCalledWith('/missing');
    });
    expect(setLocalPathIfUnset).not.toHaveBeenCalled();
  });

  test('does not touch localPath when no projectConfigStore is provided', async () => {
    const deps = makeDeps({
      taskStore: { setProjectId: vi.fn() } as any,
    });
    mockGetProjectId.mockResolvedValue('github.com/org/repo');

    const task = makeTask({ projectId: undefined });
    await registerNewAgent(task, deps);

    await vi.waitFor(() => {
      expect(deps.taskStore!.setProjectId).toHaveBeenCalled();
    });
    expect(mockDeriveCanonicalPath).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleTerminalInput
// ---------------------------------------------------------------------------

function makeTerminalInputDeps(overrides: Partial<TerminalInputDeps> = {}): TerminalInputDeps {
  return {
    monitor: {
      markInputReceived: vi.fn().mockReturnValue(true),
      getSnapshot: vi.fn().mockReturnValue([]),
      isPermissionBlocked: vi.fn().mockReturnValue(false),
    } as any,
    watchdog: { recordInputReceived: vi.fn() },
    abortPendingSuggestion: vi.fn(),
    broadcastToAll: vi.fn(),
    serverCwd: '/workspace/project',
    ...overrides,
  };
}

describe('handleTerminalInput', () => {
  test('aborts suggestion and broadcasts when markInputReceived returns true', () => {
    const deps = makeTerminalInputDeps();

    handleTerminalInput(deps, 'kookr-session-1');

    expect(deps.monitor.markInputReceived).toHaveBeenCalledWith('kookr-session-1');
    expect(deps.watchdog?.recordInputReceived).toHaveBeenCalledWith('kookr-session-1');
    expect(deps.abortPendingSuggestion).toHaveBeenCalledWith('kookr-session-1');
    expect(deps.broadcastToAll).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'snapshot', serverCwd: '/workspace/project' }),
    );
  });

  test('does NOT abort or broadcast when markInputReceived returns false', () => {
    const deps = makeTerminalInputDeps({
      monitor: {
        markInputReceived: vi.fn().mockReturnValue(false),
        getSnapshot: vi.fn().mockReturnValue([]),
        isPermissionBlocked: vi.fn().mockReturnValue(false),
      } as any,
    });

    handleTerminalInput(deps, 'kookr-session-1');

    expect(deps.monitor.markInputReceived).toHaveBeenCalledWith('kookr-session-1');
    expect(deps.watchdog?.recordInputReceived).not.toHaveBeenCalled();
    expect(deps.abortPendingSuggestion).not.toHaveBeenCalled();
    expect(deps.broadcastToAll).not.toHaveBeenCalled();
  });
});

describe('handleTerminalKeystroke', () => {
  test('delegates to handleTerminalInput when agent is permission-blocked', () => {
    const deps = makeTerminalInputDeps({
      monitor: {
        markInputReceived: vi.fn().mockReturnValue(true),
        getSnapshot: vi.fn().mockReturnValue([]),
        isPermissionBlocked: vi.fn().mockReturnValue(true),
      } as any,
    });

    handleTerminalKeystroke(deps, 'kookr-session-1');

    // Should have gone through handleTerminalInput path
    expect(deps.monitor.markInputReceived).toHaveBeenCalledWith('kookr-session-1');
    expect(deps.abortPendingSuggestion).toHaveBeenCalledWith('kookr-session-1');
  });

  test('does nothing when agent is NOT permission-blocked', () => {
    const deps = makeTerminalInputDeps({
      monitor: {
        markInputReceived: vi.fn().mockReturnValue(true),
        getSnapshot: vi.fn().mockReturnValue([]),
        isPermissionBlocked: vi.fn().mockReturnValue(false),
      } as any,
    });

    handleTerminalKeystroke(deps, 'kookr-session-1');

    expect(deps.monitor.isPermissionBlocked).toHaveBeenCalledWith('kookr-session-1');
    expect(deps.monitor.markInputReceived).not.toHaveBeenCalled();
    expect(deps.abortPendingSuggestion).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// completeTask / cancelTask
// ---------------------------------------------------------------------------

function makeLifecycleDeps(overrides: Partial<LifecycleDeps> = {}): LifecycleDeps {
  return {
    adapter: { stop: vi.fn().mockResolvedValue(undefined) },
    monitor: { unregisterAgent: vi.fn() },
    taskStore: {
      getTask: vi.fn(),
      completeTask: vi.fn(),
      cancelTask: vi.fn(),
      terminateTask: vi.fn(),
      updateSession: vi.fn(),
      updateSessionWorktreeHealth: vi.fn(),
      findTaskBySession: vi.fn(),
    } as any,
    interactionLog: { append: vi.fn().mockResolvedValue(undefined) } as any,
    hookWatcher: { stop: vi.fn() },
    watchdog: { unregisterAgent: vi.fn() },
    ...overrides,
  };
}

describe('completeTask', () => {
  beforeEach(() => {
    mockCleanupTaskWorktrees.mockReset().mockResolvedValue(undefined);
  });

  test('throws Error when task not found', async () => {
    const deps = makeLifecycleDeps();
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    await expect(completeTask('nonexistent-id', deps)).rejects.toThrow('Task not found: nonexistent-id');
  });

  test('stops active sessions and marks task completed', async () => {
    const task = makeTask({
      id: 'task-42',
      status: 'inProgress',
      sessions: [
        { tmuxSession: 'kookr-s1', lastStatus: 'inProgress' },
      ] as any,
    });
    const deps = makeLifecycleDeps();
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await completeTask('task-42', deps);

    expect(deps.adapter.stop).toHaveBeenCalledWith('kookr-s1');
    expect(deps.monitor.unregisterAgent).toHaveBeenCalledWith('kookr-s1');
    expect(deps.taskStore.updateSession).toHaveBeenCalledWith('task-42', 'kookr-s1', { lastStatus: 'completed' });
    expect(deps.taskStore.completeTask).toHaveBeenCalledWith('task-42');
  });

  test('does not wait for terminal stop before marking task completed', async () => {
    const task = makeTask({
      id: 'task-42',
      status: 'inProgress',
      sessions: [
        { tmuxSession: 'kookr-s1', lastStatus: 'inProgress' },
      ] as any,
    });
    let resolveStop!: () => void;
    const stop = vi.fn(() => new Promise<void>((resolve) => {
      resolveStop = resolve;
    }));
    const deps = makeLifecycleDeps({
      adapter: { stop },
    });
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    const result = await Promise.race([
      completeTask('task-42', deps).then(() => 'completed'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 10)),
    ]);

    expect(result).toBe('completed');
    expect(stop).toHaveBeenCalledWith('kookr-s1');
    expect(deps.taskStore.updateSession).toHaveBeenCalledWith('task-42', 'kookr-s1', { lastStatus: 'completed' });
    expect(deps.taskStore.completeTask).toHaveBeenCalledWith('task-42');

    resolveStop();
  });

  test('skips cleanup for sessions already in terminal state (completed/aborted)', async () => {
    const task = makeTask({
      id: 'task-42',
      status: 'inProgress',
      sessions: [
        { tmuxSession: 'kookr-done', lastStatus: 'completed' },
        { tmuxSession: 'kookr-dead', lastStatus: 'aborted' },
      ] as any,
    });
    const deps = makeLifecycleDeps();
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await completeTask('task-42', deps);

    // adapter.stop should NOT be called for already-terminal sessions
    expect(deps.adapter.stop).not.toHaveBeenCalled();
    expect(deps.taskStore.updateSession).not.toHaveBeenCalled();
    // But completeTask on the store should still be called
    expect(deps.taskStore.completeTask).toHaveBeenCalledWith('task-42');
  });

  test('logs task_completed to interaction log', async () => {
    const task = makeTask({ id: 'task-42', sessions: [{ tmuxSession: 'kookr-s1', lastStatus: 'inProgress' }] as any });
    const deps = makeLifecycleDeps();
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await completeTask('task-42', deps);

    expect(deps.interactionLog!.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task_completed',
        taskId: 'task-42',
        agentId: 'kookr-s1',
        reason: 'user_marked',
      }),
    );
  });

  test('marks completed sessions with missing worktrees as cleaned_up', async () => {
    const task = makeTask({
      id: 'task-42',
      status: 'inProgress',
      sessions: [
        { tmuxSession: 'kookr-s1', lastStatus: 'inProgress', worktreeHealth: 'missing_unexpectedly' },
      ] as any,
    });
    const deps = makeLifecycleDeps();
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await completeTask('task-42', deps);

    expect(deps.taskStore.updateSessionWorktreeHealth).toHaveBeenCalledWith(
      'task-42',
      'kookr-s1',
      'cleaned_up',
    );
  });

  test('releases worktree leases on completion', async () => {
    const task = makeTask({
      id: 'task-42',
      status: 'inProgress',
      sessions: [
        { tmuxSession: 'kookr-s1', lastStatus: 'inProgress', cwd: '/worktree/a', gitIsWorktree: true },
        { tmuxSession: 'kookr-s2', lastStatus: 'inProgress', cwd: '/worktree/b', gitIsWorktree: true },
        { tmuxSession: 'kookr-s3', lastStatus: 'inProgress', cwd: '/regular', gitIsWorktree: false },
      ] as any,
    });
    const mockRelease = vi.fn().mockReturnValue(true);
    const deps = makeLifecycleDeps({
      leaseService: { release: mockRelease },
    });
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await completeTask('task-42', deps);

    // Should release leases for worktree sessions only
    expect(mockRelease).toHaveBeenCalledWith('/worktree/a', 'task-42');
    expect(mockRelease).toHaveBeenCalledWith('/worktree/b', 'task-42');
    expect(mockRelease).toHaveBeenCalledTimes(2);
  });

  test('completeTask works without leaseService (backward compatible)', async () => {
    const task = makeTask({
      id: 'task-42',
      status: 'inProgress',
      sessions: [{ tmuxSession: 'kookr-s1', lastStatus: 'inProgress', cwd: '/wt', gitIsWorktree: true }] as any,
    });
    const deps = makeLifecycleDeps(); // no leaseService
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    // Should not throw
    await completeTask('task-42', deps);
    expect(deps.taskStore.completeTask).toHaveBeenCalledWith('task-42');
  });
});

describe('cancelTask', () => {
  beforeEach(() => {
    mockCleanupTaskWorktrees.mockReset().mockResolvedValue(undefined);
  });

  test('throws Error when task not found', async () => {
    const deps = makeLifecycleDeps();
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    await expect(cancelTask('nonexistent-id', deps)).rejects.toThrow('Task not found: nonexistent-id');
  });

  test('stops active sessions and marks task cancelled', async () => {
    const task = makeTask({
      id: 'task-42',
      status: 'inProgress',
      sessions: [
        { tmuxSession: 'kookr-s1', lastStatus: 'inProgress' },
      ] as any,
    });
    const deps = makeLifecycleDeps();
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await cancelTask('task-42', deps);

    expect(deps.adapter.stop).toHaveBeenCalledWith('kookr-s1');
    expect(deps.taskStore.updateSession).toHaveBeenCalledWith('task-42', 'kookr-s1', { lastStatus: 'aborted' });
    expect(deps.taskStore.cancelTask).toHaveBeenCalledWith('task-42');
  });

  test('skips cleanup for sessions already in terminal state', async () => {
    const task = makeTask({
      id: 'task-42',
      status: 'inProgress',
      sessions: [
        { tmuxSession: 'kookr-done', lastStatus: 'completed' },
        { tmuxSession: 'kookr-active', lastStatus: 'inProgress' },
      ] as any,
    });
    const deps = makeLifecycleDeps();
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await cancelTask('task-42', deps);

    // Only the active session should be stopped
    expect(deps.adapter.stop).toHaveBeenCalledTimes(1);
    expect(deps.adapter.stop).toHaveBeenCalledWith('kookr-active');
    expect(deps.adapter.stop).not.toHaveBeenCalledWith('kookr-done');
  });

  test('logs task_cancelled to interaction log', async () => {
    const task = makeTask({ id: 'task-42', sessions: [{ tmuxSession: 'kookr-s1', lastStatus: 'inProgress' }] as any });
    const deps = makeLifecycleDeps();
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await cancelTask('task-42', deps);

    expect(deps.interactionLog!.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task_cancelled',
        taskId: 'task-42',
        agentId: 'kookr-s1',
        reason: 'user_cancelled',
      }),
    );
  });

  test('releases worktree leases on cancellation', async () => {
    const task = makeTask({
      id: 'task-42',
      status: 'inProgress',
      sessions: [
        { tmuxSession: 'kookr-s1', lastStatus: 'inProgress', cwd: '/worktree/a', gitIsWorktree: true },
        { tmuxSession: 'kookr-s2', lastStatus: 'inProgress', cwd: '/regular', gitIsWorktree: false },
      ] as any,
    });
    const mockRelease = vi.fn().mockReturnValue(true);
    const deps = makeLifecycleDeps({
      leaseService: { release: mockRelease },
    });
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await cancelTask('task-42', deps);

    expect(mockRelease).toHaveBeenCalledWith('/worktree/a', 'task-42');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});

describe('terminateTask', () => {
  beforeEach(() => {
    mockCleanupTaskWorktrees.mockReset().mockResolvedValue(undefined);
  });

  test('throws Error when task not found', async () => {
    const deps = makeLifecycleDeps();
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    await expect(terminateTask('nonexistent-id', deps)).rejects.toThrow('Task not found: nonexistent-id');
  });

  test('stops active sessions and marks task terminated', async () => {
    const task = makeTask({
      id: 'task-99',
      status: 'inProgress',
      sessions: [
        { tmuxSession: 'kookr-dead', lastStatus: 'idle' },
      ] as any,
    });
    const deps = makeLifecycleDeps();
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await terminateTask('task-99', deps);

    expect(deps.adapter.stop).toHaveBeenCalledWith('kookr-dead');
    expect(deps.monitor.unregisterAgent).toHaveBeenCalledWith('kookr-dead');
    expect(deps.taskStore.updateSession).toHaveBeenCalledWith('task-99', 'kookr-dead', { lastStatus: 'completed' });
    expect(deps.taskStore.terminateTask).toHaveBeenCalledWith('task-99');
  });

  test('logs task_terminated with sessions_died reason', async () => {
    const task = makeTask({
      id: 'task-99',
      sessions: [{ tmuxSession: 'kookr-s1', lastStatus: 'inProgress' }] as any,
    });
    const deps = makeLifecycleDeps();
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await terminateTask('task-99', deps);

    expect(deps.interactionLog!.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task_terminated',
        taskId: 'task-99',
        agentId: 'kookr-s1',
        reason: 'sessions_died',
      }),
    );
  });

  test('releases worktree leases on termination', async () => {
    const task = makeTask({
      id: 'task-99',
      status: 'inProgress',
      sessions: [
        { tmuxSession: 'kookr-s1', lastStatus: 'inProgress', cwd: '/worktree/a', gitIsWorktree: true },
      ] as any,
    });
    const mockRelease = vi.fn().mockReturnValue(true);
    const deps = makeLifecycleDeps({ leaseService: { release: mockRelease } });
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await terminateTask('task-99', deps);

    expect(mockRelease).toHaveBeenCalledWith('/worktree/a', 'task-99');
  });
});

// ---------------------------------------------------------------------------
// promotePendingTasks
// ---------------------------------------------------------------------------

function makePromotionDeps(overrides: Partial<PromotionDeps> = {}): PromotionDeps {
  const adapter = {
    launch: vi.fn().mockResolvedValue('kookr-new-session'),
    agentType: 'claude-code',
  } as any;
  return {
    taskStore: {
      getActiveCount: vi.fn().mockReturnValue(0),
      getNextPending: vi.fn().mockReturnValue(undefined),
      cancelTask: vi.fn(),
      listRelations: vi.fn().mockReturnValue([]),
    } as any,
    adapterRegistry: createAdapterRegistry(adapter),
    lifecycleDeps: makeDeps(),
    broadcastToAll: vi.fn(),
    serverCwd: '/workspace/project',
    ...overrides,
  };
}

function createMockAdapter(taskStore: TaskStore): AgentAdapter {
  let counter = 0;
  return {
    agentType: 'claude-code',
    launch: vi.fn(async (taskId: string, _prompt: string, cwd: string) => {
      const tmuxName = `kookr-test-${++counter}`;
      taskStore.addSession(taskId, {
        tmuxSession: tmuxName,
        agentType: 'claude-code',
        cwd,
        createdAt: new Date(),
      });
      return tmuxName;
    }),
    sendInput: vi.fn(),
    sendKeystroke: vi.fn(),
    stop: vi.fn(),
    captureDisplay: vi.fn(),
    onEvent: vi.fn(),
    onRefreshNeeded: vi.fn(),
    injectHookEvent: vi.fn(),
    getEffectiveHookSettings: vi.fn(() => undefined),
  };
}

function createAdapterRegistry(adapter: AgentAdapter): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(adapter as any);
  return registry;
}

describe('promotePendingTasks', () => {
  beforeEach(() => {
    mockGetProjectId.mockReset();
  });

  test('launches pending task and returns promoted count', async () => {
    const pendingTask = makeTask({ id: 'pending-1', status: 'pending' });
    const mockTaskStore = {
      getActiveCount: vi.fn()
        .mockReturnValueOnce(0)   // first check: below limit
        .mockReturnValueOnce(1),  // after launch: at limit (or no more pending)
      getNextPending: vi.fn()
        .mockReturnValueOnce(pendingTask)
        .mockReturnValueOnce(undefined),
      getTask: vi.fn().mockReturnValue(pendingTask),
      cancelTask: vi.fn(),
      listRelations: vi.fn().mockReturnValue([]),
    };
    const lifecycleDeps = makeDeps();
    (lifecycleDeps.monitor.getSnapshot as any) = vi.fn().mockReturnValue([]);
    const deps = makePromotionDeps({
      taskStore: mockTaskStore as any,
      lifecycleDeps,
    });

    const result = await promotePendingTasks(deps);

    expect(result).toBe(1);
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledWith('pending-1', 'Fix the bug in auth', '/workspace/project');
    expect(deps.broadcastToAll).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'snapshot' }),
    );
  });

  test('passes stored advisory launch note when promoting a pending task', async () => {
    const pendingTask = makeTask({
      id: 'pending-1',
      status: 'pending',
      launchNote: '[Kookr launch warning] KB unavailable.',
    });
    const mockTaskStore = {
      getActiveCount: vi.fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(1),
      getNextPending: vi.fn()
        .mockReturnValueOnce(pendingTask)
        .mockReturnValueOnce(undefined),
      getTask: vi.fn().mockReturnValue(pendingTask),
      cancelTask: vi.fn(),
      listRelations: vi.fn().mockReturnValue([]),
    };
    const lifecycleDeps = makeDeps();
    (lifecycleDeps.monitor.getSnapshot as any) = vi.fn().mockReturnValue([]);
    const deps = makePromotionDeps({
      taskStore: mockTaskStore as any,
      lifecycleDeps,
    });

    const result = await promotePendingTasks(deps);

    expect(result).toBe(1);
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledWith(
      'pending-1',
      '[Kookr launch warning] KB unavailable.\n\nFix the bug in auth',
      '/workspace/project',
    );
  });

  test('returns 0 and does not broadcast when no pending tasks', async () => {
    const deps = makePromotionDeps();

    const result = await promotePendingTasks(deps);

    expect(result).toBe(0);
    expect(deps.adapterRegistry.get('claude-code').launch).not.toHaveBeenCalled();
    expect(deps.broadcastToAll).not.toHaveBeenCalled();
  });

  test('seen set prevents infinite loop when task stays pending after launch', async () => {
    // Simulate a task that stays pending even after launch attempt
    const stuckTask = makeTask({ id: 'stuck-1', status: 'pending' });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockTaskStore = {
      getActiveCount: vi.fn().mockReturnValue(0), // always below limit
      getNextPending: vi.fn().mockReturnValue(stuckTask), // always returns same task
      getTask: vi.fn().mockReturnValue(stuckTask),
      cancelTask: vi.fn(),
      listRelations: vi.fn().mockReturnValue([]),
    };
    const lifecycleDeps = makeDeps();
    (lifecycleDeps.monitor.getSnapshot as any) = vi.fn().mockReturnValue([]);
    const deps = makePromotionDeps({
      taskStore: mockTaskStore as any,
      lifecycleDeps,
    });

    const result = await promotePendingTasks(deps);

    // First iteration: launches successfully (promoted = 1)
    // Second iteration: same task seen again -> cancels and breaks
    expect(result).toBe(1);
    expect(deps.adapterRegistry.get('claude-code').launch).toHaveBeenCalledTimes(1);
    expect(mockTaskStore.cancelTask).toHaveBeenCalledWith('stuck-1');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('still pending after launch'),
    );

    consoleErrorSpy.mockRestore();
  });

  test('launch failure cancels the task instead of crashing', async () => {
    const pendingTask = makeTask({ id: 'fail-1', status: 'pending' });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockTaskStore = {
      getActiveCount: vi.fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(0),
      getNextPending: vi.fn()
        .mockReturnValueOnce(pendingTask)
        .mockReturnValueOnce(undefined),
      getTask: vi.fn().mockReturnValue(pendingTask),
      cancelTask: vi.fn(),
      listRelations: vi.fn().mockReturnValue([]),
    };
    const deps = makePromotionDeps({
      taskStore: mockTaskStore as any,
      adapterRegistry: createAdapterRegistry({
        launch: vi.fn().mockRejectedValue(new Error('terminal backend not available')),
        agentType: 'claude-code',
      } as any),
    });

    // Should NOT throw — error is caught internally
    const result = await promotePendingTasks(deps);

    expect(result).toBe(0);
    expect(mockTaskStore.cancelTask).toHaveBeenCalledWith('fail-1');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to launch pending task fail-1'),
      expect.any(Error),
    );

    consoleErrorSpy.mockRestore();
  });

  test('does not promote when active count is at MAX_ACTIVE_TASKS', async () => {
    const deps = makePromotionDeps({
      taskStore: {
        getActiveCount: vi.fn().mockReturnValue(10), // at limit
        getNextPending: vi.fn(),
        cancelTask: vi.fn(),
      } as any,
    });

    const result = await promotePendingTasks(deps);

    expect(result).toBe(0);
    expect(deps.taskStore.getNextPending).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// promotePendingTasks — integration tests with real TaskStore
// ---------------------------------------------------------------------------

function createPromotionDeps(taskStore: TaskStore, adapter: AgentAdapter): PromotionDeps {
  return {
    taskStore,
    adapterRegistry: createAdapterRegistry(adapter),
    lifecycleDeps: {
      monitor: {
        registerAgent: vi.fn(),
        getSnapshot: vi.fn(() => []),
      } as any,
      watchdog: { registerAgent: vi.fn() } as any,
      hookWatcher: { isWatching: vi.fn(() => false), watch: vi.fn() } as any,
      interactionLog: { append: vi.fn() } as any,
      githubScanner: { isActive: vi.fn(() => false) } as any,
      autoNameTask: vi.fn(),
    },
    broadcastToAll: vi.fn(),
    serverCwd: '/tmp',
  };
}

describe('promotePendingTasks (integration)', () => {
  let taskStore: TaskStore;
  let adapter: AgentAdapter;
  let deps: PromotionDeps;

  beforeEach(() => {
    taskStore = new TaskStore();
    adapter = createMockAdapter(taskStore);
    deps = createPromotionDeps(taskStore, adapter);
  });

  test('respects MAX_ACTIVE_TASKS=2 concurrency limit', async () => {
    const t1 = taskStore.createTask('Task 1', '/cwd');
    const t2 = taskStore.createTask('Task 2', '/cwd');
    const t3 = taskStore.createTask('Task 3', '/cwd');
    taskStore.pendTask(t1.id);
    taskStore.pendTask(t2.id);
    taskStore.pendTask(t3.id);

    const promoted = await promotePendingTasks(deps);

    expect(promoted).toBe(2);
    expect(adapter.launch).toHaveBeenCalledTimes(2);
    expect(taskStore.getTask(t1.id)!.status).toBe('inProgress');
    expect(taskStore.getTask(t2.id)!.status).toBe('inProgress');
    expect(taskStore.getTask(t3.id)!.status).toBe('pending');
    expect(taskStore.getActiveCount()).toBe(2);
    expect(taskStore.getPendingCount()).toBe(1);
  });

  test('promotes remaining task after one completes', async () => {
    const t1 = taskStore.createTask('Task 1', '/cwd');
    const t2 = taskStore.createTask('Task 2', '/cwd');
    const t3 = taskStore.createTask('Task 3', '/cwd');
    taskStore.pendTask(t1.id);
    taskStore.pendTask(t2.id);
    taskStore.pendTask(t3.id);

    await promotePendingTasks(deps);
    expect(taskStore.getTask(t3.id)!.status).toBe('pending');

    // Complete one task — frees a slot
    taskStore.completeTask(t1.id);
    expect(taskStore.getActiveCount()).toBe(1);

    const promoted = await promotePendingTasks(deps);

    expect(promoted).toBe(1);
    expect(taskStore.getTask(t3.id)!.status).toBe('inProgress');
    expect(taskStore.getActiveCount()).toBe(2);
    expect(taskStore.getPendingCount()).toBe(0);
  });

  test('registers the post-launch task snapshot after promotion', async () => {
    const task = taskStore.createTask('Task 1', '/cwd');
    taskStore.pendTask(task.id);

    const promoted = await promotePendingTasks(deps);

    expect(promoted).toBe(1);
    expect(deps.lifecycleDeps.monitor.registerAgent).toHaveBeenCalledWith('kookr-test-1');
    expect(deps.lifecycleDeps.watchdog.registerAgent).toHaveBeenCalledWith('kookr-test-1');
    expect(deps.lifecycleDeps.hookWatcher.watch).toHaveBeenCalledWith('kookr-test-1', { replayExisting: true });
  });

  test('cancels task when adapter.launch fails', async () => {
    const t1 = taskStore.createTask('Task 1', '/cwd');
    taskStore.pendTask(t1.id);

    (adapter.launch as any).mockRejectedValueOnce(new Error('terminal failed'));

    await promotePendingTasks(deps);

    expect(taskStore.getTask(t1.id)!.status).toBe('cancelled');
  });

  test('no-op when no pending tasks', async () => {
    const promoted = await promotePendingTasks(deps);
    expect(promoted).toBe(0);
    expect(adapter.launch).not.toHaveBeenCalled();
  });

  test('no-op when already at capacity', async () => {
    const t1 = taskStore.createTask('Task 1', '/cwd');
    const t2 = taskStore.createTask('Task 2', '/cwd');
    taskStore.startTask(t1.id);
    taskStore.startTask(t2.id);

    const t3 = taskStore.createTask('Task 3', '/cwd');
    taskStore.pendTask(t3.id);

    const promoted = await promotePendingTasks(deps);

    expect(promoted).toBe(0);
    expect(adapter.launch).not.toHaveBeenCalled();
    expect(taskStore.getTask(t3.id)!.status).toBe('pending');
  });
});
