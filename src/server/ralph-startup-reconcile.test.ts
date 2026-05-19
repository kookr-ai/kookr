import { describe, expect, it, beforeEach, vi } from 'vitest';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import { AttentionQueue } from '../core/attention-queue.js';
import { Monitor } from '../core/monitor.js';
import { TokenTracker } from '../core/token-tracker.js';
import { TaskStore, type RalphLoopState } from '../core/tasks.js';
import type { RalphIterationRecord } from '../core/ralph-iteration-log.js';
import { RalphLoopService, type ReconcileRalphLoopsOptions } from './ralph-loop-service.js';

const baseLoop = (overrides: Partial<RalphLoopState> = {}): RalphLoopState => ({
  prompt: 'continue',
  iterationCap: 100,
  currentIteration: 7,
  status: 'running',
  lastIterationStartedAt: 1_700_000_000_000,
  cumulativeIterations: 7,
  ...overrides,
});

function createTaskForMutation(targetStore: TaskStore, ...args: unknown[]) {
  const created = (targetStore.createTask as (...innerArgs: unknown[]) => { id: string })(...args);
  const task = targetStore.getTaskForMutation(created.id);
  if (!task) throw new Error(`missing task ${created.id}`);
  return task;
}

interface Recorder {
  appended: Array<{ taskDir: string; record: RalphIterationRecord }>;
  appendIterationRecord: (taskDir: string, record: RalphIterationRecord) => Promise<void>;
}

function buildRecorder(): Recorder {
  const appended: Recorder['appended'] = [];
  return {
    appended,
    appendIterationRecord: async (taskDir, record) => {
      appended.push({ taskDir, record });
    },
  };
}

function reconcileStartupLoops(
  store: TaskStore,
  opts: ReconcileRalphLoopsOptions = {},
) {
  const service = new RalphLoopService({
    taskStore: store,
    monitor: new Monitor(store, new AttentionQueue()),
    serverCwd: '/repo',
    interactionLog: undefined,
    ralphCycler: undefined,
    terminalBackend: new FakeTerminalBackend(),
    tokenTracker: new TokenTracker(),
    launchFreshTaskSession: vi.fn(async () => 'unused-session'),
    completeTask: vi.fn(async () => undefined),
    broadcastToAll: () => {
      /* no-op */
    },
  });
  // Default the probe to today's lastStatus-only logic so existing tests that
  // don't register sessions in the fake backend still pass. Tests that exercise
  // the probe itself live in ralph-loop-service.test.ts and pass their own.
  const stub: ReconcileRalphLoopsOptions['probeStartupLiveness'] = async (task) =>
    task.sessions.find(
      (s) => s.lastStatus !== 'completed' && s.lastStatus !== 'aborted' && !s.crashRecovered,
    ) ?? null;
  return service.reconcileStartupLoops({ probeStartupLiveness: stub, ...opts });
}

