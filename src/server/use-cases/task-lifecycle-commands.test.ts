import { describe, expect, test, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../core/tasks.js';
import { Monitor } from '../../core/monitor.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { TaskLifecycleCommands, type TaskLifecycleCommandDeps } from './task-lifecycle-commands.js';

const mockBuildTaskCompletionMetadata = vi.fn();
vi.mock('../completion-metadata.js', () => ({
  buildTaskCompletionMetadata: (...args: unknown[]) => mockBuildTaskCompletionMetadata(...args),
}));

vi.mock('../../adapters/git-worktree.js', () => ({
  cleanupTaskWorktrees: vi.fn(async () => undefined),
}));

function makeDeps(taskStore: TaskStore, overrides: Partial<TaskLifecycleCommandDeps> = {}) {
  const queue = new AttentionQueue();
  const monitor = new Monitor(taskStore, queue);
  const stop = vi.fn(async () => undefined);
  const interactionLog = { append: vi.fn(async () => undefined) } as never;
  const deps: TaskLifecycleCommandDeps = {
    taskStore,
    monitor,
    interactionLog,
    scheduleService: { recordTaskTerminalOutcome: vi.fn(async () => undefined) },
    ralphLoopService: { cancelLoop: vi.fn(() => ({ ok: true, value: 'cancelled', changed: true })) } as never,
    broadcastToAll: vi.fn(),
    getLifecycleDeps: () => ({
      adapter: { stop },
      monitor,
      taskStore,
      hookWatcher: { stop: vi.fn() },
      watchdog: { unregisterAgent: vi.fn() },
      interactionLog,
    } as never),
    tryPromotePending: vi.fn(async () => undefined),
    ...overrides,
  };
  return { deps, monitor, stop };
}

function addSession(taskStore: TaskStore, taskId: string, tmuxSession = 'kookr-session'): void {
  taskStore.addSession(taskId, {
    tmuxSession,
    agentType: 'claude-code',
    cwd: '/repo-wt',
    createdAt: new Date(),
  });
}

async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, 'utf-8');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

describe('TaskLifecycleCommands.completeTask', () => {
  beforeEach(() => {
    mockBuildTaskCompletionMetadata.mockReset().mockResolvedValue({
      digest: { bullets: ['shipped fix', 'updated tests'], filesChanged: [] },
      taskTokenUsage: undefined,
    });
  });

  test('treats active Ralph completion as partial session completion', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Run Ralph loop', '/repo');
    addSession(taskStore, task.id);
    taskStore.getTaskForMutation(task.id)!.ralphLoop = { status: 'running', iteration: 2 } as never;
    taskStore.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-06-05T12:00:00.000Z' });
    const { deps, stop } = makeDeps(taskStore);

    const result = await new TaskLifecycleCommands(deps).completeTask(task.id);

    expect(result.outcome).toBe('partial_ralph_completion');
    expect(taskStore.getTask(task.id)?.status).toBe('inProgress');
    expect(taskStore.getTask(task.id)?.sessions[0].lastStatus).toBe('completed');
    expect(stop).toHaveBeenCalledWith('kookr-session');
    expect(taskStore.getPendingSignal(task.id)?.kind).toBe('completion_ready');
    expect(deps.scheduleService?.recordTaskTerminalOutcome).not.toHaveBeenCalled();
    expect(deps.tryPromotePending).not.toHaveBeenCalled();
  });

  test('finalizes completion digest from captured monitor events', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Implement lifecycle service', '/repo');
    addSession(taskStore, task.id);
    taskStore.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-06-05T12:00:00.000Z' });
    const { deps, monitor } = makeDeps(taskStore);
    vi.spyOn(monitor, 'getAgentEvents').mockReturnValue([
      { type: 'tool_use', sessionId: 'claude-session', toolName: 'Edit' },
    ]);

    const result = await new TaskLifecycleCommands(deps).completeTask(task.id);

    expect(result.outcome).toBe('completed');
    await vi.waitFor(() => {
      expect(taskStore.getTask(task.id)?.completionDigest).toEqual({
        bullets: ['shipped fix', 'updated tests'],
        filesChanged: [],
      });
    });
    expect(mockBuildTaskCompletionMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id }),
      [expect.objectContaining({ type: 'tool_use' })],
    );
    expect(deps.scheduleService?.recordTaskTerminalOutcome).toHaveBeenCalledWith(task.id, 'completed');
    expect(deps.tryPromotePending).toHaveBeenCalledOnce();
    expect(taskStore.getPendingSignal(task.id)).toBeUndefined();
  });
});

