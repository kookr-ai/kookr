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
import { aSession, aTask } from '../core/__fixtures__/task-builders.js';

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

// Mock removeReflectWorktree (fire-and-forget reflect-worktree reclaim on terminal transitions)
const mockRemoveReflectWorktree = vi.fn().mockResolvedValue(true);
vi.mock('./use-cases/request-task-reflect.js', () => ({
  removeReflectWorktree: (...args: unknown[]) => mockRemoveReflectWorktree(...args),
}));

// Mock nowISO for deterministic timestamps in interaction log assertions
vi.mock('../core/interaction-log.js', () => ({
  nowISO: () => '2026-03-31T00:00:00.000Z',
}));

function lifecycleTask(overrides: Partial<Task> = {}): Task {
  return aTask({
    prompt: 'Fix the bug in auth',
    cwd: '/workspace/project',
    sessions: [aSession({
      tmuxSession: 'kookr-abc123',
      cwd: '/workspace/project',
      createdAt: new Date(),
      lastStatus: 'inProgress',
    })],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
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
    const task = lifecycleTask({
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
    const task = lifecycleTask();
    const deps = makeDeps();

    await registerNewAgent(task, deps);

    expect(deps.watchdog.registerAgent).toHaveBeenCalledWith('kookr-abc123');
  });

  test('starts hook watcher for sessions not already watched', async () => {
    const deps = makeDeps();

    await registerNewAgent(lifecycleTask(), deps);

    expect(deps.hookWatcher.isWatching).toHaveBeenCalledWith('kookr-abc123');
    expect(deps.hookWatcher.watch).toHaveBeenCalledWith('kookr-abc123', { replayExisting: true });
  });

  test('skips hook watcher for sessions already watched', async () => {
    const deps = makeDeps({
      hookWatcher: { isWatching: vi.fn().mockReturnValue(true), watch: vi.fn() } as any,
    });

    await registerNewAgent(lifecycleTask(), deps);

    expect(deps.hookWatcher.watch).not.toHaveBeenCalled();
  });

  test('logs agent_launched to interaction log', async () => {
    const deps = makeDeps();

    await registerNewAgent(lifecycleTask(), deps);

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

    await registerNewAgent(lifecycleTask(), deps);

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

    await registerNewAgent(lifecycleTask(), deps);

    expect(deps.githubScanner.processTaskPrompt).toHaveBeenCalledWith('task-1');
  });

  test('skips GitHub scan when scanner is inactive', async () => {
    const deps = makeDeps();

    await registerNewAgent(lifecycleTask(), deps);

    expect(deps.githubScanner.processTaskPrompt).not.toHaveBeenCalled();
  });

  test('auto-names task when task has no name', async () => {
    const deps = makeDeps();

    await registerNewAgent(lifecycleTask(), deps);

    expect(deps.autoNameTask).toHaveBeenCalledWith('task-1', 'Fix the bug in auth', '/workspace/project', undefined);
  });

  test('passes criteria to autoNameTask', async () => {
    const deps = makeDeps();
    const task = lifecycleTask({ criteria: 'Must pass all tests' });

    await registerNewAgent(task, deps);

    expect(deps.autoNameTask).toHaveBeenCalledWith('task-1', 'Fix the bug in auth', '/workspace/project', 'Must pass all tests');
  });

  test('skips auto-naming when task already has an explicit name (e.g., playbooks)', async () => {
    const deps = makeDeps();
    const task = lifecycleTask({ name: 'My Playbook' });

    await registerNewAgent(task, deps);

    expect(deps.autoNameTask).not.toHaveBeenCalled();
  });

  test('auto-names task carrying the deterministic creation-time placeholder (issue #1554)', async () => {
    const deps = makeDeps();
    // A task named from birth carries `autoNamed`; the LLM namer must still run
    // to upgrade the placeholder.
    const task = lifecycleTask({ name: 'Fix the bug in auth', autoNamed: true });

    await registerNewAgent(task, deps);

    expect(deps.autoNameTask).toHaveBeenCalledWith('task-1', 'Fix the bug in auth', '/workspace/project', undefined);
  });

  test('resolves projectId via getProjectId when taskStore is provided', async () => {
    const mockSetProjectId = vi.fn();
    const deps = makeDeps({
      taskStore: { setProjectId: mockSetProjectId } as any,
    });
    mockGetProjectId.mockResolvedValue('kookr-abc');

    const task = lifecycleTask({ projectId: undefined });
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

    const task = lifecycleTask({ projectId: undefined });
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
    const task = lifecycleTask({ sessions: [] as any });

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

    const task = lifecycleTask({ projectId: undefined, cwd: '/canonical/repo-prod' });
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

    const task = lifecycleTask({ projectId: undefined, cwd: '/missing' });
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

    const task = lifecycleTask({ projectId: undefined });
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
      setCriteriaVerdict: vi.fn(),
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
    const task = lifecycleTask({
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
    expect(mockCleanupTaskWorktrees).toHaveBeenCalledWith(deps.taskStore, 'task-42', deps.interactionLog);
  });

  test('TS-CLEANUP-004: skips task worktree cleanup when the completion override is disabled', async () => {
    const task = lifecycleTask({
      id: 'task-42',
      status: 'inProgress',
      sessions: [{ tmuxSession: 'kookr-s1', lastStatus: 'inProgress' }] as any,
    });
    const deps = makeLifecycleDeps();
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await completeTask('task-42', deps, { cleanupWorktree: false });

    expect(deps.taskStore.completeTask).toHaveBeenCalledWith('task-42');
    expect(deps.adapter.stop).toHaveBeenCalledWith('kookr-s1');
    expect(mockCleanupTaskWorktrees).not.toHaveBeenCalled();
  });

  test('uses the live cleanup setting when no per-task override is supplied', async () => {
    const task = lifecycleTask({
      id: 'task-42',
      status: 'inProgress',
      sessions: [{ tmuxSession: 'kookr-s1', lastStatus: 'inProgress' }] as any,
    });
    const deps = makeLifecycleDeps({ getCleanupWorktreeOnComplete: () => false });
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await completeTask('task-42', deps);

    expect(mockCleanupTaskWorktrees).not.toHaveBeenCalled();
  });

  test('explicitly enables cleanup even when the saved setting is disabled', async () => {
    const task = lifecycleTask({
      id: 'task-42',
      status: 'inProgress',
      sessions: [{ tmuxSession: 'kookr-s1', lastStatus: 'inProgress' }] as any,
    });
    const deps = makeLifecycleDeps({ getCleanupWorktreeOnComplete: () => false });
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await completeTask('task-42', deps, { cleanupWorktree: true });

    expect(mockCleanupTaskWorktrees).toHaveBeenCalledWith(deps.taskStore, 'task-42', deps.interactionLog);
  });

  test('does not wait for terminal stop before marking task completed', async () => {
    const task = lifecycleTask({
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

  test('records unknown criteria verdict when no completion event window exists', async () => {
    const task = lifecycleTask({
      id: 'task-42',
      criteria: 'Open a PR',
      sessions: [
        { tmuxSession: 'kookr-s1', lastStatus: 'inProgress' },
      ] as any,
    });
    const deps = makeLifecycleDeps({
      monitor: {
        unregisterAgent: vi.fn(),
        getAgentEvents: vi.fn().mockReturnValue([]),
      },
    });
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await completeTask('task-42', deps);

    await vi.waitFor(() => {
      expect(deps.taskStore.setCriteriaVerdict).toHaveBeenCalledWith(
        'task-42',
        expect.objectContaining({
          source: 'no-event-window',
          summary: { pass: 0, fail: 0, unknown: 1 },
        }),
      );
    });
  });

  test('skips cleanup for sessions already in terminal state (completed/aborted)', async () => {
    const task = lifecycleTask({
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
    const task = lifecycleTask({ id: 'task-42', sessions: [{ tmuxSession: 'kookr-s1', lastStatus: 'inProgress' }] as any });
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
    const task = lifecycleTask({
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
    const task = lifecycleTask({
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
    const task = lifecycleTask({
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

  test('task close still routes a primary-checkout session through guarded cleanup', async () => {
    const task = lifecycleTask({
      id: 'task-primary',
      status: 'inProgress',
      sessions: [{
        tmuxSession: 'kookr-primary',
        lastStatus: 'inProgress',
        cwd: '/repo',
        gitIsWorktree: true,
        gitBranch: 'main',
      }] as any,
    });
    const deps = makeLifecycleDeps();
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await completeTask('task-primary', deps);
    await vi.waitFor(() => {
      expect(mockCleanupTaskWorktrees).toHaveBeenCalledWith(
        deps.taskStore,
        'task-primary',
        deps.interactionLog,
      );
    });
  });

  test('notifies task outcome as completed', async () => {
    const task = lifecycleTask({ id: 'task-42' });
    const onTaskOutcome = vi.fn();
    const deps = makeLifecycleDeps({ onTaskOutcome });
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await completeTask('task-42', deps);

    expect(onTaskOutcome).toHaveBeenCalledWith('task-42', { kind: 'completed' });
  });

  test('swallows task outcome callback errors on completion', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const task = lifecycleTask({ id: 'task-42' });
    const deps = makeLifecycleDeps({
      onTaskOutcome: vi.fn(() => { throw new Error('telegram down'); }),
    });
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await expect(completeTask('task-42', deps)).resolves.toBeUndefined();
    expect(deps.taskStore.completeTask).toHaveBeenCalledWith('task-42');

    warn.mockRestore();
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
    const task = lifecycleTask({
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
    const task = lifecycleTask({
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
    const task = lifecycleTask({ id: 'task-42', sessions: [{ tmuxSession: 'kookr-s1', lastStatus: 'inProgress' }] as any });
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
    const task = lifecycleTask({
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

  test('notifies task outcome as cancelled', async () => {
    const task = lifecycleTask({ id: 'task-42' });
    const onTaskOutcome = vi.fn();
    const deps = makeLifecycleDeps({ onTaskOutcome });
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await cancelTask('task-42', deps);

    expect(onTaskOutcome).toHaveBeenCalledWith('task-42', { kind: 'cancelled' });
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
    const task = lifecycleTask({
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
    expect(deps.taskStore.terminateTask).toHaveBeenCalledWith('task-99', undefined);
  });

  test('logs task_terminated with sessions_died reason', async () => {
    const task = lifecycleTask({
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
    const task = lifecycleTask({
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

  test('notifies task outcome as failed', async () => {
    const task = lifecycleTask({
      id: 'task-99',
      status: 'inProgress',
      sessions: [{ tmuxSession: 'kookr-s1', lastStatus: 'inProgress' }] as any,
    });
    const onTaskOutcome = vi.fn();
    const deps = makeLifecycleDeps({ onTaskOutcome });
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await terminateTask('task-99', deps);

    expect(onTaskOutcome).toHaveBeenCalledWith('task-99', { kind: 'failed' });
  });

  test('unregisters all token-tracker transcripts for the task (issue #1620 change d)', async () => {
    const task = lifecycleTask({
      id: 'task-99',
      status: 'inProgress',
      sessions: [{ tmuxSession: 'kookr-s1', lastStatus: 'inProgress' }] as any,
    });
    const unregisterTask = vi.fn();
    const deps = makeLifecycleDeps({ tokenTracker: { unregister: vi.fn(), unregisterTask } });
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await terminateTask('task-99', deps);

    expect(unregisterTask).toHaveBeenCalledWith('task-99');
  });
});

describe('terminal transitions unregister token transcripts (issue #1620 change d)', () => {
  test('cancelTask drops every transcript for the task (incl. subagent sidechains)', async () => {
    const task = lifecycleTask({
      id: 'task-77',
      status: 'inProgress',
      sessions: [{ tmuxSession: 'kookr-s1', lastStatus: 'inProgress' }] as any,
    });
    const unregisterTask = vi.fn();
    const deps = makeLifecycleDeps({ tokenTracker: { unregister: vi.fn(), unregisterTask } });
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await cancelTask('task-77', deps);

    expect(unregisterTask).toHaveBeenCalledWith('task-77');
  });

  test('completeTask drops every transcript for the task', async () => {
    const task = lifecycleTask({
      id: 'task-88',
      status: 'inProgress',
      sessions: [{ tmuxSession: 'kookr-s1', lastStatus: 'inProgress' }] as any,
    });
    const unregisterTask = vi.fn();
    const deps = makeLifecycleDeps({ tokenTracker: { unregister: vi.fn(), unregisterTask } });
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);

    await completeTask('task-88', deps);

    expect(unregisterTask).toHaveBeenCalledWith('task-88');
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
      beginLaunch: vi.fn().mockReturnValue(true),
      endLaunch: vi.fn(),
      listRelations: vi.fn().mockReturnValue([]),
      setLaunchPermissionPosture: vi.fn(),
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
    const pendingTask = lifecycleTask({ id: 'pending-1', status: 'pending' });
    const mockTaskStore = {
      getActiveCount: vi.fn()
        .mockReturnValueOnce(0)   // first check: below limit
        .mockReturnValueOnce(1),  // after launch: at limit (or no more pending)
      getNextPending: vi.fn()
        .mockReturnValueOnce(pendingTask)
        .mockReturnValueOnce(undefined),
      // Second iteration has one free slot left (MAX=2, active=1), so the
      // posture-guard pick reads the pending list directly (issue #1526 C3).
      listTasks: vi.fn().mockReturnValue([]),
      hasFreshLaunchReservation: vi.fn().mockReturnValue(false),
      getTask: vi.fn().mockReturnValue(pendingTask),
      cancelTask: vi.fn(),
      beginLaunch: vi.fn().mockReturnValue(true),
      endLaunch: vi.fn(),
      listRelations: vi.fn().mockReturnValue([]),
      setLaunchPermissionPosture: vi.fn(),
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
    expect(mockTaskStore.setLaunchPermissionPosture).toHaveBeenCalledWith('pending-1', undefined);
    expect(deps.broadcastToAll).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'snapshot' }),
    );
  });

  test('passes stored advisory launch note when promoting a pending task', async () => {
    const pendingTask = lifecycleTask({
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
      // See note above — last-free-slot iteration uses the posture-guard pick.
      listTasks: vi.fn().mockReturnValue([]),
      hasFreshLaunchReservation: vi.fn().mockReturnValue(false),
      getTask: vi.fn().mockReturnValue(pendingTask),
      cancelTask: vi.fn(),
      beginLaunch: vi.fn().mockReturnValue(true),
      endLaunch: vi.fn(),
      listRelations: vi.fn().mockReturnValue([]),
      setLaunchPermissionPosture: vi.fn(),
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
    const stuckTask = lifecycleTask({ id: 'stuck-1', status: 'pending' });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mockTaskStore = {
      getActiveCount: vi.fn().mockReturnValue(0), // always below limit
      getNextPending: vi.fn().mockReturnValue(stuckTask), // always returns same task
      getTask: vi.fn().mockReturnValue(stuckTask),
      cancelTask: vi.fn(),
      beginLaunch: vi.fn().mockReturnValue(true),
      endLaunch: vi.fn(),
      listRelations: vi.fn().mockReturnValue([]),
      setLaunchPermissionPosture: vi.fn(),
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
    const pendingTask = lifecycleTask({ id: 'fail-1', status: 'pending' });
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
      beginLaunch: vi.fn().mockReturnValue(true),
      endLaunch: vi.fn(),
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
    // Mutation guard: deleting the promote-loop's finally{endLaunch} must fail here.
    expect(mockTaskStore.endLaunch).toHaveBeenCalledWith('fail-1');
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

  test('records permission posture for a pending task at promotion time', async () => {
    const interactionLog = { append: vi.fn().mockResolvedValue(undefined) } as any;
    deps = {
      ...deps,
      bypassAllPermissions: true,
      lifecycleDeps: {
        ...deps.lifecycleDeps,
        interactionLog,
      },
    };
    const task = taskStore.createTask('Task 1', '/cwd');
    taskStore.pendTask(task.id);

    const promoted = await promotePendingTasks(deps);

    expect(promoted).toBe(1);
    expect(taskStore.getTask(task.id)?.metadata?.launchPermissionPosture).toMatchObject({
      bypassAllPermissions: true,
      mode: 'bypass-all',
    });
    expect(interactionLog.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'task_launch_permission_posture',
      taskId: task.id,
      agentType: 'claude-code',
      bypassAllPermissions: true,
      mode: 'bypass-all',
    }));
  });

  test('clears stale permission posture when a pending task promotes in guarded mode', async () => {
    const task = taskStore.createTask({
      prompt: 'Task 1',
      cwd: '/cwd',
      metadata: {
        launchPermissionPosture: {
          bypassAllPermissions: true,
          mode: 'bypass-all',
          capturedAt: '2026-06-11T08:00:00.000Z',
        },
      },
    });
    taskStore.pendTask(task.id);

    const promoted = await promotePendingTasks({ ...deps, bypassAllPermissions: false });

    expect(promoted).toBe(1);
    expect(taskStore.getTask(task.id)?.metadata?.launchPermissionPosture).toBeUndefined();
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

// ---------------------------------------------------------------------------
// Promotion posture guard (issue #1526 Phase C / C3, FM11 anti-re-wedge)
// MAX_ACTIVE_TASKS is mocked to 2 for this file.
// ---------------------------------------------------------------------------

describe('promotePendingTasks posture guard (issue #1526 C3 / FM11)', () => {
  let taskStore: TaskStore;
  let adapter: AgentAdapter;
  let deps: PromotionDeps;

  beforeEach(() => {
    taskStore = new TaskStore();
    adapter = createMockAdapter(taskStore);
    deps = createPromotionDeps(taskStore, adapter);
  });

  /** Pend a task and force a distinct, ordered createdAt (FIFO key). */
  function seedPending(
    prompt: string,
    ageMs: number,
    opts: { autoCloseOnSignal?: boolean; scheduleFired?: boolean } = {},
  ): string {
    const task = taskStore.createTask({
      prompt,
      cwd: '/cwd',
      autoCloseOnSignal: opts.autoCloseOnSignal,
      metadata: opts.scheduleFired ? { launchSource: 'schedule' } : undefined,
    });
    taskStore.pendTask(task.id);
    const mutable = taskStore.getTaskForMutation(task.id)!;
    mutable.createdAt = new Date(Date.now() - ageMs);
    return task.id;
  }

  test('last free slot prefers an autoCloseOnSignal pending over an OLDER ask-first pending', async () => {
    // One of two slots occupied → the promotion fills the LAST slot.
    const active = taskStore.createTask('Active', '/cwd');
    taskStore.startTask(active.id);

    const askFirstId = seedPending('ask-first, older', 60_000);
    const autoCloseId = seedPending('self-releasing, newer', 30_000, { autoCloseOnSignal: true });

    const promoted = await promotePendingTasks(deps);

    expect(promoted).toBe(1);
    expect(taskStore.getTask(autoCloseId)!.status).toBe('inProgress');
    expect(taskStore.getTask(askFirstId)!.status).toBe('pending');
  });

  test('last free slot prefers a schedule-fired pending (metadata.launchSource) over an older ask-first pending', async () => {
    const active = taskStore.createTask('Active', '/cwd');
    taskStore.startTask(active.id);

    const askFirstId = seedPending('ask-first, older', 60_000);
    const scheduleId = seedPending('schedule fire, newer', 30_000, { scheduleFired: true });

    const promoted = await promotePendingTasks(deps);

    expect(promoted).toBe(1);
    expect(taskStore.getTask(scheduleId)!.status).toBe('inProgress');
    expect(taskStore.getTask(askFirstId)!.status).toBe('pending');
  });

  test('no starvation: when only ask-first pendings exist, the oldest still fills the last slot', async () => {
    const active = taskStore.createTask('Active', '/cwd');
    taskStore.startTask(active.id);

    const olderId = seedPending('ask-first older', 60_000);
    const newerId = seedPending('ask-first newer', 30_000);

    const promoted = await promotePendingTasks(deps);

    expect(promoted).toBe(1);
    expect(taskStore.getTask(olderId)!.status).toBe('inProgress');
    expect(taskStore.getTask(newerId)!.status).toBe('pending');
  });

  test('multi-slot promotion stays FIFO until the last slot (ordering preference only)', async () => {
    // Both slots free. Oldest is ask-first: with >1 free slot the pick is
    // plain FIFO, so the ask-first task promotes FIRST — the preference only
    // applies to the final slot.
    const askFirstId = seedPending('ask-first oldest', 90_000);
    const autoCloseId = seedPending('self-releasing newer', 30_000, { autoCloseOnSignal: true });

    const promoted = await promotePendingTasks(deps);

    expect(promoted).toBe(2);
    const launchOrder = vi.mocked(adapter.launch).mock.calls.map(([taskId]) => taskId);
    expect(launchOrder).toEqual([askFirstId, autoCloseId]);
    expect(taskStore.getTask(askFirstId)!.status).toBe('inProgress');
    expect(taskStore.getTask(autoCloseId)!.status).toBe('inProgress');
  });

  test('ties within the self-releasing class stay FIFO (oldest self-releasing wins the last slot)', async () => {
    const active = taskStore.createTask('Active', '/cwd');
    taskStore.startTask(active.id);

    seedPending('ask-first oldest', 90_000);
    const olderAutoId = seedPending('self-releasing older', 60_000, { autoCloseOnSignal: true });
    const newerAutoId = seedPending('self-releasing newer', 30_000, { autoCloseOnSignal: true });

    const promoted = await promotePendingTasks(deps);

    expect(promoted).toBe(1);
    expect(taskStore.getTask(olderAutoId)!.status).toBe('inProgress');
    expect(taskStore.getTask(newerAutoId)!.status).toBe('pending');
  });
});

describe('reflect worktree cleanup on terminal transition', () => {
  const WT = '/tmp/reflect-worktrees/wt-1';

  beforeEach(() => {
    mockRemoveReflectWorktree.mockClear().mockResolvedValue(true);
    mockCleanupTaskWorktrees.mockReset().mockResolvedValue(undefined);
  });

  function depsFor(task: Task): LifecycleDeps {
    const deps = makeLifecycleDeps();
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);
    return deps;
  }

  function reflectTask(id: string): Task {
    return lifecycleTask({
      id,
      status: 'inProgress',
      sessions: [{ tmuxSession: `kookr-${id}`, lastStatus: 'inProgress' }] as any,
      reflectMeta: {
        sourceTaskId: '11111111-2222-3333-4444-555555555555',
        bundlePath: '/tmp/bundle',
        direction: 'down',
        worktreePath: WT,
      },
    });
  }

  test('completeTask reclaims the reflect worktree', async () => {
    await completeTask('rt-c', depsFor(reflectTask('rt-c')));
    expect(mockRemoveReflectWorktree).toHaveBeenCalledWith(WT);
  });

  test('cancelTask reclaims the reflect worktree', async () => {
    await cancelTask('rt-x', depsFor(reflectTask('rt-x')));
    expect(mockRemoveReflectWorktree).toHaveBeenCalledWith(WT);
  });

  test('terminateTask reclaims the reflect worktree', async () => {
    await terminateTask('rt-t', depsFor(reflectTask('rt-t')));
    expect(mockRemoveReflectWorktree).toHaveBeenCalledWith(WT);
  });

  test('non-reflect task does not trigger reflect-worktree removal', async () => {
    const task = lifecycleTask({
      id: 'plain',
      status: 'inProgress',
      sessions: [{ tmuxSession: 'kookr-plain', lastStatus: 'inProgress' }] as any,
    });
    await completeTask('plain', depsFor(task));
    expect(mockRemoveReflectWorktree).not.toHaveBeenCalled();
  });

  test('legacy reflect task without a stored worktreePath is not removed (falls back to sweep)', async () => {
    const task = lifecycleTask({
      id: 'legacy',
      status: 'inProgress',
      sessions: [{ tmuxSession: 'kookr-legacy', lastStatus: 'inProgress' }] as any,
      reflectMeta: {
        sourceTaskId: '11111111-2222-3333-4444-555555555555',
        bundlePath: '/tmp/bundle',
        direction: 'up',
        // worktreePath intentionally absent — persisted before the field existed.
      },
    });
    await completeTask('legacy', depsFor(task));
    expect(mockRemoveReflectWorktree).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Issue-claim release wiring (RFC rfc-issue-ownership-lock R8/R9b)
// ---------------------------------------------------------------------------

describe('issue-claim release on terminal transitions', () => {
  function makeClaimDeps(task: Task) {
    const safeReleaseAllFor = vi.fn(() => [] as Array<{ repo: string; number: number }>);
    const deps = makeLifecycleDeps({ issueClaimRegistry: { safeReleaseAllFor } });
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);
    return { deps, safeReleaseAllFor };
  }

  beforeEach(() => {
    mockCleanupTaskWorktrees.mockReset().mockResolvedValue(undefined);
  });

  test('completeTask releases claims with reason "released"', async () => {
    const task = lifecycleTask({ id: 'task-claim-1', status: 'inProgress', sessions: [] });
    const { deps, safeReleaseAllFor } = makeClaimDeps(task);
    await completeTask('task-claim-1', deps);
    expect(safeReleaseAllFor).toHaveBeenCalledWith('task-claim-1', 'released');
  });

  test('cancelTask releases claims with reason "released"', async () => {
    const task = lifecycleTask({ id: 'task-claim-2', status: 'inProgress', sessions: [] });
    const { deps, safeReleaseAllFor } = makeClaimDeps(task);
    await cancelTask('task-claim-2', deps);
    expect(safeReleaseAllFor).toHaveBeenCalledWith('task-claim-2', 'released');
  });

  test('terminateTask releases claims with reason "dead_reclaim" (confirmed-dead, R12)', async () => {
    const task = lifecycleTask({ id: 'task-claim-3', status: 'inProgress', sessions: [] });
    const { deps, safeReleaseAllFor } = makeClaimDeps(task);
    await terminateTask('task-claim-3', deps);
    expect(safeReleaseAllFor).toHaveBeenCalledWith('task-claim-3', 'dead_reclaim');
  });

  test('wrappers tolerate an absent registry (flag off)', async () => {
    const task = lifecycleTask({ id: 'task-claim-4', status: 'inProgress', sessions: [] });
    const deps = makeLifecycleDeps();
    (deps.taskStore.getTask as ReturnType<typeof vi.fn>).mockReturnValue(task);
    await expect(completeTask('task-claim-4', deps)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #700 regression: concurrent promoters must not double-launch one pending task
// (docs/reports/issue-700-multi-session-attach-audit.md)
// ---------------------------------------------------------------------------

describe('promotePendingTasks launch reservation (#700)', () => {
  beforeEach(() => {
    // registerNewAgent fire-and-forgets getProjectId(cwd).then(...) — the
    // module mock must return a promise or the promotion catch swallows a
    // TypeError and cancels the task.
    mockGetProjectId.mockReset().mockResolvedValue('github.com/kookr-ai/kookr');
  });

  function slowAdapter(taskStore: TaskStore, launchedIds: string[], gate: Promise<void>): AgentAdapter {
    let counter = 0;
    return {
      agentType: 'claude-code',
      launch: vi.fn(async (taskId: string, _prompt: string, cwd: string) => {
        launchedIds.push(taskId);
        await gate; // hold the launch mid-await, like a real adapter spawning a session
        const tmuxName = `kookr-race-${++counter}`;
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

  test('two concurrent promoters, one pending task → exactly one launch', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('implement issue #700', '/repo');
    taskStore.pendTask(task.id);

    const launchedIds: string[] = [];
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const adapter = slowAdapter(taskStore, launchedIds, gate);

    const lifecycleDeps = makeDeps({ taskStore });
    (lifecycleDeps.monitor.getSnapshot as any) = vi.fn().mockReturnValue([]);
    const deps = makePromotionDeps({
      taskStore,
      adapterRegistry: createAdapterRegistry(adapter),
      lifecycleDeps,
    });

    // Both promoters run concurrently: the 5s liveness tick + a
    // completion-triggered promotion, exactly the #700 topology. Each picks
    // while the other's launch is parked mid-await on the gate.
    const race = Promise.all([promotePendingTasks(deps), promotePendingTasks(deps)]);
    // Let both promoters reach their pick/reserve before releasing launches.
    await new Promise((resolve) => setTimeout(resolve, 0));
    openGate();
    const [a, b] = await race;

    expect(launchedIds).toEqual([task.id]); // ONE launch, not two
    expect(a + b).toBe(1);
    expect(taskStore.getTask(task.id)!.sessions).toHaveLength(1);
    expect(taskStore.getTask(task.id)!.status).toBe('inProgress');
  });

  test('reservation holds the concurrency slot while a launch is mid-await', async () => {
    const taskStore = new TaskStore();
    const first = taskStore.createTask('first pending', '/repo');
    const second = taskStore.createTask('second pending', '/repo');
    taskStore.pendTask(first.id);
    taskStore.pendTask(second.id);

    const launchedIds: string[] = [];
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const adapter = slowAdapter(taskStore, launchedIds, gate);

    const lifecycleDeps = makeDeps({ taskStore });
    (lifecycleDeps.monitor.getSnapshot as any) = vi.fn().mockReturnValue([]);
    const deps = makePromotionDeps({
      taskStore,
      adapterRegistry: createAdapterRegistry(adapter),
      lifecycleDeps,
      getMaxActiveTasks: () => 1, // cap 1: the in-flight launch must consume the slot
    });

    const race = Promise.all([promotePendingTasks(deps), promotePendingTasks(deps)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    openGate();
    await race;

    // Cap is 1: only the first task may launch this sweep, even though the
    // old inProgress-only getActiveCount would have let the second promoter
    // over-launch while the first launch was mid-await.
    expect(launchedIds).toEqual([first.id]);
    expect(taskStore.getTask(second.id)!.status).toBe('pending');
  });

  test('failed launch releases the reservation so the task is not stranded', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('will fail', '/repo');
    taskStore.pendTask(task.id);

    const adapter = {
      agentType: 'claude-code',
      launch: vi.fn().mockRejectedValue(new Error('boom')),
      sendInput: vi.fn(), sendKeystroke: vi.fn(), stop: vi.fn(), captureDisplay: vi.fn(),
      onEvent: vi.fn(), onRefreshNeeded: vi.fn(), injectHookEvent: vi.fn(),
      getEffectiveHookSettings: vi.fn(() => undefined),
    } as unknown as AgentAdapter;

    const lifecycleDeps = makeDeps({ taskStore });
    (lifecycleDeps.monitor.getSnapshot as any) = vi.fn().mockReturnValue([]);
    const deps = makePromotionDeps({ taskStore, adapterRegistry: createAdapterRegistry(adapter), lifecycleDeps });

    await promotePendingTasks(deps);

    // Launch failed → task cancelled (existing behavior) and the reservation
    // no longer occupies a slot.
    expect(taskStore.getTask(task.id)!.status).toBe('cancelled');
    expect(taskStore.getActiveCount()).toBe(0);
  });
});