describe('RalphLoopService.reconcileStartupLoops', () => {
  let store: TaskStore;
  let recorder: Recorder;
  const NOW = 1_700_000_999_000;
  const now = () => NOW;

  beforeEach(() => {
    store = new TaskStore();
    recorder = buildRecorder();
  });

  it('preserves a loop when at least one session is live', async () => {
    const task = createTaskForMutation(store, 'alive', '/cwd');
    task.ralphLoop = baseLoop();
    store.addSession(task.id, {
      tmuxSession: 'live-1',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      claudeSessionId: 'root-runtime',
      transcriptPath: '/root/transcript.jsonl',
      // no lastStatus set → considered live
    });

    const summary = await reconcileStartupLoops(store, {
      appendIterationRecord: recorder.appendIterationRecord,
      now,
    });

    expect(task.ralphLoop?.status).toBe('running');
    expect(task.ralphLoop).toMatchObject({
      ownerSessionId: 'live-1',
    });
    expect(recorder.appended).toHaveLength(0);
    expect(summary).toMatchObject({ examined: 1, preserved: 1, failed: 0 });
    expect(summary.perTask[0]).toMatchObject({
      taskId: task.id,
      outcome: 'preserved',
    });
  });

  it('marks loop as failed when the only session is completed', async () => {
    const task = createTaskForMutation(store, 'all done', '/cwd');
    task.ralphLoop = baseLoop({ currentIteration: 12 });
    store.addSession(task.id, {
      tmuxSession: 'dead-1',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'completed',
    });

    const summary = await reconcileStartupLoops(store, {
      appendIterationRecord: recorder.appendIterationRecord,
      now,
    });

    expect(task.ralphLoop?.status).toBe('failed');
    expect(recorder.appended).toHaveLength(1);
    expect(recorder.appended[0].record).toMatchObject({
      iterationNumber: 12,
      endedAt: NOW,
      exitReason: 'kookr_crash',
      cumulativeCostUsd: null,
      gitBaselineRef: null,
      diffStats: null,
    });
    expect(summary).toMatchObject({ examined: 1, preserved: 0, failed: 1 });
  });

  it('marks loop as failed when the only session is aborted', async () => {
    const task = createTaskForMutation(store, 'aborted', '/cwd');
    task.ralphLoop = baseLoop();
    store.addSession(task.id, {
      tmuxSession: 'dead-2',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'aborted',
    });

    const summary = await reconcileStartupLoops(store, {
      appendIterationRecord: recorder.appendIterationRecord,
      now,
    });

    expect(task.ralphLoop?.status).toBe('failed');
    expect(summary.failed).toBe(1);
  });

  it('marks loop as failed when the only session is a crash-recovered predecessor', async () => {
    // Predecessor sessions retain crashRecovered=true even with non-terminal
    // lastStatus, mirroring the predicate in task-persistence.ts. They should
    // not count as live.
    const task = createTaskForMutation(store, 'only crash predecessor', '/cwd');
    task.ralphLoop = baseLoop();
    store.addSession(task.id, {
      tmuxSession: 'pred-1',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      crashRecovered: true,
    });

    const summary = await reconcileStartupLoops(store, {
      appendIterationRecord: recorder.appendIterationRecord,
      now,
    });

    expect(task.ralphLoop?.status).toBe('failed');
    expect(summary.failed).toBe(1);
  });

  it('preserves a loop when one session is dead and a later one is live', async () => {
    // Mirrors the post-recovery state: original session aborted +
    // crashRecovered, replacement session is fresh.
    const task = createTaskForMutation(store, 'recovered', '/cwd');
    task.ralphLoop = baseLoop({
      ownerSessionId: 'pred',
    });
    store.addSession(task.id, {
      tmuxSession: 'pred',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'aborted',
      crashRecovered: true,
    });
    store.addSession(task.id, {
      tmuxSession: 'fresh',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      claudeSessionId: 'new-runtime',
      transcriptPath: '/new/transcript.jsonl',
      resumedFromCrash: true,
    });

    const summary = await reconcileStartupLoops(store, {
      appendIterationRecord: recorder.appendIterationRecord,
      now,
    });

    expect(task.ralphLoop?.status).toBe('running');
    expect(task.ralphLoop).toMatchObject({
      ownerSessionId: 'fresh',
    });
    expect(recorder.appended).toHaveLength(0);
    expect(summary).toMatchObject({ examined: 1, preserved: 1, failed: 0 });
  });

  it('transfers a stale owner to a fresh crash-recovery relaunch', async () => {
    const task = createTaskForMutation(store, 'fresh recovery', '/cwd');
    task.ralphLoop = baseLoop({
      ownerSessionId: 'pred',
    });
    store.addSession(task.id, {
      tmuxSession: 'pred',
      agentType: 'codex-cli',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'aborted',
      crashRecovered: true,
    });
    store.addSession(task.id, {
      tmuxSession: 'fresh',
      agentType: 'codex-cli',
      cwd: '/cwd',
      createdAt: new Date(),
      claudeSessionId: 'fresh-runtime',
      transcriptPath: '/fresh/transcript.jsonl',
    });

    const summary = await reconcileStartupLoops(store, {
      appendIterationRecord: recorder.appendIterationRecord,
      now,
    });

    expect(task.ralphLoop).toMatchObject({
      status: 'running',
      ownerSessionId: 'fresh',
    });
    expect(summary).toMatchObject({ examined: 1, preserved: 1, failed: 0 });
  });

  it('marks loop as failed when the task has no sessions at all', async () => {
    const task = createTaskForMutation(store, 'orphan', '/cwd');
    task.ralphLoop = baseLoop();
    // No addSession — task.sessions is the empty array.

    const summary = await reconcileStartupLoops(store, {
      appendIterationRecord: recorder.appendIterationRecord,
      now,
    });

    expect(task.ralphLoop?.status).toBe('failed');
    expect(summary.failed).toBe(1);
  });

  it.each(['paused', 'completed', 'failed', 'cancelled'] as const)(
    'does not touch a loop in %s status',
    async (status) => {
      const task = createTaskForMutation(store, `status ${status}`, '/cwd');
      task.ralphLoop = baseLoop({ status });
      // No live session — but the loop is not in `running`, so it must be
      // ignored regardless.

      const summary = await reconcileStartupLoops(store, {
        appendIterationRecord: recorder.appendIterationRecord,
        now,
      });

      expect(task.ralphLoop?.status).toBe(status);
      expect(recorder.appended).toHaveLength(0);
      expect(summary).toMatchObject({ examined: 0, preserved: 0, failed: 0 });
    },
  );

  it('skips tasks with no ralphLoop entirely', async () => {
    createTaskForMutation(store, 'plain', '/cwd');
    const summary = await reconcileStartupLoops(store, {
      appendIterationRecord: recorder.appendIterationRecord,
      now,
    });
    expect(summary).toMatchObject({ examined: 0, preserved: 0, failed: 0 });
  });

  it('still marks the loop failed even when the audit-log write throws', async () => {
    const task = createTaskForMutation(store, 'flaky disk', '/cwd');
    task.ralphLoop = baseLoop();
    store.addSession(task.id, {
      tmuxSession: 'dead',
      agentType: 'claude-code',
      cwd: '/cwd',
      createdAt: new Date(),
      lastStatus: 'completed',
    });

    const summary = await reconcileStartupLoops(store, {
      appendIterationRecord: async () => {
        throw new Error('disk full');
      },
      now,
    });

    // The audit failure is swallowed (warned), but the state machine still
    // closes the loop so it doesn't get re-examined on the next restart.
    expect(task.ralphLoop?.status).toBe('failed');
    expect(summary.failed).toBe(1);
  });

  it('handles many tasks with mixed outcomes correctly', async () => {
    // 2 alive + 1 dead + 1 paused (skipped) + 1 plain task
    const aliveA = createTaskForMutation(store, 'a', '/a');
    aliveA.ralphLoop = baseLoop({ currentIteration: 3 });
    store.addSession(aliveA.id, { tmuxSession: 'a-1', agentType: 'claude-code', cwd: '/a', createdAt: new Date() });

    const aliveB = createTaskForMutation(store, 'b', '/b');
    aliveB.ralphLoop = baseLoop({ currentIteration: 5 });
    store.addSession(aliveB.id, { tmuxSession: 'b-1', agentType: 'claude-code', cwd: '/b', createdAt: new Date() });

    const dead = createTaskForMutation(store, 'c', '/c');
    dead.ralphLoop = baseLoop({ currentIteration: 9 });
    store.addSession(dead.id, { tmuxSession: 'c-1', agentType: 'claude-code', cwd: '/c', createdAt: new Date(), lastStatus: 'completed' });

    const paused = createTaskForMutation(store, 'd', '/d');
    paused.ralphLoop = baseLoop({ status: 'paused', currentIteration: 1 });

    createTaskForMutation(store, 'plain', '/e');

    const summary = await reconcileStartupLoops(store, {
      appendIterationRecord: recorder.appendIterationRecord,
      now,
    });

    expect(summary).toMatchObject({ examined: 3, preserved: 2, failed: 1 });
    expect(recorder.appended).toHaveLength(1);
    expect(recorder.appended[0].record.iterationNumber).toBe(9);
    expect(aliveA.ralphLoop?.status).toBe('running');
    expect(aliveB.ralphLoop?.status).toBe('running');
    expect(dead.ralphLoop?.status).toBe('failed');
    expect(paused.ralphLoop?.status).toBe('paused');
  });
});
