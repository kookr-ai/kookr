import { describe, test, expect, beforeEach } from 'vitest';
import { TaskStore } from '../core/tasks.js';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import type { SessionSpec } from '../adapters/terminal-backend.js';
import { reconcile } from './reconciliation.js';

function spec(id: string): SessionSpec {
  return {
    id,
    command: 'claude',
    args: [],
    env: {},
    cwd: '/tmp',
    size: { cols: 80, rows: 24 },
  };
}

describe('Startup Reconciliation', () => {
  let taskStore: TaskStore;
  let backend: FakeTerminalBackend;

  beforeEach(() => {
    taskStore = new TaskStore();
    backend = new FakeTerminalBackend();
  });

  test('task has session + backend alive - resume monitoring', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-abc',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'running',
    });

    // Create a real session in the fake backend
    await backend.createSession(spec('kookr-abc'));

    const result = await reconcile(taskStore, backend);

    expect(result.resumed).toHaveLength(1);
    expect(result.resumed[0]).toBe('kookr-abc');
    expect(result.markedCompleted).toHaveLength(0);
  });

  test('task has session + backend dead - mark session completed, task auto-completes', async () => {
    const task = taskStore.createTask('Fix bug', '/cwd');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-abc',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'running',
    });

    // Don't create backend session — it's dead

    const result = await reconcile(taskStore, backend);

    expect(result.markedCompleted).toHaveLength(1);
    expect(result.markedCompleted[0]).toBe('kookr-abc');

    // Session should be marked completed
    const updatedTask = taskStore.getTask(task.id)!;
    const session = updatedTask.sessions.find((s) => s.tmuxSession === 'kookr-abc');
    expect(session!.lastStatus).toBe('completed');

    // Task auto-transitions to 'terminated' when all sessions are done
    // (see rfc-task-loss-prevention D1 — user must acknowledge to reach 'completed').
    expect(updatedTask.status).toBe('terminated');
    expect(result.tasksTerminated).toContain(task.id);
  });

  test('orphan backend session not in tasks.json - logged as warning', async () => {
    await backend.createSession(spec('kookr-orphan'));

    const result = await reconcile(taskStore, backend);

    expect(result.orphans).toHaveLength(1);
    expect(result.orphans[0]).toBe('kookr-orphan');
  });

  test('no tasks - fresh start', async () => {
    const result = await reconcile(taskStore, backend);

    expect(result.resumed).toHaveLength(0);
    expect(result.markedCompleted).toHaveLength(0);
    expect(result.orphans).toHaveLength(0);
  });

  test('tasks exist, no backend sessions - all sessions completed, tasks auto-complete', async () => {
    const task1 = taskStore.createTask('Task 1', '/cwd');
    taskStore.addSession(task1.id, {
      tmuxSession: 'kookr-1',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'running',
    });

    const task2 = taskStore.createTask('Task 2', '/cwd');
    taskStore.addSession(task2.id, {
      tmuxSession: 'kookr-2',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'running',
    });

    const result = await reconcile(taskStore, backend);

    expect(result.markedCompleted).toHaveLength(2);
    expect(result.resumed).toHaveLength(0);
    expect(result.tasksTerminated).toHaveLength(2);
    expect(taskStore.getTask(task1.id)!.status).toBe('terminated');
    expect(taskStore.getTask(task2.id)!.status).toBe('terminated');
  });

  test('task with mix of alive and dead sessions stays inProgress', async () => {
    const task = taskStore.createTask('Multi-session task', '/cwd');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-alive',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'running',
    });
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-dead',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'running',
    });

    await backend.createSession(spec('kookr-alive'));
    // kookr-dead not created — it's dead

    const result = await reconcile(taskStore, backend);

    expect(result.resumed).toContain('kookr-alive');
    expect(result.markedCompleted).toContain('kookr-dead');
    // Task stays inProgress because kookr-alive is still running
    expect(taskStore.getTask(task.id)!.status).toBe('inProgress');
    expect(result.tasksCompleted).toHaveLength(0);
  });

  test('task stuck inProgress with all sessions already completed — auto-completed on reconcile', async () => {
    // This is the exact bug: session was marked completed by a previous stop,
    // but the task remained inProgress. Reconciliation must catch this.
    const task = taskStore.createTask('Read README', '/cwd');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-d8dd56ae',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'completed', // Already completed — backend session is gone
    });
    // Task is inProgress but session is completed — stuck state
    expect(task.status).toBe('inProgress');

    const result = await reconcile(taskStore, backend);

    expect(taskStore.getTask(task.id)!.status).toBe('terminated');
    expect(result.tasksTerminated).toContain(task.id);
    // No sessions to mark completed — they were already completed
    expect(result.markedCompleted).toHaveLength(0);
  });

  test('multi-session task with all sessions pre-completed — auto-terminated', async () => {
    const task = taskStore.createTask('Multi-step task', '/cwd');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-aaa',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'completed',
    });
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-bbb',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'completed',
    });

    const result = await reconcile(taskStore, backend);

    expect(taskStore.getTask(task.id)!.status).toBe('terminated');
    expect(result.tasksTerminated).toContain(task.id);
  });

  test('multi-session: one pre-completed, one alive — task stays inProgress', async () => {
    const task = taskStore.createTask('Mixed task', '/cwd');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-done',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'completed',
    });
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-alive',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'running',
    });

    await backend.createSession(spec('kookr-alive'));

    const result = await reconcile(taskStore, backend);

    expect(result.resumed).toContain('kookr-alive');
    expect(taskStore.getTask(task.id)!.status).toBe('inProgress');
    expect(result.tasksTerminated).toHaveLength(0);
  });

  test('reconcile is idempotent — running twice does not error or double-complete', async () => {
    const task = taskStore.createTask('Idempotent test', '/cwd');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-idem',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'completed',
    });

    const result1 = await reconcile(taskStore, backend);
    expect(result1.tasksTerminated).toContain(task.id);
    expect(taskStore.getTask(task.id)!.status).toBe('terminated');

    // Second run: task is now 'terminated', not 'inProgress' — should be a no-op
    const result2 = await reconcile(taskStore, backend);
    expect(result2.tasksTerminated).toHaveLength(0);
    expect(taskStore.getTask(task.id)!.status).toBe('terminated');
  });

  test('aborted sessions are skipped during reconciliation', async () => {
    const task = taskStore.createTask('Cancelled task', '/cwd');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-aborted',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'aborted',
    });

    const result = await reconcile(taskStore, backend);

    // Session was already aborted, so it should not be in resumed or markedCompleted
    expect(result.resumed).toHaveLength(0);
    expect(result.markedCompleted).toHaveLength(0);
  });

  test('task with aborted session auto-completes if all sessions terminated', async () => {
    const task = taskStore.createTask('Mixed termination', '/cwd');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-ok',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'completed',
    });
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-abort',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'aborted',
    });

    const result = await reconcile(taskStore, backend);

    expect(taskStore.getTask(task.id)!.status).toBe('terminated');
    expect(result.tasksTerminated).toContain(task.id);
  });

  test('open task with all sessions completed — backfilled to terminated', async () => {
    // Simulates pre-lifecycle tasks stuck in "open" with completed sessions.
    // The task was created before the auto-complete feature, so it never
    // transitioned through the lifecycle. Reconciliation should fix this.
    const task = taskStore.createTask('Old task from v0', '/cwd');
    // Manually add a session that's already completed (bypassing addSession
    // which would auto-transition to inProgress) to simulate loaded state.
    const t = taskStore.getTask(task.id)!;
    t.sessions.push({
      tmuxSession: 'kookr-legacy',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'completed',
    });
    // Task is still "open" — this is the stuck state we're fixing
    expect(t.status).toBe('open');

    const result = await reconcile(taskStore, backend);

    // Was "completed" before rfc-task-loss-prevention; now "terminated" —
    // the user must ack to claim graceful finish.
    expect(taskStore.getTask(task.id)!.status).toBe('terminated');
    expect(result.tasksTerminated).toContain(task.id);
  });

  test('open task with active sessions is not backfilled', async () => {
    const task = taskStore.createTask('Active old task', '/cwd');
    const t = taskStore.getTask(task.id)!;
    t.sessions.push({
      tmuxSession: 'kookr-active',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'running',
    });
    await backend.createSession(spec('kookr-active'));

    const result = await reconcile(taskStore, backend);

    expect(taskStore.getTask(task.id)!.status).toBe('open');
    expect(result.tasksTerminated).toHaveLength(0);
    expect(result.resumed).toContain('kookr-active');
  });

  test.each([['running' as const], ['paused' as const]])(
    'Ralph loop (status=%s) is exempt from auto-termination between iterations',
    async (loopStatus) => {
      // Between iterations, the prior session is dead and the next is not yet
      // registered. Reconciliation must NOT terminate the parent task during
      // that gap; the loop service drives the spawn of iteration N+1. See
      // docs/rfc/rfc-ralph-loop-batch-mode-findings.md Phase 0.
      const task = taskStore.createTask('Looped', '/cwd');
      taskStore.addSession(task.id, {
        tmuxSession: 'kookr-prior',
        agentType: 'claude-code',
        cwd: '/cwd',
        createdAt: new Date(),
        lastStatus: 'completed',
      });
      task.ralphLoop = {
        prompt: 'iterate',
        iterationCap: 5,
        currentIteration: 1,
        status: loopStatus,
        lastIterationStartedAt: 0,
        cumulativeIterations: 1,
      };

      const result = await reconcile(taskStore, backend);

      expect(result.tasksTerminated).toHaveLength(0);
      expect(taskStore.getTask(task.id)!.status).toBe('inProgress');
    },
  );

  test('Ralph exemption releases when loop transitions to a terminal status', async () => {
    // The exemption is dynamic, not sticky: once the loop completes (or
    // fails / is cancelled), the next reconcile sweep must terminate the
    // parent task as usual. Asserts the exemption flips off correctly.
    const task = taskStore.createTask('Looped', '/cwd');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-prior',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'completed',
    });
    task.ralphLoop = {
      prompt: 'iterate',
      iterationCap: 5,
      currentIteration: 1,
      status: 'running',
      lastIterationStartedAt: 0,
      cumulativeIterations: 1,
    };

    const firstResult = await reconcile(taskStore, backend);
    expect(firstResult.tasksTerminated).toHaveLength(0);
    expect(taskStore.getTask(task.id)!.status).toBe('inProgress');

    task.ralphLoop.status = 'completed';

    const secondResult = await reconcile(taskStore, backend);
    expect(secondResult.tasksTerminated).toContain(task.id);
    expect(taskStore.getTask(task.id)!.status).toBe('terminated');
  });

  test('Ralph loop in terminal status (cancelled/completed/failed) is NOT exempt from auto-termination', async () => {
    // Once the loop is done, the task should follow the normal lifecycle.
    const task = taskStore.createTask('Looped done', '/cwd');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-final',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'completed',
    });
    task.ralphLoop = {
      prompt: 'iterate',
      iterationCap: 5,
      currentIteration: 5,
      status: 'completed',
      lastIterationStartedAt: 0,
      cumulativeIterations: 5,
    };

    const result = await reconcile(taskStore, backend);

    expect(result.tasksTerminated).toContain(task.id);
    expect(taskStore.getTask(task.id)!.status).toBe('terminated');
  });

  test('completed and cancelled tasks are not re-completed', async () => {
    const completedTask = taskStore.createTask('Done task', '/cwd');
    taskStore.addSession(completedTask.id, {
      tmuxSession: 'kookr-ct',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'completed',
    });
    taskStore.completeTask(completedTask.id);

    const cancelledTask = taskStore.createTask('Cancelled task', '/cwd');
    taskStore.addSession(cancelledTask.id, {
      tmuxSession: 'kookr-cx',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'completed',
    });
    taskStore.cancelTask(cancelledTask.id);

    const result = await reconcile(taskStore, backend);

    expect(result.tasksTerminated).toHaveLength(0);
    expect(result.tasksCompleted).toHaveLength(0);
    expect(taskStore.getTask(completedTask.id)!.status).toBe('completed');
    expect(taskStore.getTask(cancelledTask.id)!.status).toBe('cancelled');
  });
});
