import { describe, expect, it } from 'vitest';
import {
  CHAIN_MAX_LAUNCH_FAILURES,
  CHAIN_MIN_HEALTHY_ITERATION_MS,
  CHAIN_RUNAWAY_STREAK,
  classifyIteration,
  decideChainStep,
  initialChainState,
  renderChainPreamble,
  validateChainSpec,
  type ChainTipView,
} from './playbook-chain.js';
import { CHAIN_TIME_ONLY_SAFETY_CAP, type TaskChainState } from '../shared/contracts/playbook-chain.js';

const T0 = new Date('2026-11-14T20:00:00.000Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

function chain(overrides: Partial<TaskChainState> = {}): TaskChainState {
  return {
    chainId: 'root',
    iteration: 1,
    maxIterations: 5,
    startedAt: T0.toISOString(),
    unhealthyStreak: 0,
    ...overrides,
  };
}

/** A tip that ran for `ranMinutes` and ended in `status`. */
function tip(overrides: Partial<ChainTipView> & { ranMinutes?: number } = {}): ChainTipView {
  const { ranMinutes = 30, ...rest } = overrides;
  return {
    status: 'completed',
    chain: chain(),
    createdAt: T0,
    firstSessionAt: T0,
    finishedAt: minutes(ranMinutes),
    sessionCount: 1,
    terminalReceipt: { source: 'task_self', reason: 'completed_normal' },
    ...rest,
  };
}

describe('documented limits', () => {
  it('match the values the docs quote', () => {
    expect(CHAIN_TIME_ONLY_SAFETY_CAP).toBe(50);
    expect(CHAIN_MIN_HEALTHY_ITERATION_MS).toBe(2 * 60_000);
    expect(CHAIN_RUNAWAY_STREAK).toBe(3);
    expect(CHAIN_MAX_LAUNCH_FAILURES).toBe(3);
  });

  it('accepts the upper bounds and the healthy-run boundary exactly', () => {
    expect(validateChainSpec({ maxIterations: 200, durationMinutes: 10_080 }).ok).toBe(true);
    const at = (ms: number) => classifyIteration(tip({ finishedAt: new Date(T0.getTime() + ms) }));
    expect(at(119_999)).toMatchObject({ healthy: false });
    expect(at(120_000)).toMatchObject({ healthy: true });
    expect(classifyIteration(tip({ chain: chain({ idleClosedAfterActiveMs: 119_999 }) }))).toMatchObject({ healthy: false });
    expect(classifyIteration(tip({ chain: chain({ idleClosedAfterActiveMs: 120_000 }) }))).toMatchObject({ healthy: true });
  });
});

describe('validateChainSpec', () => {
  it('accepts a count, a duration, or both', () => {
    expect(validateChainSpec({ maxIterations: 3 })).toEqual({ ok: true, value: { maxIterations: 3 } });
    expect(validateChainSpec({ durationMinutes: 480 })).toEqual({ ok: true, value: { durationMinutes: 480 } });
    expect(validateChainSpec({ maxIterations: 3, durationMinutes: 60 }).ok).toBe(true);
  });

  it('rejects a spec with no bound, so a chain can never be unbounded by accident', () => {
    expect(validateChainSpec({})).toMatchObject({ ok: false });
    expect(validateChainSpec({ maxIterations: null, durationMinutes: null })).toMatchObject({ ok: false });
  });

  it('rejects out-of-range and non-integer bounds', () => {
    for (const bad of [{ maxIterations: 0 }, { maxIterations: 201 }, { maxIterations: 2.5 }, { durationMinutes: 0 }, { durationMinutes: 7 * 24 * 60 + 1 }, { maxIterations: '3' }]) {
      expect(validateChainSpec(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    expect(validateChainSpec('3')).toMatchObject({ ok: false });
  });
});

describe('initialChainState', () => {
  it('turns a duration into an absolute deadline', () => {
    const state = initialChainState({ durationMinutes: 90 }, T0);
    expect(state.deadlineAt).toBe(minutes(90).toISOString());
    expect(state.maxIterations).toBeUndefined();
    expect(state.iteration).toBe(1);
  });
});

describe('classifyIteration', () => {
  it('treats non-terminal tasks as still running', () => {
    for (const status of ['open', 'pending', 'inProgress'] as const) {
      expect(classifyIteration(tip({ status }))).toEqual({ kind: 'running' });
    }
  });

  it('treats an operator cancel or manual terminate as a stop, but not an operator complete', () => {
    expect(classifyIteration(tip({ status: 'cancelled', terminalReceipt: { source: 'user', reason: 'manual' } })))
      .toEqual({ kind: 'operator_stopped' });
    expect(classifyIteration(tip({ status: 'terminated', terminalReceipt: { source: 'user', reason: 'manual' } })))
      .toEqual({ kind: 'operator_stopped' });
    expect(classifyIteration(tip({ status: 'completed', terminalReceipt: { source: 'user', reason: 'completed_normal' } })))
      .toEqual({ kind: 'finished', healthy: true });
  });

  it('treats a non-operator termination as a finished but unhealthy iteration', () => {
    expect(classifyIteration(tip({ status: 'terminated', terminalReceipt: { source: 'watchdog', reason: 'timeout' } })))
      .toMatchObject({ kind: 'finished', healthy: false });
    expect(classifyIteration(tip({ status: 'cancelled', terminalReceipt: { source: 'watchdog', reason: 'timeout' } })))
      .toMatchObject({ kind: 'finished', healthy: false });
  });

  it('flags a completed iteration under two minutes as unhealthy, measured from its first session', () => {
    expect(classifyIteration(tip({ ranMinutes: 1 }))).toMatchObject({ kind: 'finished', healthy: false });
    // Queued for an hour, then ran 30 min: healthy, because queue time is not run time.
    expect(classifyIteration(tip({ createdAt: minutes(-60), firstSessionAt: T0, finishedAt: minutes(30) })))
      .toEqual({ kind: 'finished', healthy: true });
  });
});

describe('classifyIteration — idle-closed and never-started iterations', () => {
  it('counts an idle-closed iteration as healthy after a normal-length run, unhealthy after an immediate stall', () => {
    expect(classifyIteration(tip({ chain: chain({ idleClosedAfterActiveMs: 40 * 60_000 }) })))
      .toEqual({ kind: 'finished', healthy: true });
    expect(classifyIteration(tip({ chain: chain({ idleClosedAfterActiveMs: 30_000 }) })))
      .toMatchObject({ kind: 'finished', healthy: false });
  });

  it('marks a task whose launch failed before any session as never started', () => {
    expect(classifyIteration(tip({ status: 'terminated', sessionCount: 0, terminalReceipt: { source: 'unknown', reason: 'launch_failure' } })))
      .toMatchObject({ kind: 'finished', healthy: false, neverStarted: true });
  });
});

describe('decideChainStep', () => {
  it('waits while the iteration runs', () => {
    expect(decideChainStep(tip({ status: 'inProgress' }), minutes(5))).toEqual({ kind: 'wait' });
  });

  it('launches the next iteration with bounds copied forward', () => {
    const decision = decideChainStep(tip({ chain: chain({ iteration: 2, deadlineAt: minutes(600).toISOString() }) }), minutes(40));
    expect(decision).toEqual({
      kind: 'launch',
      next: {
        chainId: 'root',
        iteration: 3,
        maxIterations: 5,
        deadlineAt: minutes(600).toISOString(),
            startedAt: T0.toISOString(),
        unhealthyStreak: 0,
      },
    });
  });

  it('does not copy control fields (stop request, end marker) into the successor', () => {
    const decision = decideChainStep(tip({ chain: chain({ iteration: 1 }) }), minutes(40));
    expect(decision.kind).toBe('launch');
    if (decision.kind === 'launch') {
      expect(decision.next).not.toHaveProperty('stopRequest');
      expect(decision.next).not.toHaveProperty('ended');
    }
  });

  it('ends after the last iteration', () => {
    expect(decideChainStep(tip({ chain: chain({ iteration: 5 }) }), minutes(40)))
      .toMatchObject({ kind: 'end', reason: 'iterations_reached' });
  });

  it('ends at the first boundary after the deadline, never mid-iteration', () => {
    const timed = chain({ maxIterations: undefined, deadlineAt: minutes(60).toISOString() });
    expect(decideChainStep(tip({ status: 'inProgress', chain: timed }), minutes(90))).toEqual({ kind: 'wait' });
    expect(decideChainStep(tip({ chain: timed }), minutes(59))).toMatchObject({ kind: 'launch' });
    expect(decideChainStep(tip({ chain: timed }), minutes(90))).toMatchObject({ kind: 'end', reason: 'deadline_reached' });
  });

  it('with both bounds, whichever is reached first wins', () => {
    const both = chain({ maxIterations: 10, deadlineAt: minutes(60).toISOString() });
    expect(decideChainStep(tip({ chain: { ...both, iteration: 3 } }), minutes(61))).toMatchObject({ reason: 'deadline_reached' });
    expect(decideChainStep(tip({ chain: { ...both, iteration: 10 } }), minutes(30))).toMatchObject({ reason: 'iterations_reached' });
  });

  it('stops a time-only chain at exactly 50 iterations', () => {
    const timed = (iteration: number) => chain({ maxIterations: undefined, iteration, deadlineAt: minutes(10_000).toISOString() });
    expect(decideChainStep(tip({ chain: timed(49) }), minutes(40))).toMatchObject({ kind: 'launch' });
    expect(decideChainStep(tip({ chain: timed(50) }), minutes(40))).toMatchObject({ kind: 'end', reason: 'safety_cap' });
  });

  it('honours a stop request once the iteration finishes, with the requester reason', () => {
    const stopping = chain({ iteration: 2, stopRequest: { at: T0.toISOString(), by: 'agent', reason: 'queue empty' } });
    expect(decideChainStep(tip({ status: 'inProgress', chain: stopping }), minutes(5))).toEqual({ kind: 'wait' });
    expect(decideChainStep(tip({ chain: stopping }), minutes(40))).toEqual({ kind: 'end', reason: 'stopped', detail: 'queue empty' });
  });

  it('ends the chain when the operator cancels the iteration', () => {
    expect(decideChainStep(tip({ status: 'cancelled', terminalReceipt: { source: 'user', reason: 'manual' } }), minutes(5)))
      .toMatchObject({ kind: 'end', reason: 'iteration_cancelled' });
  });

  it('keeps going after one failed iteration, counting the failure', () => {
    const decision = decideChainStep(tip({ status: 'terminated', terminalReceipt: { source: 'watchdog', reason: 'timeout' } }), minutes(40));
    expect(decision).toMatchObject({ kind: 'launch', next: { iteration: 2, unhealthyStreak: 1 } });
  });

  it('resets the unhealthy streak after a healthy iteration', () => {
    const decision = decideChainStep(tip({ chain: chain({ unhealthyStreak: 2 }) }), minutes(40));
    expect(decision).toMatchObject({ kind: 'launch', next: { unhealthyStreak: 0 } });
  });

  it(`ends with runaway after ${CHAIN_RUNAWAY_STREAK} unhealthy iterations in a row`, () => {
    const spinning = chain({ maxIterations: undefined, deadlineAt: minutes(10_000).toISOString(), iteration: 3, unhealthyStreak: CHAIN_RUNAWAY_STREAK - 1 });
    expect(decideChainStep(tip({ chain: spinning, ranMinutes: 0.5 }), minutes(40)))
      .toMatchObject({ kind: 'end', reason: 'runaway' });
  });

  it('reports launch_failed, not runaway, when the third unhealthy iteration never started', () => {
    const failing = chain({ iteration: 3, unhealthyStreak: CHAIN_RUNAWAY_STREAK - 1 });
    expect(decideChainStep(tip({ status: 'terminated', sessionCount: 0, chain: failing }), minutes(40)))
      .toMatchObject({ kind: 'end', reason: 'launch_failed' });
  });

  it('does nothing for a chain that already ended', () => {
    const ended = chain({ ended: { at: T0.toISOString(), reason: 'stopped' } });
    expect(decideChainStep(tip({ chain: ended }), minutes(40))).toEqual({ kind: 'wait' });
  });
});

describe('renderChainPreamble', () => {
  it('states the position and both bounds and forbids self-spawning', () => {
    const text = renderChainPreamble(chain({ iteration: 3, maxIterations: 10, deadlineAt: '2026-11-15T06:00:00.000Z' }));
    expect(text).toContain('iteration 3 of 10');
    expect(text).toContain('runs until 2026-11-15 06:00 UTC');
    expect(text).toContain('Do NOT spawn a successor');
    expect(text).toContain('kookr chain stop');
  });

  it('omits the count for a time-only chain', () => {
    const text = renderChainPreamble(chain({ iteration: 2, maxIterations: undefined, deadlineAt: '2026-11-15T06:00:00.000Z' }));
    expect(text.split('\n')[0]).toBe('## Kookr chain — iteration 2 (runs until 2026-11-15 06:00 UTC)');
  });
});
