import { describe, test, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../core/tasks.js';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import type { SessionSpec } from '../adapters/terminal-backend.js';
import { readDispositionEntries } from '../core/disposition-ledger.js';
import { reconcile, reconcileStaleOpenLaunches } from './reconciliation.js';

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

  test('re-parks an in-progress probe whose attached session died during restart', async () => {
    const task = taskStore.createTask({
      prompt: 'probe dependency',
      cwd: '/cwd',
      launchAdmission: {
        status: 'probing',
        reason: 'half_open_probe_in_flight',
        dependencies: [{ dependency: 'kb', state: 'half_open' }],
        startedAt: new Date().toISOString(),
      },
    });
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-dead-probe',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'running',
    });

    const result = await reconcile(taskStore, backend);

    expect(result.markedCompleted).toContain('kookr-dead-probe');
    expect(result.tasksTerminated).not.toContain(task.id);
    expect(result.dependencyProbeCleanupSettled).toEqual([{
      dependencies: [{ dependency: 'kb', state: 'half_open' }],
      outcome: 'parked',
    }]);
    expect(taskStore.getTask(task.id)).toMatchObject({
      status: 'pending',
      launchAdmission: {
        status: 'parked',
        reason: 'dependency_degraded',
        dependencies: [{ dependency: 'kb', state: 'degraded' }],
      },
    });
  });

  test('clears a terminal probe cleanup marker only after its exact session is absent', async () => {
    const task = taskStore.createTask({
      prompt: 'cancelled probe cleanup',
      cwd: '/cwd',
      launchAdmission: {
        status: 'probing',
        reason: 'half_open_probe_in_flight',
        dependencies: [{ dependency: 'kb', state: 'half_open' }],
        startedAt: new Date().toISOString(),
        sessionId: 'kookr-terminal-probe',
      },
    });
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-terminal-probe',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });
    taskStore.cancelTask(task.id);

    const result = await reconcile(taskStore, backend);

    expect(result.dependencyProbeCleanupSettled).toEqual([{
      dependencies: [{ dependency: 'kb', state: 'half_open' }],
      outcome: 'released',
    }]);
    expect(taskStore.getTask(task.id)).toMatchObject({
      status: 'cancelled',
      launchAdmission: undefined,
      sessions: [expect.objectContaining({
        tmuxSession: 'kookr-terminal-probe',
        lastStatus: 'completed',
      })],
    });
  });

  test('does not resume (SessionBridge-reattach) a launch-abandoned master linked to a terminated launch_timeout task (issue #2500)', async () => {
    // A launch that timed out: the task is terminated with a launch_timeout
    // disposition and the late dtach master was linked via
    // recordAbandonedLaunchSession (lastStatus 'aborted').
    const task = taskStore.createTask('Cross-Repo Orchestrator', '/cwd');
    taskStore.recordAbandonedLaunchSession(task.id, {
      tmuxSession: 'kookr-24895049',
      agentType: 'grok-build',
      cwd: '/cwd',
      createdAt: new Date(),
    });
    taskStore.setDisposition(task.id, {
      reason: 'launch_timeout',
      at: new Date().toISOString(),
      source: 'launch-service',
      detail: 'Agent launch timed out after 180s',
    });
    taskStore.terminateTask(task.id);

    // The master is still live at restart.
    await backend.createSession(spec('kookr-24895049'));

    const result = await reconcile(taskStore, backend);

    // It must NOT be resumed: a resumed session is what post-restart-recovery
    // hands to SessionBridge to reattach. An aborted, abandoned master must not
    // get a reattached client across a prod restart.
    expect(result.resumed).not.toContain('kookr-24895049');
    // It is a live backend session the reaper will own (via the recorded
    // session) as a terminal-task-leak — reconcile lists it as an orphan only
    // for the informational log line, and never reattaches it.
    expect(result.orphans).toContain('kookr-24895049');
  });

  test('marks live session worktree missing_unexpectedly when registry has no entry AND directory is gone from disk', async () => {
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

    const result = await reconcile(
      taskStore,
      backend,
      {
        byPath: () => null,
        snapshot: () => ({ entries: [], refreshedAt: new Date().toISOString(), lastError: null }),
      },
      async () => false, // directory really gone from disk
    );

    expect(result.worktreesMissing).toContain('kookr-missing');
    expect(taskStore.getTask(task.id)!.sessions[0].worktreeHealth).toBe('missing_unexpectedly');
  });

  test('registry has no entry but directory exists on disk — NOT marked missing (F14)', async () => {
    // A registry refresh hiccup, or a cwd outside the refreshed repos, makes
    // the snapshot miss a healthy worktree. The on-disk check must veto the
    // alarm and self-heal the health to 'ok'.
    const task = taskStore.createTask('Fix bug', '/repo-alive');
    taskStore.addSession(task.id, {
      tmuxSession: 'kookr-alive-dir',
      agentType: 'claude-code',
      cwd: '/repo-alive',
      createdAt: new Date(),
      lastStatus: 'running',
      gitIsWorktree: true,
      worktreeHealth: 'missing_unexpectedly', // persisted false alarm from a prior sweep
    });
    await backend.createSession(spec('kookr-alive-dir'));

    const checkedPaths: string[] = [];
    const result = await reconcile(
      taskStore,
      backend,
      {
        byPath: () => null,
        snapshot: () => ({ entries: [], refreshedAt: new Date().toISOString(), lastError: null }),
      },
      async (path) => {
        checkedPaths.push(path);
        return true; // directory still exists on disk
      },
    );

    expect(checkedPaths).toContain('/repo-alive');
    expect(result.worktreesMissing).not.toContain('kookr-alive-dir');
    expect(taskStore.getTask(task.id)!.sessions[0].worktreeHealth).toBe('ok');
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
        isBare: false,
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

describe('reconcileStaleOpenLaunches (issue #1526 Phase C / #1528, boot-only)', () => {
  let taskStore: TaskStore;

  beforeEach(() => {
    taskStore = new TaskStore();
  });

  test('an open task with zero sessions and no launch reservation is terminated', () => {
    const task = taskStore.createTask('Wedged scheduled fire', '/cwd');
    expect(task.status).toBe('open');

    const terminated = reconcileStaleOpenLaunches(taskStore);

    expect(terminated).toEqual([task.id]);
    const after = taskStore.getTask(task.id)!;
    expect(after.status).toBe('terminated');
    expect(after.terminatedAt).toBeInstanceOf(Date);
    // Terminal task no longer occupies a capacity slot.
    expect(taskStore.getActiveCount()).toBe(0);
  });

  test('re-parks an interrupted durable recovery probe instead of terminating it', () => {
    const task = taskStore.createTask({
      prompt: 'probe provider',
      cwd: '/cwd',
      launchAdmission: {
        status: 'probing',
        reason: 'half_open_probe_in_flight',
        dependencies: [{ dependency: 'kb', state: 'half_open' }],
        startedAt: new Date().toISOString(),
      },
    });

    expect(reconcileStaleOpenLaunches(taskStore)).toEqual([]);
    expect(taskStore.getTask(task.id)).toMatchObject({
      status: 'pending',
      launchAdmission: {
        status: 'parked',
        reason: 'dependency_degraded',
        dependencies: [{ dependency: 'kb', state: 'degraded' }],
      },
    });
    expect(taskStore.getTask(task.id)?.disposition).toBeUndefined();
  });

  test('leaves a preallocated probe marker for startup recovery to reap exactly', () => {
    const task = taskStore.createTask({
      prompt: 'probe with expected terminal identity',
      cwd: '/cwd',
      launchAdmission: {
        status: 'probing',
        reason: 'half_open_probe_in_flight',
        dependencies: [{ dependency: 'kb', state: 'half_open' }],
        startedAt: new Date().toISOString(),
        sessionId: 'kookr-expected-probe',
      },
    });

    expect(reconcileStaleOpenLaunches(taskStore)).toEqual([]);
    expect(taskStore.getTask(task.id)).toMatchObject({
      status: 'open',
      launchAdmission: {
        status: 'probing',
        sessionId: 'kookr-expected-probe',
      },
    });
    expect(taskStore.getTask(task.id)?.disposition).toBeUndefined();
  });

  test('issue #1588: the terminated task carries a queryable stale_open_launch disposition', () => {
    const task = taskStore.createTask('Launcher died at boot', '/cwd');

    reconcileStaleOpenLaunches(taskStore);

    const after = taskStore.getTask(task.id)!;
    expect(after.status).toBe('terminated');
    // No task reaches a terminal state silently: the disposition explains WHY
    // (its launcher process died with the previous run) and carries a timestamp.
    expect(after.disposition?.reason).toBe('stale_open_launch');
    expect(after.disposition?.source).toBe('startup-reconcile');
    expect(after.disposition?.at).toBeTruthy();
    expect(() => new Date(after.disposition!.at).toISOString()).not.toThrow();
  });

  test('issue #1588: an in-process disposition reason is preserved (first-write-wins) when reconcile later terminates it', () => {
    const task = taskStore.createTask('Disposed then reconciled', '/cwd');
    // Simulate the launch-service having already disposed it (e.g. launch_error)
    // on a task that then survived a restart still in `open` status.
    taskStore.setDisposition(task.id, {
      reason: 'launch_error',
      at: new Date().toISOString(),
      source: 'launch-service',
      detail: 'adapter threw',
    });

    reconcileStaleOpenLaunches(taskStore);

    const after = taskStore.getTask(task.id)!;
    expect(after.status).toBe('terminated');
    // First-write-wins: reconcile does not overwrite the original root cause.
    expect(after.disposition?.reason).toBe('launch_error');
  });

  test('a legitimately mid-flight launch (fresh beginLaunch reservation) is NOT touched', () => {
    // The discriminator: a live launch holds a fresh in-memory reservation.
    // At boot the reservation map is empty by construction (it is never
    // persisted), so nothing is protected then — which is exactly right.
    const task = taskStore.createTask('Launch in flight', '/cwd');
    expect(taskStore.beginLaunch(task.id)).toBe(true);

    const terminated = reconcileStaleOpenLaunches(taskStore);

    expect(terminated).toEqual([]);
    expect(taskStore.getTask(task.id)!.status).toBe('open');
  });

  test('open tasks WITH sessions and pending tasks are left to their own paths', () => {
    const withSession = taskStore.createTask('Has session', '/cwd');
    taskStore.addSession(withSession.id, {
      tmuxSession: 'kookr-live',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
    });
    // addSession flips open→inProgress in some paths; force a task that is
    // open with a session record via a fresh store state check instead.
    const pending = taskStore.createTask('Queued at capacity', '/cwd');
    taskStore.pendTask(pending.id);

    const terminated = reconcileStaleOpenLaunches(taskStore);

    expect(terminated).toEqual([]);
    expect(taskStore.getTask(pending.id)!.status).toBe('pending');
    expect(['open', 'inProgress']).toContain(taskStore.getTask(withSession.id)!.status);
  });

  test('terminal and inProgress tasks are never candidates', () => {
    const done = taskStore.createTask('Done', '/cwd');
    taskStore.startTask(done.id);
    taskStore.completeTask(done.id);
    const running = taskStore.createTask('Running', '/cwd');
    taskStore.startTask(running.id);

    expect(reconcileStaleOpenLaunches(taskStore)).toEqual([]);
    expect(taskStore.getTask(done.id)!.status).toBe('completed');
    expect(taskStore.getTask(running.id)!.status).toBe('inProgress');
  });

  // Issue #1554: the killed-launcher/reconcile path must never leave a task
  // terminal with name=null.
  test('a terminated stale-launch task ends terminal with a non-null name', () => {
    const task = taskStore.createTask('Deploy restart killed this launcher', '/cwd');

    const terminated = reconcileStaleOpenLaunches(taskStore);

    expect(terminated).toEqual([task.id]);
    const after = taskStore.getTask(task.id)!;
    expect(after.status).toBe('terminated');
    expect(after.name).toBe('Deploy restart killed this launcher');
    expect(after.name).toBeTruthy();
  });

  test('a legacy unnamed task gets the deterministic fallback name before termination (backstop)', () => {
    // Simulate a task persisted before creation-time naming existed: force the
    // stored record back to nameless, as a legacy tasks.json load would.
    const task = taskStore.createTask('Legacy launch persisted before #1554', '/cwd');
    const stored = taskStore.getTaskForMutation(task.id)!;
    delete stored.name;
    delete stored.autoNamed;
    expect(taskStore.getTask(task.id)!.name).toBeUndefined();

    const terminated = reconcileStaleOpenLaunches(taskStore);

    expect(terminated).toEqual([task.id]);
    const after = taskStore.getTask(task.id)!;
    expect(after.status).toBe('terminated');
    // No code path reaches a terminal state with name=null.
    expect(after.name).toBe('Legacy launch persisted before #1554');
    expect(after.name).toBeTruthy();
  });
});

/**
 * The ledger write in `reconcileStaleOpenLaunches` is fire-and-forget (the
 * function itself is synchronous, so it cannot await the write) — poll
 * instead of asserting immediately after the call returns.
 */
async function waitForDispositionEntries(ledgerPath: string, expectedCount: number, timeoutMs = 2000) {
  const start = Date.now();
  let entries = await readDispositionEntries(ledgerPath);
  while (entries.length < expectedCount && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    entries = await readDispositionEntries(ledgerPath);
  }
  return entries;
}

// Integration coverage for issue #1540's write site at this call site: this
// is the only test in the file that wires `dispositionLedgerPath` and reads
// the ledger back off real disk. Every test above passes even if the
// `appendDispositionEntry` call inside `reconcileStaleOpenLaunches` (or the
// `index.ts` call site that used to omit the path entirely — the blocking
// review defect this closes) is deleted; this one does not.
describe('reconcileStaleOpenLaunches — disposition ledger (issue #1540 review fix)', () => {
  test('records an obsolete disposition-ledger entry for a stale-open termination', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Wedged scheduled fire', '/cwd');
    const ledgerPath = join(await mkdtemp(join(tmpdir(), 'kookr-disposition-')), 'disposition.jsonl');

    const terminated = reconcileStaleOpenLaunches(taskStore, ledgerPath);
    expect(terminated).toEqual([task.id]);

    const entries = await waitForDispositionEntries(ledgerPath, 1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      schemaVersion: 'disposition-ledger.v1',
      taskId: task.id,
      disposition: 'obsolete',
      source: 'startup-reconcile',
    });
    expect(entries[0].detail).toContain('obsolete-because');
    expect(entries[0].incidentId).toContain('stale-open-launch-');
  });

  test('no dispositionLedgerPath → no ledger write attempted (no-op convention)', async () => {
    const taskStore = new TaskStore();
    taskStore.createTask('Wedged scheduled fire', '/cwd');

    // Must not throw even though no path was supplied.
    expect(() => reconcileStaleOpenLaunches(taskStore)).not.toThrow();
  });
});
