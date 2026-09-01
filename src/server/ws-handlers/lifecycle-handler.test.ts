import { beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../core/tasks.js';
import { Monitor } from '../../core/monitor.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { LifecycleHandler, type LifecycleHandlerDeps } from './lifecycle-handler.js';
import { sharedTaskIdForShare } from '../../shared/contracts/contact-share.js';
import { ReapWarningCoordinator, MAX_REAP_VETOES } from '../../core/reap-warning-coordinator.js';

const mockCleanupTaskWorktrees = vi.fn(async () => undefined);
// `inspectTaskWorktrees` must be stubbed too: the handler's catch-all would
// otherwise turn vitest's "no export defined on the mock" error into a
// well-formed `worktreeCleanupVerdicts` error reply, and a test asserting only
// the message type would pass while exercising nothing but the failure path.
const mockInspectTaskWorktrees = vi.fn(async () => [] as unknown[]);
vi.mock('../../adapters/git-worktree.js', () => ({
  cleanupTaskWorktrees: (...args: unknown[]) => mockCleanupTaskWorktrees(...args),
  inspectTaskWorktrees: (...args: unknown[]) => mockInspectTaskWorktrees(...args),
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
  test('forwards optional effort and model pins from a launch message (#2448)', async () => {
    const launchTask = vi.fn().mockResolvedValue({ task: { id: 't1' }, queued: false });
    const { deps } = makeDeps(new TaskStore(), { launchTask });
    const handler = new LifecycleHandler(deps);

    await handler.handle({
      type: 'launch',
      prompt: 'pin fable',
      cwd: '/tmp',
      agentType: 'claude-code',
      effort: 'max',
      model: 'claude-fable-5',
    });

    expect(launchTask).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'pin fable',
      cwd: '/tmp',
      agentType: 'claude-code',
      effort: 'max',
      model: 'claude-fable-5',
    }));
  });

  test('omits effort and model on launch when the dashboard left them unset (#2448)', async () => {
    const launchTask = vi.fn().mockResolvedValue({ task: { id: 't1' }, queued: false });
    const { deps } = makeDeps(new TaskStore(), { launchTask });
    const handler = new LifecycleHandler(deps);

    await handler.handle({ type: 'launch', prompt: 'plain', cwd: '/tmp' });

    expect(launchTask).toHaveBeenCalledOnce();
    const opts = launchTask.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('effort');
    expect(opts).not.toHaveProperty('model');
  });

  test('forwards the per-task cleanup override to the shared lifecycle', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Keep worktree', '/repo');
    addSession(taskStore, task.id);
    const { deps } = makeDeps(taskStore);
    const handler = new LifecycleHandler(deps);

    await handler.handle({ type: 'completeTask', taskId: task.id, cleanupWorktree: false });

    expect(mockCleanupTaskWorktrees).not.toHaveBeenCalled();
  });

  test('completeTask threads the connection actor into its audit row (issue #1526 Phase B)', async () => {
    const auditDir = await mkdtemp(join(tmpdir(), 'kookr-ws-complete-audit-'));
    const auditLogPath = join(auditDir, 'audit.jsonl');
    try {
      const taskStore = new TaskStore();
      const task = taskStore.createTask('Complete via WS', '/repo');
      addSession(taskStore, task.id);
      const { deps } = makeDeps(taskStore, {
        auditLogPath,
        deletionAuditActor: () => ({ source: 'websocket', actorId: 'conn-1' }),
      });
      const handler = new LifecycleHandler(deps);

      await handler.handle({ type: 'completeTask', taskId: task.id });

      const row = JSON.parse((await readFile(auditLogPath, 'utf-8')).trim()) as { actor: unknown; outcome: string };
      expect(row).toEqual(expect.objectContaining({
        type: 'task.complete',
        actor: { source: 'websocket', actorId: 'conn-1' },
        outcome: 'completed',
      }));
    } finally {
      await rm(auditDir, { recursive: true, force: true });
    }
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

  test('launch forwards disableDedup and keep_as_duplicate intent to launchTask', async () => {
    const taskStore = new TaskStore();
    const launchTask = vi.fn(async () => ({ task: { id: 't1' }, queued: false }));
    const { deps } = makeDeps(taskStore, { launchTask });
    const handler = new LifecycleHandler(deps);

    await handler.handle({
      type: 'launch',
      prompt: 'Fix the auth bug',
      cwd: '/tmp/work',
      agentType: 'claude-code',
      disableDedup: true,
      metadataIntent: 'keep_as_duplicate',
    });

    expect(launchTask).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Fix the auth bug',
      cwd: '/tmp/work',
      agentType: 'claude-code',
      disableDedup: true,
      metadataIntent: 'keep_as_duplicate',
    }));
  });

  test('launch forwards an explicit parentTaskId to launchTask', async () => {
    const taskStore = new TaskStore();
    const original = taskStore.createTask('Original attempt', '/tmp/work');
    const launchTask = vi.fn(async () => ({ task: { id: 't1' }, queued: false }));
    const { deps } = makeDeps(taskStore, { launchTask });
    const handler = new LifecycleHandler(deps);

    await handler.handle({
      type: 'launch',
      prompt: 'Edited retry',
      cwd: '/tmp/edited',
      parentTaskId: original.id,
    });

    expect(launchTask).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Edited retry',
      cwd: '/tmp/edited',
      disableDedup: true,
      parentTaskId: original.id,
      userInitiatedRelaunch: true,
    }));
  });

  test('legacy relaunch forwards the original task as parentTaskId', async () => {
    const taskStore = new TaskStore();
    const original = taskStore.createTask('Original attempt', '/tmp/work');
    const launchTask = vi.fn(async () => ({ task: { id: 't1' }, queued: false }));
    const { deps } = makeDeps(taskStore, { launchTask });
    const handler = new LifecycleHandler(deps);

    await handler.handle({ type: 'relaunch', taskId: original.id, prompt: 'Retry' });

    expect(launchTask).toHaveBeenCalledWith(expect.objectContaining({
      disableDedup: true,
      parentTaskId: original.id,
      userInitiatedRelaunch: true,
    }));
  });
});

