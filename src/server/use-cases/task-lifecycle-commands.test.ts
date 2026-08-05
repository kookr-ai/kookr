import { describe, expect, test, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../core/tasks.js';
import { Monitor } from '../../core/monitor.js';
import { AttentionQueue } from '../../core/attention-queue.js';
import { TaskLifecycleCommands, type TaskLifecycleCommandDeps } from './task-lifecycle-commands.js';

const mockBuildTaskCompletionMetadata = vi.fn();
const mockCleanupTaskWorktrees = vi.fn();
vi.mock('../completion-metadata.js', () => ({
  buildTaskCompletionMetadata: (...args: unknown[]) => mockBuildTaskCompletionMetadata(...args),
}));

vi.mock('../../adapters/git-worktree.js', () => ({
  cleanupTaskWorktrees: (...args: unknown[]) => mockCleanupTaskWorktrees(...args),
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
    mockCleanupTaskWorktrees.mockReset().mockResolvedValue(undefined);
  });

  test('forwards a per-task worktree cleanup override to the shared lifecycle', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Complete without cleanup', '/repo');
    addSession(taskStore, task.id);
    const { deps } = makeDeps(taskStore);

    const result = await new TaskLifecycleCommands(deps).completeTask(task.id, {
      cleanupWorktree: false,
    });

    expect(result.outcome).toBe('completed');
    expect(mockCleanupTaskWorktrees).not.toHaveBeenCalled();
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

describe('TaskLifecycleCommands.completeTask audit (issue #1526 Phase B)', () => {
  beforeEach(() => {
    mockBuildTaskCompletionMetadata.mockReset().mockResolvedValue({
      digest: { bullets: ['shipped fix'], filesChanged: [] },
      taskTokenUsage: undefined,
    });
    mockCleanupTaskWorktrees.mockReset().mockResolvedValue(undefined);
  });

  test('writes an audit row carrying the supplied actor on a real completion', async () => {
    const auditDir = await mkdtemp(join(tmpdir(), 'kookr-complete-audit-'));
    const auditLogPath = join(auditDir, 'audit.jsonl');
    try {
      const taskStore = new TaskStore();
      const task = taskStore.createTask('Complete me', '/repo');
      addSession(taskStore, task.id);
      const { deps } = makeDeps(taskStore, { auditLogPath });

      const result = await new TaskLifecycleCommands(deps).completeTask(task.id, {
        actor: { source: 'api', actorId: 'lucy-supervisor' },
      });

      expect(result.outcome).toBe('completed');
      expect(await readJsonl(auditLogPath)).toEqual([
        expect.objectContaining({
          type: 'task.complete',
          actor: { source: 'api', actorId: 'lucy-supervisor' },
          taskId: task.id,
          outcome: 'completed',
          status: 'completed',
        }),
      ]);
    } finally {
      await rm(auditDir, { recursive: true, force: true });
    }
  });

  test('defaults to an unknown actor and still audits no-op outcomes (not_found)', async () => {
    const auditDir = await mkdtemp(join(tmpdir(), 'kookr-complete-audit-noop-'));
    const auditLogPath = join(auditDir, 'audit.jsonl');
    try {
      const taskStore = new TaskStore();
      const { deps } = makeDeps(taskStore, { auditLogPath });

      const result = await new TaskLifecycleCommands(deps).completeTask('missing-task');

      expect(result.outcome).toBe('not_found');
      expect(await readJsonl(auditLogPath)).toEqual([
        expect.objectContaining({
          type: 'task.complete',
          actor: { source: 'unknown' },
          taskId: 'missing-task',
          outcome: 'not_found',
        }),
      ]);
    } finally {
      await rm(auditDir, { recursive: true, force: true });
    }
  });

  test('writes no row when auditLogPath is not configured', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Complete without audit dir', '/repo');
    addSession(taskStore, task.id);
    const { deps } = makeDeps(taskStore);

    const result = await new TaskLifecycleCommands(deps).completeTask(task.id);

    expect(result.outcome).toBe('completed');
    // No assertion possible on a nonexistent file beyond "did not throw" —
    // absence of `auditLogPath` short-circuits the write entirely.
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

  test('GCs the deleted task hung-task reports without touching other tasks (issue #2126)', async () => {
    const reportsDir = await mkdtemp(join(tmpdir(), 'kookr-reports-gc-'));
    try {
      const taskStore = new TaskStore();
      const doomed = taskStore.createTask('Doomed', '/repo');
      taskStore.startTask(doomed.id);
      taskStore.completeTask(doomed.id);
      const survivor = taskStore.createTask('Survivor', '/repo');
      taskStore.startTask(survivor.id);

      // Two reap reports for the doomed task (the reaper writes one per reap).
      const doomedReportA = join(reportsDir, `hung-task-${doomed.id}-2026-08-06T00-00-00-000Z.md`);
      const doomedReportB = join(reportsDir, `hung-task-${doomed.id}-2026-08-06T01-00-00-000Z.md`);
      // A survivor whose id differs: gcHungTaskReports scans the whole dir, so this
      // proves the prefix filter, not merely that the task was never swept.
      const survivorReport = join(reportsDir, `hung-task-${survivor.id}-2026-08-06T00-00-00-000Z.md`);
      // A task whose id has the doomed id as a strict prefix — the trailing
      // '-' boundary must spare it.
      const prefixSibling = join(reportsDir, `hung-task-${doomed.id}xyz-2026-08-06T00-00-00-000Z.md`);
      // A doomed-prefixed but non-`.md` partial (e.g. an interrupted write):
      // the GC matches the reaper's `*.md` glob, so this must survive.
      const doomedPartial = join(reportsDir, `hung-task-${doomed.id}-2026-08-06T02-00-00-000Z.md.tmp`);
      const unrelated = join(reportsDir, 'some-other-report.md');
      await Promise.all(
        [doomedReportA, doomedReportB, survivorReport, prefixSibling, doomedPartial, unrelated].map((p) =>
          writeFile(p, 'report', 'utf-8'),
        ),
      );

      const { deps } = makeDeps(taskStore, { reportsDir, takePredeleteSnapshot: vi.fn(async () => undefined) });

      const result = await new TaskLifecycleCommands(deps).clearFinishedTasks({});

      expect(result).toMatchObject({ outcome: 'cleared', deletedTaskIds: [doomed.id] });
      // The GC is fire-and-forget; wait for the doomed `.md` reports to disappear.
      await vi.waitFor(async () => {
        const remaining = (await readdir(reportsDir)).sort();
        expect(remaining).toEqual(
          [
            `hung-task-${survivor.id}-2026-08-06T00-00-00-000Z.md`,
            `hung-task-${doomed.id}xyz-2026-08-06T00-00-00-000Z.md`,
            `hung-task-${doomed.id}-2026-08-06T02-00-00-000Z.md.tmp`,
            'some-other-report.md',
          ].sort(),
        );
      });
    } finally {
      await rm(reportsDir, { recursive: true, force: true });
    }
  });

  test('report GC is fail-open when the reports dir is absent (issue #2126)', async () => {
    const taskStore = new TaskStore();
    const doomed = taskStore.createTask('Doomed', '/repo');
    taskStore.startTask(doomed.id);
    taskStore.completeTask(doomed.id);
    const { deps } = makeDeps(taskStore, {
      reportsDir: join(tmpdir(), 'kookr-reports-does-not-exist', 'nested'),
      takePredeleteSnapshot: vi.fn(async () => undefined),
    });

    // gcHungTaskReports is fire-and-forget (a void IIFE), so a `readdir` failure on the
    // absent dir would escape as a process-level unhandledRejection rather than
    // failing the awaited clear. Capture rejections to prove the guard actually
    // swallows the error (mirrors session-bridge.test.ts's resilience checks).
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      const result = await new TaskLifecycleCommands(deps).clearFinishedTasks({});

      expect(result).toMatchObject({ outcome: 'cleared', deletedTaskIds: [doomed.id] });
      expect(taskStore.getTask(doomed.id)).toBeUndefined();
      // Let microtasks + a macrotask settle so any escaped rejection materializes.
      await new Promise((r) => setTimeout(r, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('TaskLifecycleCommands.batchAbortTasks', () => {
  test('aborts multiple active tasks in one call and interrupts their sessions', async () => {
    const taskStore = new TaskStore();
    const a = taskStore.createTask('A', '/repo');
    addSession(taskStore, a.id, 'kookr-a');
    const b = taskStore.createTask('B', '/repo');
    addSession(taskStore, b.id, 'kookr-b');
    const { deps, stop } = makeDeps(taskStore);

    const { results, summary } = await new TaskLifecycleCommands(deps).batchAbortTasks([a.id, b.id]);

    expect(summary).toEqual({ total: 2, aborted: 2, already_terminal: 0, not_found: 0, failed: 0 });
    expect(results).toEqual([
      { taskId: a.id, outcome: 'aborted', status: 'cancelled' },
      { taskId: b.id, outcome: 'aborted', status: 'cancelled' },
    ]);
    expect(taskStore.getTask(a.id)?.status).toBe('cancelled');
    expect(taskStore.getTask(b.id)?.status).toBe('cancelled');
    expect(stop).toHaveBeenCalledWith('kookr-a');
    expect(stop).toHaveBeenCalledWith('kookr-b');
    expect(deps.scheduleService?.recordTaskTerminalOutcome).toHaveBeenCalledWith(a.id, 'cancelled');
  });

  test('reports mixed live / terminal / missing tasks per task', async () => {
    const taskStore = new TaskStore();
    const active = taskStore.createTask('active', '/repo');
    addSession(taskStore, active.id, 'kookr-active');
    const done = taskStore.createTask('done', '/repo');
    taskStore.startTask(done.id);
    taskStore.completeTask(done.id);
    const cancelledAlready = taskStore.createTask('already cancelled', '/repo');
    taskStore.startTask(cancelledAlready.id);
    taskStore.cancelTask(cancelledAlready.id);
    const { deps, stop } = makeDeps(taskStore);

    const { results, summary } = await new TaskLifecycleCommands(deps).batchAbortTasks([
      active.id,
      done.id,
      cancelledAlready.id,
      'missing-task-id',
    ]);

    expect(summary).toEqual({ total: 4, aborted: 1, already_terminal: 2, not_found: 1, failed: 0 });
    expect(results).toEqual([
      { taskId: active.id, outcome: 'aborted', status: 'cancelled' },
      { taskId: done.id, outcome: 'already_terminal', status: 'completed' },
      { taskId: cancelledAlready.id, outcome: 'already_terminal', status: 'cancelled' },
      { taskId: 'missing-task-id', outcome: 'not_found' },
    ]);
    // Only the live task's session was interrupted.
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith('kookr-active');
  });

  test('is idempotent: retrying does not re-transition, re-interrupt, or duplicate audit rows', async () => {
    const auditDir = await mkdtemp(join(tmpdir(), 'kookr-abort-audit-'));
    const auditLogPath = join(auditDir, 'audit.jsonl');
    try {
      const taskStore = new TaskStore();
      const a = taskStore.createTask('A', '/repo');
      addSession(taskStore, a.id, 'kookr-a');
      const { deps, stop } = makeDeps(taskStore, { auditLogPath });
      const commands = new TaskLifecycleCommands(deps);

      const first = await commands.batchAbortTasks([a.id], {
        reason: 'mass shutdown',
        actor: { source: 'api' },
      });
      expect(first.summary).toMatchObject({ aborted: 1, already_terminal: 0 });
      expect(stop).toHaveBeenCalledTimes(1);

      const second = await commands.batchAbortTasks([a.id], {
        reason: 'mass shutdown',
        actor: { source: 'api' },
      });
      expect(second.summary).toEqual({ total: 1, aborted: 0, already_terminal: 1, not_found: 0, failed: 0 });
      expect(second.results).toEqual([{ taskId: a.id, outcome: 'already_terminal', status: 'cancelled' }]);
      // No second interruption, no second terminal-outcome record.
      expect(stop).toHaveBeenCalledTimes(1);
      expect(deps.scheduleService?.recordTaskTerminalOutcome).toHaveBeenCalledTimes(1);

      // Exactly one audit row — the retry aborted nothing, so it appended nothing.
      const rows = await readJsonl(auditLogPath);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({
        type: 'task.batchAbort',
        actor: { source: 'api' },
        reason: 'mass shutdown',
        count: 1,
        abortedTaskIds: [a.id],
        summary: { total: 1, aborted: 1, already_terminal: 0, not_found: 0, failed: 0 },
      }));
    } finally {
      await rm(auditDir, { recursive: true, force: true });
    }
  });

  test('dedupes and trims repeated ids so a task aborts once', async () => {
    const taskStore = new TaskStore();
    const a = taskStore.createTask('A', '/repo');
    addSession(taskStore, a.id, 'kookr-a');
    const { deps, stop } = makeDeps(taskStore);

    const { results, summary } = await new TaskLifecycleCommands(deps).batchAbortTasks([
      a.id,
      `  ${a.id}  `,
      '',
      a.id,
    ]);

    expect(summary).toEqual({ total: 1, aborted: 1, already_terminal: 0, not_found: 0, failed: 0 });
    expect(results).toEqual([{ taskId: a.id, outcome: 'aborted', status: 'cancelled' }]);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test('reports a per-task failure without blocking the rest of the batch', async () => {
    const taskStore = new TaskStore();
    const bad = taskStore.createTask('bad', '/repo');
    addSession(taskStore, bad.id, 'kookr-bad');
    const good = taskStore.createTask('good', '/repo');
    addSession(taskStore, good.id, 'kookr-good');
    const { deps } = makeDeps(taskStore);
    const baseLifecycleDeps = deps.getLifecycleDeps;
    deps.getLifecycleDeps = () => ({
      ...baseLifecycleDeps(),
      adapter: {
        stop: vi.fn(async (session: string) => {
          if (session === 'kookr-bad') throw new Error('stop failed');
        }),
      },
    } as never);

    const { results, summary } = await new TaskLifecycleCommands(deps).batchAbortTasks([bad.id, good.id]);

    expect(summary).toEqual({ total: 2, aborted: 1, already_terminal: 0, not_found: 0, failed: 1 });
    expect(results).toEqual([
      { taskId: bad.id, outcome: 'failed', error: 'stop failed' },
      { taskId: good.id, outcome: 'aborted', status: 'cancelled' },
    ]);
    // The failed task keeps its live state; the healthy one still converged.
    expect(taskStore.getTask(bad.id)?.status).toBe('inProgress');
    expect(taskStore.getTask(good.id)?.status).toBe('cancelled');
  });

  test('does not write an audit row when nothing is aborted', async () => {
    const auditDir = await mkdtemp(join(tmpdir(), 'kookr-abort-noop-'));
    const auditLogPath = join(auditDir, 'audit.jsonl');
    try {
      const taskStore = new TaskStore();
      const done = taskStore.createTask('done', '/repo');
      taskStore.startTask(done.id);
      taskStore.completeTask(done.id);
      const { deps } = makeDeps(taskStore, { auditLogPath });

      const { summary } = await new TaskLifecycleCommands(deps).batchAbortTasks([done.id, 'missing'], {
        actor: { source: 'api' },
      });

      expect(summary).toEqual({ total: 2, aborted: 0, already_terminal: 1, not_found: 1, failed: 0 });
      await expect(readFile(auditLogPath, 'utf-8')).rejects.toThrow();
    } finally {
      await rm(auditDir, { recursive: true, force: true });
    }
  });

  test('audits a wholly-failed batch (nothing aborted, teardown failed)', async () => {
    const auditDir = await mkdtemp(join(tmpdir(), 'kookr-abort-allfail-'));
    const auditLogPath = join(auditDir, 'audit.jsonl');
    try {
      const taskStore = new TaskStore();
      const bad = taskStore.createTask('bad', '/repo');
      addSession(taskStore, bad.id, 'kookr-bad');
      const { deps } = makeDeps(taskStore, { auditLogPath });
      const baseLifecycleDeps = deps.getLifecycleDeps;
      deps.getLifecycleDeps = () => ({
        ...baseLifecycleDeps(),
        adapter: { stop: vi.fn(async () => { throw new Error('daemon down'); }) },
      } as never);

      const { summary } = await new TaskLifecycleCommands(deps).batchAbortTasks([bad.id], {
        actor: { source: 'websocket', actorId: 'conn-1' },
      });

      expect(summary).toEqual({ total: 1, aborted: 0, already_terminal: 0, not_found: 0, failed: 1 });
      const rows = await readJsonl(auditLogPath);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({
        type: 'task.batchAbort',
        abortedTaskIds: [],
        summary: { total: 1, aborted: 0, already_terminal: 0, not_found: 0, failed: 1 },
      }));
    } finally {
      await rm(auditDir, { recursive: true, force: true });
    }
  });

  test('redacts secrets and truncates an over-long reason in the audit row', async () => {
    const auditDir = await mkdtemp(join(tmpdir(), 'kookr-abort-reason-'));
    const auditLogPath = join(auditDir, 'audit.jsonl');
    try {
      const taskStore = new TaskStore();
      const a = taskStore.createTask('A', '/repo');
      addSession(taskStore, a.id, 'kookr-a');
      const b = taskStore.createTask('B', '/repo');
      addSession(taskStore, b.id, 'kookr-b');
      const { deps } = makeDeps(taskStore, { auditLogPath });
      const commands = new TaskLifecycleCommands(deps);

      await commands.batchAbortTasks([a.id], { reason: 'leak ghp_0123456789abcdefghij now' });
      await commands.batchAbortTasks([b.id], { reason: 'x'.repeat(600) });

      const rows = await readJsonl(auditLogPath) as Array<{ reason?: string }>;
      expect(rows).toHaveLength(2);
      // Secret is redacted, never persisted verbatim.
      expect(rows[0].reason).not.toContain('ghp_0123456789abcdefghij');
      expect(rows[0].reason).toContain('[REDACTED]');
      // Over-long reason is truncated with a marker.
      expect(rows[1].reason!.endsWith(' [truncated]')).toBe(true);
      expect(rows[1].reason!.length).toBeLessThanOrEqual(600);
    } finally {
      await rm(auditDir, { recursive: true, force: true });
    }
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
