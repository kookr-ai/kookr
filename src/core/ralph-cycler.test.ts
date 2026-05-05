import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore, type RalphLoopState } from './tasks.js';
import { RalphCycler, type RalphCyclerIO } from './ralph-cycler.js';
import { iterationLogPath, type RalphIterationRecord } from './ralph-iteration-log.js';
import type { PredicateResult } from './ralph-predicate.js';
import type { RalphIterationDiffStats } from './ralph-iteration-log.js';

const baseLoop = (overrides: Partial<RalphLoopState> = {}): RalphLoopState => ({
  prompt: 'Continue working.',
  iterationCap: 5,
  currentIteration: 0,
  status: 'running',
  lastIterationStartedAt: 0,
  cumulativeIterations: 0,
  ...overrides,
});

interface RecordingIO {
  io: RalphCyclerIO;
  predicateCalls: Array<{ command: string; iteration: number }>;
  baselineCalls: Array<number>;
  diffCalls: Array<string>;
  appendCalls: Array<{ taskDir: string; record: RalphIterationRecord }>;
  setPredicateResult(r: PredicateResult): void;
  setDiffStats(stats: RalphIterationDiffStats | null): void;
  failBaseline(): void;
}

function buildIO(): RecordingIO {
  let nextPredicate: PredicateResult = {
    satisfied: false,
    exitCode: 1,
    timedOut: false,
    errored: false,
  };
  let nextDiffStats: RalphIterationDiffStats | null = {
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
  };
  let baselineFails = false;
  const predicateCalls: RecordingIO['predicateCalls'] = [];
  const baselineCalls: RecordingIO['baselineCalls'] = [];
  const diffCalls: RecordingIO['diffCalls'] = [];
  const appendCalls: RecordingIO['appendCalls'] = [];

  const io: RalphCyclerIO = {
    runPredicate: async (command, opts) => {
      predicateCalls.push({ command, iteration: opts.iteration });
      return nextPredicate;
    },
    createBaselineTag: async (n) => {
      baselineCalls.push(n);
      return baselineFails ? null : `ralph/iter-${n}-start`;
    },
    computeDiffStats: async (ref) => {
      diffCalls.push(ref);
      return nextDiffStats;
    },
    appendIterationRecord: async (taskDir, record) => {
      appendCalls.push({ taskDir, record });
    },
  };

  return {
    io,
    predicateCalls,
    baselineCalls,
    diffCalls,
    appendCalls,
    setPredicateResult: (r) => { nextPredicate = r; },
    setDiffStats: (stats) => { nextDiffStats = stats; },
    failBaseline: () => { baselineFails = true; },
  };
}