describe('worktree:inspectCleanup', () => {
  // The git-worktree mocks are module-level and shared with the suites above,
  // which complete tasks; without a reset, "was never called" assertions here
  // would see their calls.
  beforeEach(() => {
    mockCleanupTaskWorktrees.mockClear();
    mockInspectTaskWorktrees.mockClear();
  });

  const verdict = {
    worktreePath: '/repo-wt',
    worktreeName: 'repo-wt',
    branch: 'feature',
    removable: false,
    blocker: 'uncommitted-changes',
    evidence: { dirty: { modified: 2, added: 0, deleted: 0, renamed: 0, untracked: 1 }, aheadCount: 0 },
    checkedAt: '2026-07-17T00:00:00.000Z',
  };

  test('replies with the verdicts for the task', async () => {
    mockInspectTaskWorktrees.mockResolvedValueOnce([verdict]);
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/repo');
    addSession(taskStore, task.id);
    const { deps } = makeDeps(taskStore);
    const handler = new LifecycleHandler(deps);

    await handler.handle({ type: 'worktree:inspectCleanup', taskId: task.id });

    expect(mockInspectTaskWorktrees).toHaveBeenCalledWith(taskStore, task.id);
    expect(deps.send).toHaveBeenCalledWith({
      type: 'worktreeCleanupVerdicts',
      taskId: task.id,
      verdicts: [verdict],
    });
  });

  test('does not mutate the task', async () => {
    mockInspectTaskWorktrees.mockResolvedValueOnce([verdict]);
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/repo');
    addSession(taskStore, task.id);
    const { deps } = makeDeps(taskStore);
    const handler = new LifecycleHandler(deps);
    // Snapshot AFTER addSession, which itself promotes the task to inProgress.
    const statusBefore = taskStore.getTask(task.id)!.status;

    await handler.handle({ type: 'worktree:inspectCleanup', taskId: task.id });

    expect(taskStore.getTask(task.id)!.status).toBe(statusBefore);
    expect(mockCleanupTaskWorktrees).not.toHaveBeenCalled();
  });

  test('an inspection failure replies with an error rather than rejecting', async () => {
    // Failing to inspect must never block completing a task.
    mockInspectTaskWorktrees.mockRejectedValueOnce(new Error('git exploded'));
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/repo');
    const { deps } = makeDeps(taskStore);
    const handler = new LifecycleHandler(deps);

    await expect(handler.handle({ type: 'worktree:inspectCleanup', taskId: task.id })).resolves.toBeDefined();

    expect(deps.send).toHaveBeenCalledWith({
      type: 'worktreeCleanupVerdicts',
      taskId: task.id,
      verdicts: [],
      error: 'git exploded',
    });
  });

  test('a Contact Share task is answered, not swallowed by the mutation guard', async () => {
    // The guard returns without replying; if it caught this read-only query the
    // dialog would wait forever on a verdict that never arrives.
    mockInspectTaskWorktrees.mockResolvedValueOnce([]);
    const taskStore = new TaskStore();
    const { deps } = makeDeps(taskStore);
    const handler = new LifecycleHandler(deps);
    const sharedTaskId = sharedTaskIdForShare('share-1');

    await handler.handle({ type: 'worktree:inspectCleanup', taskId: sharedTaskId });

    expect(deps.send).toHaveBeenCalledWith({
      type: 'worktreeCleanupVerdicts',
      taskId: sharedTaskId,
      verdicts: [],
    });
    expect(deps.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'alert' }));
  });

  test('a shared task still cannot be completed', async () => {
    // The read-only carve-out must not widen into lifecycle mutations.
    const taskStore = new TaskStore();
    const { deps } = makeDeps(taskStore);
    const handler = new LifecycleHandler(deps);

    await handler.handle({ type: 'completeTask', taskId: sharedTaskIdForShare('share-1') });

    expect(deps.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'alert' }));
    expect(mockInspectTaskWorktrees).not.toHaveBeenCalled();
  });
});

