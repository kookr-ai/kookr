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

  test('marks live session worktree missing_unexpectedly when registry no longer contains cwd', async () => {
    const task = taskStore.createTask('Fix bug', '/repo-missing');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-missing',
      agentType: 'claude-code',
      cwd: '/repo-missing',
      createdAt: new Date(),
      lastStatus: 'running',
      gitIsWorktree: true,
    });
    await backend.createSession(spec('kookr-missing'));

    const result = await reconcile(taskStore, backend, {
      byPath: () => null,
      snapshot: () => ({ entries: [], refreshedAt: new Date().toISOString(), lastError: null }),
    });

    expect(result.worktreesMissing).toContain('kookr-missing');
    expect(taskStore.getTask(task.id)!.sessions[0].worktreeHealth).toBe('missing_unexpectedly');
  });

  test('does not mark live non-worktree sessions missing when absent from the Kookr worktree registry', async () => {
    const task = taskStore.createTask('Fix bug', '/other-repo');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-regular-repo',
      agentType: 'claude-code',
      cwd: '/other-repo',
      createdAt: new Date(),
      lastStatus: 'running',
    });
    await backend.createSession(spec('kookr-regular-repo'));

    const result = await reconcile(taskStore, backend, {
      byPath: () => null,
      snapshot: () => ({ entries: [], refreshedAt: new Date().toISOString(), lastError: null }),
    });

    expect(result.worktreesMissing).not.toContain('kookr-regular-repo');
    expect(taskStore.getTask(task.id)!.sessions[0].worktreeHealth).toBeUndefined();
  });

  test('clears stale false-positive worktree health from live non-worktree sessions', async () => {
    const task = taskStore.createTask('Fix bug', '/other-repo');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-false-positive',
      agentType: 'claude-code',
      cwd: '/other-repo',
      createdAt: new Date(),
      lastStatus: 'running',
      worktreeHealth: 'missing_unexpectedly',
      worktreeHealthObservedAt: '2026-05-11T23:30:57.130Z',
    });
    await backend.createSession(spec('kookr-false-positive'));

    const result = await reconcile(taskStore, backend, {
      byPath: () => null,
      snapshot: () => ({ entries: [], refreshedAt: new Date().toISOString(), lastError: null }),
    });

    expect(result.worktreesChanged).toContain('kookr-false-positive');
    expect(taskStore.getTask(task.id)!.sessions[0]).toMatchObject({
      worktreeHealth: undefined,
      worktreeHealthObservedAt: undefined,
      worktreeRegistryStale: undefined,
    });
  });

  test('marks live session worktree stale when registry refresh failed', async () => {
    const task = taskStore.createTask('Fix bug', '/repo');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-stale',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date(),
      lastStatus: 'running',
      gitIsWorktree: true,
    });
    await backend.createSession(spec('kookr-stale'));

    const result = await reconcile(taskStore, backend, {
      byPath: () => null,
      snapshot: () => ({ entries: [], refreshedAt: new Date().toISOString(), lastError: 'git failed' }),
    });

    expect(result.worktreesStale).toContain('kookr-stale');
    expect(taskStore.getTask(task.id)!.sessions[0]).toMatchObject({
      worktreeHealth: 'stale',
      worktreeRegistryStale: true,
    });
  });

  test('updates git metadata when branch changed since launch', async () => {
    const task = taskStore.createTask('Fix bug', '/repo');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-branch',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date(),
      lastStatus: 'running',
      gitBranch: 'old-branch',
      gitCommit: '1111111',
      gitIsWorktree: true,
    });
    await backend.createSession(spec('kookr-branch'));

    const result = await reconcile(taskStore, backend, {
      byPath: () => ({
        path: '/repo',
        branch: 'new-branch',
        head: '2222222222222222222222222222222222222222',
        isDetached: false,
        isPrunable: false,
        isMain: false,
      }),
      snapshot: () => ({ entries: [], refreshedAt: new Date().toISOString(), lastError: null }),
    });

    expect(result.worktreesChanged).toContain('kookr-branch');
    expect(taskStore.getTask(task.id)!.sessions[0]).toMatchObject({
      gitBranch: 'new-branch',
      gitCommit: '2222222',
      worktreeHealth: 'ok',
    });
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

  test('dead session that finished a clean turn (completed_turn) auto-completes, not terminated', async () => {
    // #693: a spawned task whose agent emitted a normal Stop (idle, nothing
    // pending) and then went away is a graceful finish — reconcile completes it
    // directly instead of routing it to `terminated` for manual ack.
    const task = taskStore.createTask('Spawn successor then end', '/cwd');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-clean',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'running',
      lastTurnState: 'completed_turn',
    });

    // No backend session — the agent process is gone.
    const result = await reconcile(taskStore, backend);

    expect(result.markedCompleted).toContain('kookr-clean');
    expect(result.tasksCompleted).toContain(task.id);
    expect(result.tasksTerminated).not.toContain(task.id);
    expect(taskStore.getTask(task.id)!.status).toBe('completed');
  });

  test('dead session that never reported a turn state (undefined) terminates — default-to-crash', async () => {
    // The strict `=== 'completed_turn'` guard means a legacy/pre-#693 session
    // with no recorded turn state defaults to the conservative terminate path.
    const task = taskStore.createTask('No turn state recorded', '/cwd');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-legacy-noturn',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'running',
      // lastTurnState intentionally omitted
    });

    const result = await reconcile(taskStore, backend);

    expect(result.tasksTerminated).toContain(task.id);
    expect(result.tasksCompleted).not.toContain(task.id);
    expect(taskStore.getTask(task.id)!.status).toBe('terminated');
  });

  test('dead session that died mid-turn (running) still terminates for ack — D1 preserved', async () => {
    // A crash mid-turn carries no clean-finish signal, so the conservative
    // rfc-task-loss-prevention D1 behavior (→ terminated, user acks) is kept.
    const task = taskStore.createTask('Crashed mid-work', '/cwd');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-crash',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'running',
      lastTurnState: 'running',
    });

    const result = await reconcile(taskStore, backend);

    expect(result.tasksTerminated).toContain(task.id);
    expect(result.tasksCompleted).not.toContain(task.id);
    expect(taskStore.getTask(task.id)!.status).toBe('terminated');
  });

  test('dead session blocked on input/permission terminates for ack (not a clean finish)', async () => {
    const waiting = taskStore.createTask('Waiting on user', '/cwd');
    taskStore.addSession(waiting.id, {
      tmuxSession: 'kookr-waiting',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'running',
      lastTurnState: 'waiting_for_input',
    });

    const result = await reconcile(taskStore, backend);

    expect(result.tasksTerminated).toContain(waiting.id);
    expect(taskStore.getTask(waiting.id)!.status).toBe('terminated');
  });

  test('2-link spawn chain: link N auto-completes on clean finish while link N+1 keeps running', async () => {
    // The acceptance scenario: cycle N spawns cycle N+1 (parentTaskId chain) and
    // ends its own turn cleanly; its session is gone while N+1's is still live.
    // N must reach a terminal status without cascade-killing the live successor.
    const linkN = taskStore.createTask('Cycle N orchestrator', '/cwd');
    taskStore.addSession(linkN.id, {
      tmuxSession: 'kookr-cycleN',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'running',
      lastTurnState: 'completed_turn',
    });

    const linkN1 = taskStore.createTask({
      prompt: 'Cycle N+1 orchestrator',
      cwd: '/cwd',
      parentTaskId: linkN.id,
    });
    taskStore.addSession(linkN1.id, {
      tmuxSession: 'kookr-cycleN1',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'running',
    });

    // Only the successor's session is live.
    await backend.createSession(spec('kookr-cycleN1'));

    const result = await reconcile(taskStore, backend);

    // Link N reaches a terminal status (completed); link N+1 keeps running.
    expect(result.tasksCompleted).toContain(linkN.id);
    expect(taskStore.getTask(linkN.id)!.status).toBe('completed');
    expect(result.resumed).toContain('kookr-cycleN1');
    expect(taskStore.getTask(linkN1.id)!.status).toBe('inProgress');
    // The completed parent did not drag down its still-live child's session.
    expect(taskStore.getTask(linkN1.id)!.sessions[0].lastStatus).toBe('running');
  });

  test('clean-finish auto-complete is judged by the most recent session in a relaunch chain', async () => {
    // An earlier session may have finished cleanly, but if the newest leg died
    // mid-turn the task is a crash and must terminate.
    const task = taskStore.createTask('Relaunched after clean leg', '/cwd');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-old',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'completed',
      lastTurnState: 'completed_turn',
    });
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-new',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'running',
      lastTurnState: 'running',
    });

    const result = await reconcile(taskStore, backend);

    expect(result.tasksTerminated).toContain(task.id);
    expect(taskStore.getTask(task.id)!.status).toBe('terminated');
  });

  test('Ralph loop with a clean-finished dead session is still exempt (no completion mid-loop)', async () => {
    // The clean-finish path must not override the Ralph between-iterations
    // exemption: a `completed_turn` is exactly what a finished iteration looks
    // like, and completing the parent there would abort the loop.
    const task = taskStore.createTask('Looped clean turn', '/cwd');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-loop-clean',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'completed',
      lastTurnState: 'completed_turn',
    });
    taskStore.getTaskForMutation(task.id)!.ralphLoop = {
      prompt: 'iterate',
      iterationCap: 5,
      currentIteration: 1,
      status: 'running',
      lastIterationStartedAt: 0,
      cumulativeIterations: 1,
    };

    const result = await reconcile(taskStore, backend);

    expect(result.tasksCompleted).toHaveLength(0);
    expect(result.tasksTerminated).toHaveLength(0);
    expect(taskStore.getTask(task.id)!.status).toBe('inProgress');
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
    expect(taskStore.getTask(task.id)!.status).toBe('inProgress');

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
    const t = taskStore.getTaskForMutation(task.id)!;
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
    const t = taskStore.getTaskForMutation(task.id)!;
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
      taskStore.getTaskForMutation(task.id)!.ralphLoop = {
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
    taskStore.getTaskForMutation(task.id)!.ralphLoop = {
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

    taskStore.getTaskForMutation(task.id)!.ralphLoop!.status = 'completed';

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
    taskStore.getTaskForMutation(task.id)!.ralphLoop = {
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
