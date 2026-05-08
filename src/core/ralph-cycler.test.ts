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
    expect(action).toEqual({ kind: 'noop', events: [] });
  });

  it('returns noop when the loop status is not running', async () => {
    const task = store.createTask('paused task', workDir);
    task.ralphLoop = baseLoop({ status: 'paused' });
    const cycler = new RalphCycler(buildIO().io);
    const action = await cycler.handleStop(store, { taskId: task.id, sessionId: 's1' });
    expect(action).toEqual({ kind: 'noop', events: [] });
  });

  it('requests a fresh runtime launch and advances the counter on a normal continue', async () => {
    const task = store.createTask('looping', workDir);
    task.ralphLoop = baseLoop({ iterationCap: 5, currentIteration: 2 });
    const recorder = buildIO();
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, { taskId: task.id, sessionId: 's1', now: 1_000 });

    expect(action).toEqual({ kind: 'launch_fresh', taskId: task.id, text: 'Continue working.', events: [] });
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

    expect(action).toEqual({ kind: 'launch_fresh', taskId: task.id, text: 'Edited prompt for the next turn.', events: [] });
    expect(task.ralphLoop?.currentIteration).toBe(3);
    expect(task.ralphLoop?.cumulativeIterations).toBe(8);
  });

  it('terminates with iteration_cap and does not inject when cap is reached', async () => {
    const task = store.createTask('at cap', workDir);
    task.ralphLoop = baseLoop({ iterationCap: 5, currentIteration: 5 });
    const recorder = buildIO();
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, { taskId: task.id, sessionId: 's1', now: 2_000 });

    expect(action).toEqual({ kind: 'terminate', reason: 'iteration_cap', events: [] });
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

    expect(action).toEqual({ kind: 'terminate', reason: 'predicate_satisfied', events: [] });
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

    expect(action).toEqual({ kind: 'terminate', reason: 'cost_cap', events: [] });
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

    expect(action).toEqual({ kind: 'terminate', reason: 'zero_diff_convergence', events: [] });
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

    expect(action).toEqual({ kind: 'terminate', reason: 'iteration_cap', events: [] });
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

    expect(action).toEqual({ kind: 'terminate', reason: 'predicate_satisfied', events: [] });
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

describe('RalphCycler — stall handling (PR2)', () => {
  let store: TaskStore;
  let workDir: string;

  beforeEach(async () => {
    store = new TaskStore();
    workDir = await mkdtemp(join(tmpdir(), 'ralph-cyc-stall-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('verdict.complete + no predicate → terminate predicate_satisfied with verdict on the iteration record', async () => {
    const recorder = buildIO();
    const task = store.createTask('verdict complete', workDir);
    task.ralphLoop = baseLoop({ currentIteration: 1, iterationCap: 5 });
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, {
      taskId: task.id,
      sessionId: 's1',
      verdict: { verdict: 'complete', iteration: 1, reason: 'all done' },
    });

    expect(action.kind).toBe('terminate');
    expect((action as { reason?: string }).reason).toBe('predicate_satisfied');
    expect(recorder.appendCalls[0].record.verdict).toEqual({ verdict: 'complete', iteration: 1, reason: 'all done' });
  });

  it('verdict.complete + clean predicate exit ≠ 0 → continue with predicate_disagree event', async () => {
    const recorder = buildIO();
    recorder.setPredicateResult({ satisfied: false, exitCode: 1, timedOut: false, errored: false });
    const task = store.createTask('disagree', workDir);
    task.ralphLoop = baseLoop({ stopPredicate: 'false', currentIteration: 2, iterationCap: 5 });
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, {
      taskId: task.id,
      sessionId: 's1',
      verdict: { verdict: 'complete', iteration: 2 },
    });

    expect(action.kind).toBe('launch_fresh');
    expect(action.events).toContainEqual(expect.objectContaining({ type: 'ralph_predicate_disagree', taskId: task.id, iteration: 2, predicateExitCode: 1 }));
    expect(task.ralphLoop?.status).toBe('running');
  });

  it('verdict.complete + predicate errored → terminate predicate_satisfied (predicate could not speak)', async () => {
    // Distinguishes the `errored: true` branch from clean exit ≠ 0. A regression
    // that swaps these (e.g. drops `&& !errored` from the disagreement guard)
    // would cause real predicate spawn failures to BLOCK agent completion;
    // this test catches that direction.
    const recorder = buildIO();
    recorder.setPredicateResult({ satisfied: false, exitCode: null, timedOut: false, errored: true });
    const task = store.createTask('predicate errored', workDir);
    task.ralphLoop = baseLoop({ stopPredicate: 'no-such-cmd', currentIteration: 1, iterationCap: 5 });
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, {
      taskId: task.id,
      sessionId: 's1',
      verdict: { verdict: 'complete', iteration: 1 },
    });

    expect(action.kind).toBe('terminate');
    expect((action as { reason?: string }).reason).toBe('predicate_satisfied');
  });

  it('verdict.complete + predicate timeout → terminate predicate_satisfied (predicate could not speak)', async () => {
    const recorder = buildIO();
    recorder.setPredicateResult({ satisfied: false, exitCode: null, timedOut: true, errored: false });
    const task = store.createTask('predicate timeout', workDir);
    task.ralphLoop = baseLoop({ stopPredicate: 'sleep 10', currentIteration: 1, iterationCap: 5 });
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, {
      taskId: task.id,
      sessionId: 's1',
      verdict: { verdict: 'complete', iteration: 1 },
    });

    expect(action.kind).toBe('terminate');
    expect((action as { reason?: string }).reason).toBe('predicate_satisfied');
  });

  it('verdict.stalled (single-target, default config) burns the target on threshold and terminates target_stalled', async () => {
    const recorder = buildIO();
    const task = store.createTask('single stall', workDir);
    task.ralphLoop = baseLoop({
      currentIteration: 1, iterationCap: 10,
      stallConfig: { loopShape: 'single-target', consecutiveStallsForSingleTargetTermination: 2 },
    });
    const cycler = new RalphCycler(recorder.io);

    // First stall — records but does not terminate.
    let action = await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's1',
      verdict: { verdict: 'stalled', iteration: 1, target: '154', reason: 'tests fail' },
    });
    expect(action.kind).toBe('launch_fresh');
    expect(task.ralphLoop?.burnedOutTargets).toHaveLength(1);
    expect(task.ralphLoop?.burnedOutTargets?.[0].consecutiveStallCount).toBe(1);
    // Second stall on same target — threshold reached → terminate target_stalled.
    // The burn-transition fires `ralph_target_burned` exactly once (this iteration),
    // not on every stall after burn — assert content too so a future drop-the-event
    // regression doesn't pass on presence-only checks.
    action = await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's2',
      verdict: { verdict: 'stalled', iteration: 2, target: '154', reason: 'still failing' },
    });
    expect(action.kind).toBe('terminate');
    expect((action as { reason?: string }).reason).toBe('target_stalled');
    expect(action.events).toContainEqual(expect.objectContaining({
      type: 'ralph_target_burned',
      target: '154',
      iteration: 2,
      stallCount: 2,
      reason: 'still failing',
    }));
  });

  it('verdict.stalled with permanent:true burns at count=1 and terminates single-target loops immediately', async () => {
    const recorder = buildIO();
    const task = store.createTask('permanent stall', workDir);
    task.ralphLoop = baseLoop({
      currentIteration: 1, iterationCap: 10,
      // Use defaults: count threshold = 2, termination threshold = 3. Without
      // permanent:true this would take 3 iterations to terminate.
      stallConfig: { loopShape: 'single-target' },
    });
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's1',
      verdict: {
        verdict: 'stalled', iteration: 1, target: '154',
        reason: 'umbrella tracking issue',
        blockers: ['umbrella_tracking_issue_no_implementable_unit'],
        permanent: true,
      },
    });
    expect(action.kind).toBe('terminate');
    expect((action as { reason?: string }).reason).toBe('target_stalled');
    expect(task.ralphLoop?.burnedOutTargets?.[0]).toMatchObject({
      target: '154', burned: true, consecutiveStallCount: 1,
    });
    expect(action.events).toContainEqual(expect.objectContaining({
      type: 'ralph_target_burned', target: '154', iteration: 1, stallCount: 1,
    }));
  });

  it('verdict.stalled with permanent:true in multi-target burns at count=1 but does not auto-terminate', async () => {
    const recorder = buildIO();
    const task = store.createTask('permanent multi', workDir);
    task.ralphLoop = baseLoop({
      currentIteration: 1, iterationCap: 10,
      stallConfig: { loopShape: 'multi-target', consecutiveStallsPerTarget: 2 },
    });
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's1',
      verdict: {
        verdict: 'stalled', iteration: 1, target: '154',
        reason: 'umbrella', permanent: true,
      },
    });
    // Multi-target loop continues so the agent can pick a different target;
    // the engine has already burned #154 so Step 0c.5's
    // {{ralph.burnedOutTargets}} filter excludes it next iteration.
    expect(action.kind).toBe('launch_fresh');
    expect(task.ralphLoop?.burnedOutTargets?.[0]).toMatchObject({
      target: '154', burned: true, consecutiveStallCount: 1, permanent: true,
    });
  });

  it('multi-target with declaredTargets: terminates all_targets_stalled when each declared target is permanent-burned at count=1', async () => {
    const recorder = buildIO();
    const task = store.createTask('all permanent', workDir);
    task.ralphLoop = baseLoop({
      currentIteration: 1, iterationCap: 100,
      // Default consecutiveStallsPerTarget=2; the test proves permanent:true
      // composes with the all-declared-burned check at count=1, not 2.
      stallConfig: { loopShape: 'multi-target', declaredTargets: ['149', '154'] },
    });
    const cycler = new RalphCycler(recorder.io);

    let action = await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's1',
      verdict: { verdict: 'stalled', iteration: 1, target: '149', reason: 'a', permanent: true },
    });
    expect(action.kind).toBe('launch_fresh');

    action = await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's2',
      verdict: { verdict: 'stalled', iteration: 2, target: '154', reason: 'b', permanent: true },
    });
    expect(action.kind).toBe('terminate');
    expect((action as { reason?: string }).reason).toBe('all_targets_stalled');
  });

  it('applyDecay skips permanent-burned targets so the structural-unfitness claim stays sticky', async () => {
    const recorder = buildIO();
    const task = store.createTask('permanent decay', workDir);
    // Multi-target with no declaredTargets so the loop doesn't terminate via
    // `all_targets_stalled` and we get to observe decay at iter 5.
    task.ralphLoop = baseLoop({
      currentIteration: 1, iterationCap: 100,
      stallConfig: {
        loopShape: 'multi-target',
        consecutiveStallsPerTarget: 1, // make non-permanent burns trivial to trigger
        burnedTargetDecayIterations: 2,
      },
    });
    const cycler = new RalphCycler(recorder.io);

    // Burn #149 via permanent:true at iter 1.
    await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's1',
      verdict: { verdict: 'stalled', iteration: 1, target: '149', reason: 'a', permanent: true },
    });
    // Burn #154 via the count threshold at iter 2 (consecutiveStallsPerTarget=1).
    await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's2',
      verdict: { verdict: 'stalled', iteration: 2, target: '154', reason: 'b' },
    });
    // Iter 5 is `decay` past iter 2 for both rows. #154 (count-burned) decays;
    // #149 (permanent-burned) does NOT — the schema promises stickiness.
    // Use a `progress` verdict on a third target to keep the loop alive without
    // touching the burned rows, so applyDecay runs at iter 5.
    task.ralphLoop!.currentIteration = 5;
    await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's3',
      verdict: { verdict: 'progress', iteration: 5, target: '999', reason: 'unrelated' },
    });
    const rows = task.ralphLoop?.burnedOutTargets ?? [];
    expect(rows.find((r) => r.target === '149')).toMatchObject({ burned: true, permanent: true });
    expect(rows.find((r) => r.target === '154')).toMatchObject({ burned: false });
  });

  it('progress verdict clears the permanent flag (agent self-correction overrides)', async () => {
    const recorder = buildIO();
    const task = store.createTask('permanent then progress', workDir);
    task.ralphLoop = baseLoop({
      currentIteration: 1, iterationCap: 10,
      stallConfig: { loopShape: 'multi-target' },
    });
    const cycler = new RalphCycler(recorder.io);

    await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's1',
      verdict: { verdict: 'stalled', iteration: 1, target: '154', reason: 'umbrella', permanent: true },
    });
    expect(task.ralphLoop?.burnedOutTargets?.[0]).toMatchObject({ burned: true, permanent: true });

    await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's2',
      verdict: { verdict: 'progress', iteration: 2, target: '154', reason: 'shipped a PR' },
    });
    const row = task.ralphLoop?.burnedOutTargets?.[0];
    expect(row?.burned).toBe(false);
    expect(row?.permanent).toBeUndefined();
  });

  it('verdict.stalled (multi-target, no declaredTargets) records but never auto-terminates on stall alone', async () => {
    const recorder = buildIO();
    const task = store.createTask('multi stall', workDir);
    task.ralphLoop = baseLoop({
      currentIteration: 1, iterationCap: 10,
      stallConfig: { loopShape: 'multi-target', consecutiveStallsPerTarget: 2 },
    });
    const cycler = new RalphCycler(recorder.io);

    for (let i = 1; i <= 4; i++) {
      const action = await cycler.handleStop(store, {
        taskId: task.id, sessionId: `s${i}`,
        verdict: { verdict: 'stalled', iteration: i, target: '154', reason: 'r' },
        now: 1_000_000_000_000 + i * 1000,
      });
      // Multi-target with no declaredTargets keeps running until iteration cap.
      expect(action.kind).toBe('launch_fresh');
    }
    expect(task.ralphLoop?.burnedOutTargets?.[0].burned).toBe(true);
    expect(task.ralphLoop?.burnedOutTargets?.[0].consecutiveStallCount).toBe(4);
  });

  it('multi-target with declaredTargets: terminates all_targets_stalled when every declared target is burned', async () => {
    const recorder = buildIO();
    const task = store.createTask('all burned', workDir);
    task.ralphLoop = baseLoop({
      currentIteration: 1, iterationCap: 100,
      stallConfig: {
        loopShape: 'multi-target',
        consecutiveStallsPerTarget: 1, // burn-on-first-stall to keep the test short
        declaredTargets: ['149', '154'],
      },
    });
    const cycler = new RalphCycler(recorder.io);

    // First target burned, second still alive.
    let action = await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's1',
      verdict: { verdict: 'stalled', iteration: 1, target: '149', reason: 'a' },
    });
    expect(action.kind).toBe('launch_fresh');
    // Second target burned → all declared burned → terminate.
    action = await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's2',
      verdict: { verdict: 'stalled', iteration: 2, target: '154', reason: 'b' },
    });
    expect(action.kind).toBe('terminate');
    expect((action as { reason?: string }).reason).toBe('all_targets_stalled');
  });

  it('canonicalizes target keys: "#154" and " 154 " accrue on the same row', async () => {
    const recorder = buildIO();
    const task = store.createTask('canonical', workDir);
    task.ralphLoop = baseLoop({
      currentIteration: 1, iterationCap: 10,
      stallConfig: { loopShape: 'single-target', consecutiveStallsForSingleTargetTermination: 99 },
    });
    const cycler = new RalphCycler(recorder.io);

    await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's1',
      verdict: { verdict: 'stalled', iteration: 1, target: '#154', reason: 'a' },
    });
    await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's2',
      verdict: { verdict: 'stalled', iteration: 2, target: ' 154 ', reason: 'b' },
    });
    expect(task.ralphLoop?.burnedOutTargets).toHaveLength(1);
    expect(task.ralphLoop?.burnedOutTargets?.[0].target).toBe('154');
    expect(task.ralphLoop?.burnedOutTargets?.[0].consecutiveStallCount).toBe(2);
  });

  it('progress verdict for the same canonicalized target un-burns it and emits ralph_target_unburned', async () => {
    const recorder = buildIO();
    const task = store.createTask('unburn', workDir);
    // No declaredTargets so the all-burned terminator can't race the un-burn
    // path. Use multi-target so single-target threshold doesn't terminate either.
    task.ralphLoop = baseLoop({
      currentIteration: 1, iterationCap: 100,
      stallConfig: { loopShape: 'multi-target', consecutiveStallsPerTarget: 2 },
    });
    const cycler = new RalphCycler(recorder.io);

    // Burn the target across two iterations.
    await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's1',
      verdict: { verdict: 'stalled', iteration: 1, target: '154', reason: 'a' },
    });
    await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's2',
      verdict: { verdict: 'stalled', iteration: 2, target: '154', reason: 'b' },
    });
    expect(task.ralphLoop?.burnedOutTargets?.[0].burned).toBe(true);
    expect(task.ralphLoop?.status).toBe('running');

    // Agent reports progress on the burned target — un-burns it but the row
    // survives so totalStallCount / firstStalledAtIteration history is kept
    // for forensic + dashboard use across burn cycles.
    const action = await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's3',
      verdict: { verdict: 'progress', iteration: 3, target: '#154' },
    });
    expect(action.kind).toBe('launch_fresh');
    const row = task.ralphLoop?.burnedOutTargets?.find((t) => t.target === '154');
    expect(row).toBeDefined();
    expect(row!.burned).toBe(false);
    expect(row!.consecutiveStallCount).toBe(0);
    // History preserved across the burn cycle.
    expect(row!.totalStallCount).toBe(2);
    expect(row!.firstStalledAtIteration).toBe(1);
    expect(action.events).toContainEqual(expect.objectContaining({
      type: 'ralph_target_unburned', target: '154', via: 'progress_verdict',
    }));
  });

  it('after un-burn → re-stall: row resets consecutive count but keeps totalStallCount + firstStalledAtIteration', async () => {
    const recorder = buildIO();
    const task = store.createTask('un-burn re-stall', workDir);
    task.ralphLoop = baseLoop({
      currentIteration: 1, iterationCap: 100,
      stallConfig: { loopShape: 'multi-target', consecutiveStallsPerTarget: 2 },
    });
    const cycler = new RalphCycler(recorder.io);

    // Burn at iters 1, 2.
    await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's1',
      verdict: { verdict: 'stalled', iteration: 1, target: '154', reason: 'a' },
    });
    await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's2',
      verdict: { verdict: 'stalled', iteration: 2, target: '154', reason: 'b' },
    });
    // Un-burn at iter 3.
    await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's3',
      verdict: { verdict: 'progress', iteration: 3, target: '154' },
    });
    // Re-stall at iter 4.
    await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's4',
      verdict: { verdict: 'stalled', iteration: 4, target: '154', reason: 'c' },
    });

    const row = task.ralphLoop?.burnedOutTargets?.[0];
    expect(row).toBeDefined();
    expect(row!.consecutiveStallCount).toBe(1); // fresh streak
    expect(row!.burned).toBe(false);            // not burned yet (1 < 2)
    expect(row!.totalStallCount).toBe(3);       // 2 prior + 1 new
    expect(row!.firstStalledAtIteration).toBe(1); // unchanged
  });

  it('decay un-burns a stale target after burnedTargetDecayIterations elapsed', async () => {
    const recorder = buildIO();
    const task = store.createTask('decay', workDir);
    task.ralphLoop = baseLoop({
      currentIteration: 5, iterationCap: 100,
      burnedOutTargets: [{
        target: '154',
        consecutiveStallCount: 2,
        totalStallCount: 2,
        firstStalledAtIteration: 1,
        lastStallReason: 'old',
        lastStallBlockers: [],
        burned: true,
        lastAttemptedIteration: 1, // 5 - 1 = 4 iterations stale
      }],
      stallConfig: { loopShape: 'multi-target', burnedTargetDecayIterations: 3 },
    });
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, { taskId: task.id, sessionId: 's1' });
    expect(action.kind).toBe('launch_fresh');
    // Row survives un-burn (history preserved) but `burned` is false.
    const row = task.ralphLoop?.burnedOutTargets?.find((t) => t.target === '154');
    expect(row?.burned).toBe(false);
    expect(row?.consecutiveStallCount).toBe(0);
    expect(action.events).toContainEqual(expect.objectContaining({
      type: 'ralph_target_unburned', target: '154', via: 'decay',
    }));
  });

  it('iteration cost cap: single hit warns, two consecutive hits terminate iteration_cost_cap', async () => {
    const recorder = buildIO();
    const task = store.createTask('iter cost cap', workDir);
    task.ralphLoop = baseLoop({
      currentIteration: 1, iterationCap: 10,
      stallConfig: { iterationCostCapUsd: 0.50, consecutiveIterationCostCapHits: 2 },
      lastCumulativeCostUsd: 0, // prior iteration ended at $0
    });
    const cycler = new RalphCycler(recorder.io);

    // First over-cap iteration: delta = 1.00 - 0 = 1.00 → warn, continue.
    let action = await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's1',
      cumulativeCostUsd: 1.00,
    });
    expect(action.kind).toBe('launch_fresh');
    expect(action.events).toContainEqual(expect.objectContaining({
      type: 'ralph_iteration_cost_warning', costDeltaUsd: 1.00, capUsd: 0.50, consecutiveStreak: 1,
    }));
    expect(task.ralphLoop?.consecutiveIterationCostCapStreak).toBe(1);
    expect(task.ralphLoop?.iterationCostWarningCount).toBe(1);
    expect(task.ralphLoop?.lastCumulativeCostUsd).toBe(1.00);

    // Second over-cap iteration: delta = 2.00 - 1.00 = 1.00 → streak 2, terminate.
    action = await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's2',
      cumulativeCostUsd: 2.00,
    });
    expect(action.kind).toBe('terminate');
    expect((action as { reason?: string }).reason).toBe('iteration_cost_cap');
  });

  it('iteration cost cap: a within-cap iteration resets the consecutive streak', async () => {
    const recorder = buildIO();
    const task = store.createTask('cost reset', workDir);
    task.ralphLoop = baseLoop({
      currentIteration: 1, iterationCap: 10,
      stallConfig: { iterationCostCapUsd: 0.50, consecutiveIterationCostCapHits: 2 },
      consecutiveIterationCostCapStreak: 1,
      lastCumulativeCostUsd: 1.00,
    });
    const cycler = new RalphCycler(recorder.io);

    // Delta = 1.30 - 1.00 = 0.30, under cap → streak reset.
    const action = await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's1',
      cumulativeCostUsd: 1.30,
    });
    expect(action.kind).toBe('launch_fresh');
    expect(task.ralphLoop?.consecutiveIterationCostCapStreak).toBe(0);
  });

  it('iteration cost cap: never fires when prior cost is unknown (first iteration after attach)', async () => {
    const recorder = buildIO();
    const task = store.createTask('cost unknown prior', workDir);
    task.ralphLoop = baseLoop({
      currentIteration: 1, iterationCap: 10,
      stallConfig: { iterationCostCapUsd: 0.10, consecutiveIterationCostCapHits: 1 },
      // lastCumulativeCostUsd: undefined — no prior
    });
    const cycler = new RalphCycler(recorder.io);

    // Even with a $5 cumulative cost on this iteration, the delta is unknown
    // (no prior baseline) so the cost-cap check is skipped — fail-closed.
    const action = await cycler.handleStop(store, {
      taskId: task.id, sessionId: 's1',
      cumulativeCostUsd: 5.00,
    });
    expect(action.kind).toBe('launch_fresh');
    expect(task.ralphLoop?.iterationCostWarningCount ?? 0).toBe(0);
    // But the cycler now records the cumulative cost so iteration 2's delta works.
    expect(task.ralphLoop?.lastCumulativeCostUsd).toBe(5.00);
  });

  it('stallPredicate (no verdict file) records a stall under the synthetic key', async () => {
    const recorder = buildIO();
    recorder.setPredicateResult({ satisfied: true, exitCode: 0, timedOut: false, errored: false });
    const task = store.createTask('stall pred', workDir);
    task.ralphLoop = baseLoop({
      currentIteration: 1, iterationCap: 10,
      stallPredicate: 'true', // simulated
      stallConfig: { loopShape: 'single-target', consecutiveStallsForSingleTargetTermination: 2 },
    });
    const cycler = new RalphCycler(recorder.io);

    const action = await cycler.handleStop(store, { taskId: task.id, sessionId: 's1' });
    expect(action.kind).toBe('launch_fresh');
    expect(task.ralphLoop?.burnedOutTargets).toHaveLength(1);
    expect(task.ralphLoop?.burnedOutTargets?.[0].target).toBe('__stall_predicate__');
  });
});