describe('TaskLifecycleCommands.cancelTask', () => {
  test('cancels Ralph loop before terminal lifecycle cancellation', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Cancel loop', '/repo');
    addSession(taskStore, task.id);
    taskStore.getTaskForMutation(task.id)!.ralphLoop = { status: 'running', iteration: 1 } as never;
    taskStore.setPendingSignal(task.id, { kind: 'completion_ready', raisedAt: '2026-06-05T12:00:00.000Z' });
    const order: string[] = [];
    const { deps } = makeDeps(taskStore, {
      ralphLoopService: {
        cancelLoop: vi.fn((loopTask) => {
          order.push('cancelLoop');
          taskStore.getTaskForMutation(loopTask.id)!.ralphLoop!.status = 'cancelled';
          return { ok: true, value: 'cancelled', changed: true };
        }),
      } as never,
    });
    const originalGetLifecycleDeps = deps.getLifecycleDeps;
    deps.getLifecycleDeps = () => ({
      ...originalGetLifecycleDeps(),
      adapter: {
        stop: vi.fn(async () => {
          order.push('stop');
          expect(taskStore.getTask(task.id)?.ralphLoop?.status).toBe('cancelled');
        }),
      },
    } as never);

    const result = await new TaskLifecycleCommands(deps).cancelTask(task.id);

    expect(result.outcome).toBe('cancelled');
    expect(order).toEqual(['cancelLoop', 'stop']);
    expect(taskStore.getTask(task.id)?.status).toBe('cancelled');
    expect(taskStore.getPendingSignal(task.id)).toBeUndefined();
    expect(deps.scheduleService?.recordTaskTerminalOutcome).toHaveBeenCalledWith(task.id, 'cancelled');
  });
});

describe('TaskLifecycleCommands.deleteTask', () => {
  test('writes a structured audit row with actor, scope, count, and id', async () => {
    const auditDir = await mkdtemp(join(tmpdir(), 'kookr-delete-audit-'));
    const auditLogPath = join(auditDir, 'audit.jsonl');
    try {
      const taskStore = new TaskStore();
      const task = taskStore.createTask({ prompt: 'Delete me', cwd: '/repo', projectId: 'github.com/org/repo' });
      const { deps } = makeDeps(taskStore, { auditLogPath });

      const result = await new TaskLifecycleCommands(deps).deleteTask(task.id, {
        actor: { source: 'api' },
      });

      expect(result.outcome).toBe('deleted');
      expect(await readJsonl(auditLogPath)).toEqual([
        expect.objectContaining({
          type: 'task.deleteTask',
          actor: { source: 'api' },
          scope: { kind: 'project', projectId: 'github.com/org/repo' },
          count: 1,
          deletedTaskIds: [task.id],
          taskId: task.id,
          outcome: 'deleted',
        }),
      ]);
    } finally {
      await rm(auditDir, { recursive: true, force: true });
    }
  });
});

