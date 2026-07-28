import { describe, expect, test, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskStore } from '../../core/tasks.js';
import { ackAllStaleCompletionReadyTasks } from './ack-all-completion-ready.js';
import type { TaskLifecycleCommandResult } from './task-lifecycle-commands.js';

const ONE_HOUR_MS = 60 * 60 * 1000;
const NOW = new Date('2026-07-24T14:00:00.000Z');
const STALE_RAISED_AT = new Date(NOW.getTime() - 2 * ONE_HOUR_MS).toISOString();

function startTask(store: TaskStore, id: string): void {
  store.addSession(id, {
    tmuxSession: `kookr-${id}`,
    agentType: 'claude-code',
    cwd: '/repo',
    createdAt: new Date(NOW.getTime() - 3 * ONE_HOUR_MS),
  });
}

async function readJsonl(path: string): Promise<unknown[]> {
  const text = await readFile(path, 'utf-8');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as unknown);
}

describe('ackAllStaleCompletionReadyTasks', () => {
  function makeTaskStore(): { taskStore: TaskStore; autoCloseTaskId: string; askFirstTaskId: string } {
    const taskStore = new TaskStore();

    const autoCloseTask = taskStore.createTask({
      prompt: 'Opted in',
      cwd: '/repo',
      autoCloseOnSignal: true,
    });
    startTask(taskStore, autoCloseTask.id);
    taskStore.setPendingSignal(autoCloseTask.id, { kind: 'completion_ready', raisedAt: STALE_RAISED_AT });

    const askFirstTask = taskStore.createTask({
      prompt: 'Ask first, not opted in',
      cwd: '/repo',
      deliveryAuthorization: 'ask-first',
    });
    startTask(taskStore, askFirstTask.id);
    taskStore.setPendingSignal(askFirstTask.id, { kind: 'completion_ready', raisedAt: STALE_RAISED_AT });

    return { taskStore, autoCloseTaskId: autoCloseTask.id, askFirstTaskId: askFirstTask.id };
  }

  test('default scope completes only canAutoClose entries, leaving ask-first ones untouched', async () => {
    const { taskStore, autoCloseTaskId, askFirstTaskId } = makeTaskStore();
    const completeTask = vi.fn(async (taskId: string): Promise<TaskLifecycleCommandResult> => {
      taskStore.completeTask(taskId);
      return { outcome: 'completed', task: taskStore.getTask(taskId)! };
    });

    const result = await ackAllStaleCompletionReadyTasks(
      { taskStore, lifecycleCommands: { completeTask } },
      { now: NOW },
    );

    expect(completeTask).toHaveBeenCalledTimes(1);
    expect(completeTask).toHaveBeenCalledWith(autoCloseTaskId, { actor: undefined });
    expect(result.force).toBe(false);
    expect(result.summary).toEqual({
      matched: 1,
      completed: 1,
      already_terminal: 0,
      partial_ralph_completion: 0,
      invalid: 0,
      not_found: 0,
      failed: 0,
    });
    expect(result.results).toEqual([
      { taskId: autoCloseTaskId, outcome: 'completed', status: 'completed' },
    ]);
    // The ask-first task was never touched.
    expect(taskStore.getTask(askFirstTaskId)?.status).toBe('inProgress');
  });

  test('force:true widens the scope to every stale entry regardless of policy', async () => {
    const { taskStore, autoCloseTaskId, askFirstTaskId } = makeTaskStore();
    const completeTask = vi.fn(async (taskId: string): Promise<TaskLifecycleCommandResult> => {
      taskStore.completeTask(taskId);
      return { outcome: 'completed', task: taskStore.getTask(taskId)! };
    });

    const result = await ackAllStaleCompletionReadyTasks(
      { taskStore, lifecycleCommands: { completeTask } },
      { now: NOW, force: true },
    );

    expect(completeTask).toHaveBeenCalledTimes(2);
    expect(result.force).toBe(true);
    expect(result.summary.matched).toBe(2);
    expect(result.summary.completed).toBe(2);
    const taskIds = result.results.map((r) => r.taskId).sort();
    expect(taskIds).toEqual([askFirstTaskId, autoCloseTaskId].sort());
  });

  test('reports per-id results for a mixed-outcome batch without throwing', async () => {
    const { taskStore, autoCloseTaskId, askFirstTaskId } = makeTaskStore();
    const completeTask = vi.fn(async (taskId: string): Promise<TaskLifecycleCommandResult> => {
      if (taskId === autoCloseTaskId) {
        throw new Error('adapter stop failed');
      }
      return { outcome: 'already_terminal', task: taskStore.getTask(taskId)! };
    });

    const result = await ackAllStaleCompletionReadyTasks(
      { taskStore, lifecycleCommands: { completeTask } },
      { now: NOW, force: true },
    );

    expect(result.summary).toEqual({
      matched: 2,
      completed: 0,
      already_terminal: 1,
      partial_ralph_completion: 0,
      invalid: 0,
      not_found: 0,
      failed: 1,
    });
    expect(result.results).toEqual(
      expect.arrayContaining([
        { taskId: autoCloseTaskId, outcome: 'failed', error: 'adapter stop failed' },
        { taskId: askFirstTaskId, outcome: 'already_terminal', status: expect.any(String) },
      ]),
    );
  });

  test('writes one summary audit row carrying the actor, plus does nothing when nothing matched', async () => {
    const auditDir = await mkdtemp(join(tmpdir(), 'kookr-ack-all-audit-'));
    const auditLogPath = join(auditDir, 'audit.jsonl');
    try {
      const { taskStore, autoCloseTaskId } = makeTaskStore();
      const completeTask = vi.fn(async (taskId: string): Promise<TaskLifecycleCommandResult> => {
        taskStore.completeTask(taskId);
        return { outcome: 'completed', task: taskStore.getTask(taskId)! };
      });

      await ackAllStaleCompletionReadyTasks(
        { taskStore, lifecycleCommands: { completeTask }, auditLogPath },
        { now: NOW, actor: { source: 'api', actorId: 'lucy-supervisor' } },
      );

      const rows = await readJsonl(auditLogPath) as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({
        type: 'task.completionReadyAckAll',
        actor: { source: 'api', actorId: 'lucy-supervisor' },
        force: false,
        count: 1,
        summary: expect.objectContaining({ completed: 1 }),
        results: [{ taskId: autoCloseTaskId, outcome: 'completed', status: 'completed' }],
      }));
    } finally {
      await rm(auditDir, { recursive: true, force: true });
    }
  });

  test('an empty task store matches nothing and writes no audit row', async () => {
    const auditDir = await mkdtemp(join(tmpdir(), 'kookr-ack-all-empty-'));
    const auditLogPath = join(auditDir, 'audit.jsonl');
    try {
      const taskStore = new TaskStore();
      const completeTask = vi.fn();

      const result = await ackAllStaleCompletionReadyTasks(
        { taskStore, lifecycleCommands: { completeTask }, auditLogPath },
        { now: NOW },
      );

      expect(completeTask).not.toHaveBeenCalled();
      expect(result.summary.matched).toBe(0);
      await expect(readFile(auditLogPath, 'utf-8')).rejects.toThrow();
    } finally {
      await rm(auditDir, { recursive: true, force: true });
    }
  });
});