describe('RalphCycler', () => {
  let store: TaskStore;
  let workDir: string;

  beforeEach(async () => {
    store = new TaskStore();
    workDir = await mkdtemp(join(tmpdir(), 'ralph-cyc-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns noop when the task has no ralphLoop', async () => {
    const task = store.createTask('plain task', workDir);
    const cycler = new RalphCycler(buildIO().io);
    const action = await cycler.handleStop(store, { taskId: task.id, sessionId: 's1' });
    expect(action).toEqual({ kind: 'noop' });
  });

  it('returns noop when the loop status is not running', async () => {
    const task = store.createTask('paused task', workDir);
    task.ralphLoop = baseLoop({ status: 'paused' });
    const cycler = new RalphCycler(buildIO().io);
    const action = await cycler.handleStop(store, { taskId: task.id, sessionId: 's1' });
    expect(action).toEqual({ kind: 'noop' });
  });

  it('requests a fresh runtime launch and advances the counter on a normal continue', async () => {
    const task = store.createTask('looping', workDir);
    task.ralphLoop = baseLoop({ iterationCap: 5, currentIteration: 2 });
    const recorder = buildIO();
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, { taskId: task.id, sessionId: 's1', now: 1_000 });

    expect(action).toEqual({ kind: 'launch_fresh', taskId: task.id, text: 'Continue working.' });
    expect(task.ralphLoop?.currentIteration).toBe(3);
    expect(task.ralphLoop?.cumulativeIterations).toBe(1);
    expect(task.ralphLoop?.lastIterationStartedAt).toBe(1_000);
    expect(task.ralphLoop?.status).toBe('running');
    // Baseline for the just-started iteration was tagged.
    expect(recorder.baselineCalls).toEqual([3]);
    // Audit record was written for the iteration that just *finished* (#2).
    expect(recorder.appendCalls).toHaveLength(1);
    expect(recorder.appendCalls[0].record.iterationNumber).toBe(2);
    expect(recorder.appendCalls[0].record.exitReason).toBe('continued');
  });

  it('uses the latest loop prompt when launching the next iteration', async () => {
    const task = store.createTask('looping', workDir);
    task.ralphLoop = baseLoop({
      prompt: 'Edited prompt for the next turn.',
      iterationCap: 5,
      currentIteration: 2,
      cumulativeIterations: 7,
    });
    const cycler = new RalphCycler(buildIO().io);

    const action = await cycler.handleStop(store, { taskId: task.id, sessionId: 's1', now: 1_000 });

    expect(action).toEqual({ kind: 'launch_fresh', taskId: task.id, text: 'Edited prompt for the next turn.' });
    expect(task.ralphLoop?.currentIteration).toBe(3);
    expect(task.ralphLoop?.cumulativeIterations).toBe(8);
  });

  it('terminates with iteration_cap and does not inject when cap is reached', async () => {
    const task = store.createTask('at cap', workDir);
    task.ralphLoop = baseLoop({ iterationCap: 5, currentIteration: 5 });
    const recorder = buildIO();
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, { taskId: task.id, sessionId: 's1', now: 2_000 });

    expect(action).toEqual({ kind: 'terminate', reason: 'iteration_cap' });
    expect(task.ralphLoop?.status).toBe('completed');
    // Counter must not advance past the cap.
    expect(task.ralphLoop?.currentIteration).toBe(5);
    // Predicate is NOT consulted when the cap is hit (fast check first).
    expect(recorder.predicateCalls).toHaveLength(0);
    // The cap-reached iteration is recorded.
    expect(recorder.appendCalls[0].record.exitReason).toBe('iteration_cap');
  });

  it('terminates with predicate_satisfied when the predicate exits 0', async () => {
    const task = store.createTask('predicate stop', workDir);
    task.ralphLoop = baseLoop({
      iterationCap: 100,
      currentIteration: 3,
      stopPredicate: 'grep -q DONE prompt.md',
    });
    const recorder = buildIO();
    recorder.setPredicateResult({ satisfied: true, exitCode: 0, timedOut: false, errored: false });
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, { taskId: task.id, sessionId: 's1' });

    expect(action).toEqual({ kind: 'terminate', reason: 'predicate_satisfied' });
    expect(task.ralphLoop?.status).toBe('completed');
    expect(recorder.predicateCalls[0].command).toBe('grep -q DONE prompt.md');
    expect(recorder.predicateCalls[0].iteration).toBe(3);
    expect(recorder.appendCalls[0].record.exitReason).toBe('predicate_satisfied');
  });

  it('continues with predicate_timeout exit reason when the predicate times out', async () => {
    const task = store.createTask('slow predicate', workDir);
    task.ralphLoop = baseLoop({ iterationCap: 10, stopPredicate: 'sleep 30' });
    const recorder = buildIO();
    recorder.setPredicateResult({ satisfied: false, exitCode: null, timedOut: true, errored: false });
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, { taskId: task.id, sessionId: 's1' });

    expect(action.kind).toBe('launch_fresh');
    expect(recorder.appendCalls[0].record.exitReason).toBe('predicate_timeout');
    expect(task.ralphLoop?.currentIteration).toBe(1);
  });

  it('continues with predicate_error exit reason on spawn failure', async () => {
    const task = store.createTask('bad predicate', workDir);
    task.ralphLoop = baseLoop({ stopPredicate: '/nonexistent/binary' });
    const recorder = buildIO();
    recorder.setPredicateResult({
      satisfied: false,
      exitCode: null,
      timedOut: false,
      errored: true,
      errorMessage: 'spawn ENOENT',
    });
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, { taskId: task.id, sessionId: 's1' });

    expect(action.kind).toBe('launch_fresh');
    expect(recorder.appendCalls[0].record.exitReason).toBe('predicate_error');
  });

  it('skips predicate evaluation when stopPredicate is omitted', async () => {
    const task = store.createTask('cap-only', workDir);
    task.ralphLoop = baseLoop({ iterationCap: 10 });
    const recorder = buildIO();
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, { taskId: task.id, sessionId: 's1' });

    expect(action.kind).toBe('launch_fresh');
    expect(recorder.predicateCalls).toHaveLength(0);
    expect(recorder.appendCalls[0].record.exitReason).toBe('continued');
  });

  it('persists null gitBaselineRef when computeDiffStats returns null', async () => {
    const task = store.createTask('no git', workDir);
    task.ralphLoop = baseLoop({ currentIteration: 1 });
    const recorder = buildIO();
    recorder.setDiffStats(null);
    const cycler = new RalphCycler(recorder.io);

    await cycler.handleStop(store, { taskId: task.id, sessionId: 's1' });

    expect(recorder.appendCalls[0].record.gitBaselineRef).toBeNull();
    expect(recorder.appendCalls[0].record.diffStats).toBeNull();
  });

  it('persists the diffStats when the baseline diff succeeds', async () => {
    const task = store.createTask('with git', workDir);
    task.ralphLoop = baseLoop({ currentIteration: 4 });
    const recorder = buildIO();
    recorder.setDiffStats({ filesChanged: 2, insertions: 7, deletions: 1 });
    const cycler = new RalphCycler(recorder.io);

    await cycler.handleStop(store, { taskId: task.id, sessionId: 's1' });

    expect(recorder.appendCalls[0].record.gitBaselineRef).toBe('ralph/iter-4-start');
    expect(recorder.appendCalls[0].record.diffStats).toEqual({ filesChanged: 2, insertions: 7, deletions: 1 });
  });

  it('passes the cumulativeCostUsd through to the iteration record', async () => {
    const task = store.createTask('cost tracking', workDir);
    task.ralphLoop = baseLoop();
    const recorder = buildIO();
    const cycler = new RalphCycler(recorder.io);

    await cycler.handleStop(store, {
      taskId: task.id,
      sessionId: 's1',
      cumulativeCostUsd: 1.234,
    });

    expect(recorder.appendCalls[0].record.cumulativeCostUsd).toBe(1.234);
  });

  it('persists null cost when the source is unavailable (distinct from 0)', async () => {
    const task = store.createTask('no cost source', workDir);
    task.ralphLoop = baseLoop();
    const recorder = buildIO();
    const cycler = new RalphCycler(recorder.io);

    await cycler.handleStop(store, { taskId: task.id, sessionId: 's1' });

    expect(recorder.appendCalls[0].record.cumulativeCostUsd).toBeNull();
  });

  it('terminates with cost_cap when cumulative cost reaches the configured cap', async () => {
    const task = store.createTask('cost cap', workDir);
    task.ralphLoop = baseLoop({ iterationCap: 10, currentIteration: 2, costCapUsd: 3 });
    const recorder = buildIO();
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, {
      taskId: task.id,
      sessionId: 's1',
      cumulativeCostUsd: 3,
    });

    expect(action).toEqual({ kind: 'terminate', reason: 'cost_cap' });
    expect(task.ralphLoop?.status).toBe('completed');
    expect(recorder.appendCalls[0].record.exitReason).toBe('cost_cap');
  });

  it('fails closed when cost is unknown and does not stop solely on costCapUsd', async () => {
    const task = store.createTask('unknown cost', workDir);
    task.ralphLoop = baseLoop({ iterationCap: 10, costCapUsd: 0.01 });
    const recorder = buildIO();
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, {
      taskId: task.id,
      sessionId: 's1',
      cumulativeCostUsd: null,
    });

    expect(action.kind).toBe('launch_fresh');
    expect(task.ralphLoop?.status).toBe('running');
    expect(recorder.appendCalls[0].record.exitReason).toBe('continued');
  });

  it('tracks consecutive zero-diff iterations and terminates on configured convergence', async () => {
    const task = store.createTask('zero diff', workDir);
    task.ralphLoop = baseLoop({
      iterationCap: 10,
      currentIteration: 4,
      zeroDiffStreak: 1,
      zeroDiffConvergence: { consecutiveIterations: 2 },
    });
    const recorder = buildIO();
    recorder.setDiffStats({ filesChanged: 0, insertions: 0, deletions: 0 });
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, { taskId: task.id, sessionId: 's1' });

    expect(action).toEqual({ kind: 'terminate', reason: 'zero_diff_convergence' });
    expect(task.ralphLoop?.status).toBe('completed');
    expect(task.ralphLoop?.zeroDiffStreak).toBe(2);
    expect(recorder.appendCalls[0].record.exitReason).toBe('zero_diff_convergence');
  });

  it('resets zeroDiffStreak when diff stats show progress', async () => {
    const task = store.createTask('progress', workDir);
    task.ralphLoop = baseLoop({
      iterationCap: 10,
      zeroDiffStreak: 3,
      zeroDiffConvergence: { consecutiveIterations: 4 },
    });
    const recorder = buildIO();
    recorder.setDiffStats({ filesChanged: 1, insertions: 5, deletions: 0 });
    const cycler = new RalphCycler(recorder.io);

    await cycler.handleStop(store, { taskId: task.id, sessionId: 's1' });

    expect(task.ralphLoop?.zeroDiffStreak).toBe(0);
    expect(recorder.appendCalls[0].record.exitReason).toBe('continued');
  });

  it('does not count unavailable diff stats as zero-diff convergence', async () => {
    const task = store.createTask('no diff stats', workDir);
    task.ralphLoop = baseLoop({
      iterationCap: 10,
      zeroDiffStreak: 1,
      zeroDiffConvergence: { consecutiveIterations: 2 },
    });
    const recorder = buildIO();
    recorder.setDiffStats(null);
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, { taskId: task.id, sessionId: 's1' });

    expect(action.kind).toBe('launch_fresh');
    expect(task.ralphLoop?.zeroDiffStreak).toBe(0);
    expect(recorder.appendCalls[0].record.exitReason).toBe('continued');
  });

  it('keeps iteration cap ahead of predicate, cost, and convergence checks', async () => {
    const task = store.createTask('ordering cap', workDir);
    task.ralphLoop = baseLoop({
      iterationCap: 2,
      currentIteration: 2,
      stopPredicate: 'true',
      costCapUsd: 0.01,
      zeroDiffStreak: 1,
      zeroDiffConvergence: { consecutiveIterations: 2 },
    });
    const recorder = buildIO();
    recorder.setPredicateResult({ satisfied: true, exitCode: 0, timedOut: false, errored: false });
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, {
      taskId: task.id,
      sessionId: 's1',
      cumulativeCostUsd: 999,
    });

    expect(action).toEqual({ kind: 'terminate', reason: 'iteration_cap' });
    expect(recorder.predicateCalls).toHaveLength(0);
    expect(recorder.appendCalls[0].record.exitReason).toBe('iteration_cap');
  });

  it('keeps predicate_satisfied ahead of built-in cost and convergence exits', async () => {
    const task = store.createTask('ordering predicate', workDir);
    task.ralphLoop = baseLoop({
      iterationCap: 10,
      currentIteration: 2,
      stopPredicate: 'true',
      costCapUsd: 0.01,
      zeroDiffStreak: 1,
      zeroDiffConvergence: { consecutiveIterations: 2 },
    });
    const recorder = buildIO();
    recorder.setPredicateResult({ satisfied: true, exitCode: 0, timedOut: false, errored: false });
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, {
      taskId: task.id,
      sessionId: 's1',
      cumulativeCostUsd: 999,
    });

    expect(action).toEqual({ kind: 'terminate', reason: 'predicate_satisfied' });
    expect(recorder.appendCalls[0].record.exitReason).toBe('predicate_satisfied');
  });

  it('survives audit-log write failure without throwing', async () => {
    const task = store.createTask('flaky disk', workDir);
    task.ralphLoop = baseLoop();
    const recorder = buildIO();
    recorder.io.appendIterationRecord = async () => {
      throw new Error('disk full');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, { taskId: task.id, sessionId: 's1' });

    expect(action.kind).toBe('launch_fresh');
    expect(task.ralphLoop?.currentIteration).toBe(1);
    warn.mockRestore();
  });

  it('end-to-end: real iteration JSONL is appended via the default IO', async () => {
    const task = store.createTask('real jsonl', workDir);
    task.ralphLoop = baseLoop({ iterationCap: 100, currentIteration: 1 });
    // Use a partial real-IO setup: real iteration log writer, fake the rest
    // so the test stays hermetic but exercises the JSONL path end-to-end.
    const recorder = buildIO();
    const { appendIterationRecord } = await import('./ralph-iteration-log.js');
    recorder.io.appendIterationRecord = appendIterationRecord;
    const cycler = new RalphCycler(recorder.io);

    await cycler.handleStop(store, { taskId: task.id, sessionId: 's1', now: 555 });

    const raw = await readFile(iterationLogPath(workDir), 'utf-8');
    const parsed = JSON.parse(raw.trim()) as RalphIterationRecord;
    expect(parsed.iterationNumber).toBe(1);
    expect(parsed.endedAt).toBe(555);
    expect(parsed.exitReason).toBe('continued');
  });
});