describe('TaskLifecycleCommands.clearFinishedTasks', () => {
  test('takes one predelete snapshot and deletes finished tasks only', async () => {
    const taskStore = new TaskStore();
    const completed = taskStore.createTask('Done', '/repo');
    addSession(taskStore, completed.id, 'kookr-done');
    taskStore.completeTask(completed.id);
    const cancelled = taskStore.createTask('Cancelled', '/repo');
    addSession(taskStore, cancelled.id, 'kookr-cancelled');
    taskStore.cancelTask(cancelled.id);
    const active = taskStore.createTask('Still running', '/repo');
    addSession(taskStore, active.id, 'kookr-active');
    const takePredeleteSnapshot = vi.fn(async () => undefined);
    const { deps, stop } = makeDeps(taskStore, { takePredeleteSnapshot });

    const result = await new TaskLifecycleCommands(deps).clearFinishedTasks();

    expect(result).toMatchObject({
      outcome: 'cleared',
      deletedTaskIds: expect.arrayContaining([completed.id, cancelled.id]),
    });
    expect(takePredeleteSnapshot).toHaveBeenCalledOnce();
    expect(taskStore.getTask(completed.id)).toBeUndefined();
    expect(taskStore.getTask(cancelled.id)).toBeUndefined();
    expect(taskStore.getTask(active.id)?.status).toBe('inProgress');
    expect(stop).not.toHaveBeenCalled();
  });

  test('deletes finished tasks only within the requested project scope', async () => {
    const taskStore = new TaskStore();
    const projectADone = taskStore.createTask({ prompt: 'A done', cwd: '/repo-a', projectId: 'github.com/org/a' });
    const projectBDone = taskStore.createTask({ prompt: 'B done', cwd: '/repo-b', projectId: 'github.com/org/b' });
    const projectATerminated = taskStore.createTask({ prompt: 'A terminated', cwd: '/repo-a', projectId: 'github.com/org/a' });
    const unscopedDone = taskStore.createTask('Unscoped done', '/repo/none');
    const projectAActive = taskStore.createTask({ prompt: 'A active', cwd: '/repo-a', projectId: 'github.com/org/a' });
    taskStore.startTask(projectADone.id);
    taskStore.completeTask(projectADone.id);
    taskStore.startTask(projectBDone.id);
    taskStore.completeTask(projectBDone.id);
    taskStore.startTask(projectATerminated.id);
    taskStore.terminateTask(projectATerminated.id);
    taskStore.startTask(unscopedDone.id);
    taskStore.completeTask(unscopedDone.id);
    taskStore.startTask(projectAActive.id);
    const { deps } = makeDeps(taskStore, { takePredeleteSnapshot: vi.fn(async () => undefined) });

    const result = await new TaskLifecycleCommands(deps).clearFinishedTasks({
      includeTerminated: true,
      projectId: 'github.com/org/a',
    });

    expect(result).toMatchObject({
      outcome: 'cleared',
      deletedTaskIds: expect.arrayContaining([projectADone.id, projectATerminated.id]),
    });
    expect(taskStore.getTask(projectADone.id)).toBeUndefined();
    expect(taskStore.getTask(projectATerminated.id)).toBeUndefined();
    expect(taskStore.getTask(projectBDone.id)?.status).toBe('completed');
    expect(taskStore.getTask(unscopedDone.id)?.status).toBe('completed');
    expect(taskStore.getTask(projectAActive.id)?.status).toBe('inProgress');
  });

  test('writes structured audit and broadcasts clear count for project-scoped bulk deletion', async () => {
    const auditDir = await mkdtemp(join(tmpdir(), 'kookr-clear-audit-'));
    const auditLogPath = join(auditDir, 'audit.jsonl');
    try {
      const taskStore = new TaskStore();
      const completed = taskStore.createTask({ prompt: 'A done', cwd: '/repo-a', projectId: 'github.com/org/a' });
      const cancelled = taskStore.createTask({ prompt: 'A cancelled', cwd: '/repo-a', projectId: 'github.com/org/a' });
      const active = taskStore.createTask({ prompt: 'A active', cwd: '/repo-a', projectId: 'github.com/org/a' });
      const other = taskStore.createTask({ prompt: 'B done', cwd: '/repo-b', projectId: 'github.com/org/b' });
      taskStore.startTask(completed.id);
      taskStore.completeTask(completed.id);
      taskStore.startTask(cancelled.id);
      taskStore.cancelTask(cancelled.id);
      taskStore.startTask(active.id);
      taskStore.startTask(other.id);
      taskStore.completeTask(other.id);
      const { deps } = makeDeps(taskStore, {
        auditLogPath,
        takePredeleteSnapshot: vi.fn(async () => undefined),
      });

      const result = await new TaskLifecycleCommands(deps).clearFinishedTasks({
        projectId: 'github.com/org/a',
        actor: { source: 'websocket', actorId: 'connection-1' },
      });

      expect(result).toMatchObject({
        outcome: 'cleared',
        deletedTaskIds: expect.arrayContaining([completed.id, cancelled.id]),
      });
      expect((result as { deletedTaskIds: string[] }).deletedTaskIds).toHaveLength(2);
      const rows = await readJsonl(auditLogPath) as Array<{ deletedTaskIds: string[] }>;
      expect(rows).toEqual([
        expect.objectContaining({
          type: 'task.clearCompleted',
          actor: { source: 'websocket', actorId: 'connection-1' },
          scope: { kind: 'project', projectId: 'github.com/org/a' },
          count: 2,
          deletedTaskIds: expect.any(Array),
          includeTerminated: false,
          outcome: 'cleared',
        }),
      ]);
      expect(rows[0].deletedTaskIds.sort()).toEqual([cancelled.id, completed.id].sort());
      expect(deps.broadcastToAll).toHaveBeenCalledWith(expect.objectContaining({
        type: 'alert',
        summary: 'Cleared 2 tasks',
        severity: 'info',
      }));
    } finally {
      await rm(auditDir, { recursive: true, force: true });
    }
  });

  test('treats blank project scope as a no-op instead of a global clear', async () => {
    const taskStore = new TaskStore();
    const completed = taskStore.createTask({ prompt: 'Done', cwd: '/repo', projectId: 'github.com/org/a' });
    taskStore.startTask(completed.id);
    taskStore.completeTask(completed.id);
    const takePredeleteSnapshot = vi.fn(async () => undefined);
    const { deps } = makeDeps(taskStore, { takePredeleteSnapshot });

    const result = await new TaskLifecycleCommands(deps).clearFinishedTasks({ projectId: '   ' });

    expect(result).toEqual({ outcome: 'cleared', deletedTaskIds: [] });
    expect(takePredeleteSnapshot).not.toHaveBeenCalled();
    expect(taskStore.getTask(completed.id)?.status).toBe('completed');
  });
});