describe('LifecycleHandler keepTaskAlive veto (RFC rfc-reap-grace-warning.md)', () => {
  function warnedTask(coordinator: ReapWarningCoordinator, taskStore: TaskStore, now = 1_000_000) {
    const task = taskStore.createTask('Stalled task', '/repo');
    addSession(taskStore, task.id, 'kookr-veto');
    coordinator.advance({
      taskId: task.id,
      agentId: 'kookr-veto',
      silentForMs: 3 * 3_600_000,
      now,
      graceMs: 120_000,
      present: false,
    });
    return task;
  }

  test('accepted veto extends the deadline, writes an audit row, and does not send an error alert', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reap-veto-'));
    const auditLogPath = join(dir, 'audit.jsonl');
    try {
      const taskStore = new TaskStore();
      const coordinator = new ReapWarningCoordinator();
      const task = warnedTask(coordinator, taskStore);
      const before = coordinator.getWarning(task.id)!.deadlineAt;
      const { deps } = makeDeps(taskStore, { reapWarningCoordinator: coordinator, auditLogPath, broadcastToAll: vi.fn() });
      const handler = new LifecycleHandler(deps);

      await handler.handle({ type: 'keepTaskAlive', taskId: task.id });

      const w = coordinator.getWarning(task.id)!;
      expect(w.keptAliveCount).toBe(1);
      expect(w.deadlineAt).toBeGreaterThan(before);
      expect(deps.send).not.toHaveBeenCalled(); // no error/info alert on success
      expect(await readFile(auditLogPath, 'utf8')).toContain('task.hungTaskReapVetoed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('rejects with a "limit reached" warning alert once the veto cap is hit', async () => {
    const taskStore = new TaskStore();
    const coordinator = new ReapWarningCoordinator();
    const task = warnedTask(coordinator, taskStore);
    for (let i = 0; i < MAX_REAP_VETOES; i++) coordinator.veto(task.id, 1_000_000 + i);
    const { deps } = makeDeps(taskStore, { reapWarningCoordinator: coordinator });
    const handler = new LifecycleHandler(deps);

    await handler.handle({ type: 'keepTaskAlive', taskId: task.id });

    expect(deps.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'alert',
      severity: 'warning',
      summary: expect.stringContaining('limit reached'),
    }));
    expect(coordinator.getWarning(task.id)).toBeDefined(); // left to reap at its deadline
  });

  test('sends a "no pending termination" info alert when there is no warning to veto', async () => {
    const taskStore = new TaskStore();
    const coordinator = new ReapWarningCoordinator();
    const task = taskStore.createTask('Active task', '/repo');
    addSession(taskStore, task.id, 'kookr-nowarn');
    const { deps } = makeDeps(taskStore, { reapWarningCoordinator: coordinator });
    const handler = new LifecycleHandler(deps);

    await handler.handle({ type: 'keepTaskAlive', taskId: task.id });

    expect(deps.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'alert',
      severity: 'info',
      summary: 'No pending termination',
    }));
  });

  test('sends a "no longer active" alert when the task is not inProgress', async () => {
    const taskStore = new TaskStore();
    const coordinator = new ReapWarningCoordinator();
    const task = warnedTask(coordinator, taskStore);
    taskStore.terminateTask(task.id);
    const { deps } = makeDeps(taskStore, { reapWarningCoordinator: coordinator });
    const handler = new LifecycleHandler(deps);

    await handler.handle({ type: 'keepTaskAlive', taskId: task.id });

    expect(deps.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'alert',
      summary: 'Task is no longer active',
    }));
  });

  // issue #2170: the same "Keep it alive" button vetoes the FAA ack-path
  // reaper's coordinator when that is the one holding the warning.
  test('routes the veto to the FAA ack-path coordinator and tags the audit row', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'faa-veto-'));
    const auditLogPath = join(dir, 'audit.jsonl');
    try {
      const taskStore = new TaskStore();
      const hungCoordinator = new ReapWarningCoordinator();
      const faaCoordinator = new ReapWarningCoordinator();
      // Only the FAA coordinator has a warning for this task.
      const task = warnedTask(faaCoordinator, taskStore);
      const before = faaCoordinator.getWarning(task.id)!.deadlineAt;
      const { deps } = makeDeps(taskStore, {
        reapWarningCoordinator: hungCoordinator,
        faaAckReapWarningCoordinator: faaCoordinator,
        auditLogPath,
        broadcastToAll: vi.fn(),
      });
      const handler = new LifecycleHandler(deps);

      await handler.handle({ type: 'keepTaskAlive', taskId: task.id });

      const w = faaCoordinator.getWarning(task.id)!;
      expect(w.keptAliveCount).toBe(1);
      expect(w.deadlineAt).toBeGreaterThan(before);
      expect(hungCoordinator.getWarning(task.id)).toBeUndefined();
      expect(deps.send).not.toHaveBeenCalled();
      const audit = await readFile(auditLogPath, 'utf8');
      expect(audit).toContain('task.finishedAwaitingAckReapVetoed');
      expect(audit).not.toContain('task.hungTaskReapVetoed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