describe('TaskLifecycleCommands.requestTaskSnapshotReflect', () => {
  async function makeSnapshotDeps(taskStore: TaskStore) {
    const dir = await mkdtemp(join(tmpdir(), 'snapshot-reflect-'));
    const interactionLog = { append: vi.fn(async () => undefined) } as never;
    const { deps } = makeDeps(taskStore, {
      interactionLog,
      taskSnapshotDir: join(dir, 'snapshots'),
      hooksDir: join(dir, 'hooks'),
      reflectWorktreesDir: join(dir, 'reflect'),
      readInteractionLogSnapshot: async () => [],
      // Non-git cwd → requestTaskReflect bails cleanly before any worktree work;
      // the interaction-log append we assert on happens earlier regardless.
      launchTask: vi.fn(async () => ({ task: {} as never, queued: false })),
    });
    return { deps, interactionLog, dir };
  }

  test('records the trimmed hint in the interaction log', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Reflect target', '/repo');
    addSession(taskStore, task.id);
    const { deps, interactionLog, dir } = await makeSnapshotDeps(taskStore);
    try {
      await new TaskLifecycleCommands(deps).requestTaskSnapshotReflect(task.id, '  liked the e2e tests  ');
      expect(interactionLog.append).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task_reflect_requested', hint: 'liked the e2e tests' }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('omits the hint when it is blank or absent', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Reflect target', '/repo');
    addSession(taskStore, task.id);
    const { deps, interactionLog, dir } = await makeSnapshotDeps(taskStore);
    try {
      await new TaskLifecycleCommands(deps).requestTaskSnapshotReflect(task.id, '   ');
      const appended = (interactionLog.append as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(appended.type).toBe('task_reflect_requested');
      expect(appended).not.toHaveProperty('hint');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
