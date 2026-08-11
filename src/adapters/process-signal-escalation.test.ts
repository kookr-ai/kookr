import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ESCALATION_GRACE_MS,
  escalateKill,
  type ProcessSignaler,
} from './process-signal-escalation.js';

type SignalCall = { pid: number; sig: NodeJS.Signals };

/**
 * Fake ProcessSignaler that records every signal() call and drives liveness
 * from an in-memory alive set. Tests toggle aliveness on SIGTERM when they
 * model a cooperative exit; survivors stay alive until SIGKILL (or forever).
 */
function createFakeSignaler(initialAlive: Iterable<number>): {
  signaler: ProcessSignaler;
  calls: SignalCall[];
  alive: Set<number>;
} {
  const calls: SignalCall[] = [];
  const alive = new Set(initialAlive);
  const signaler: ProcessSignaler = {
    isAlive: (pid) => alive.has(pid),
    signal: (pid, sig) => {
      calls.push({ pid, sig });
    },
  };
  return { signaler, calls, alive };
}

describe('escalateKill', () => {
  it('is a no-op for an empty pid list — never signals or sleeps', async () => {
    const sleep = vi.fn(async () => {});
    const signaler: ProcessSignaler = {
      isAlive: () => {
        throw new Error('isAlive should not be called for empty pids');
      },
      signal: () => {
        throw new Error('signal should not be called for empty pids');
      },
    };

    await escalateKill([], { signaler, sleep, graceMs: 1 });

    expect(sleep).not.toHaveBeenCalled();
  });

  it('sends SIGTERM to every pid and never SIGKILL when all die after TERM', async () => {
    const { signaler, calls, alive } = createFakeSignaler([10, 11]);
    const sleep = vi.fn(async () => {});
    // Cooperative exit: remove from alive on SIGTERM so the early-return path
    // (all dead after TERM) is taken and sleep/KILL are skipped.
    signaler.signal = (pid, sig) => {
      calls.push({ pid, sig });
      if (sig === 'SIGTERM') alive.delete(pid);
    };

    await escalateKill([10, 11], { signaler, sleep, graceMs: 50 });

    expect(calls).toEqual([
      { pid: 10, sig: 'SIGTERM' },
      { pid: 11, sig: 'SIGTERM' },
    ]);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('waits one grace period then SIGKILLs only survivors', async () => {
    const { signaler, calls, alive } = createFakeSignaler([20, 21]);
    const sleep = vi.fn(async () => {});
    signaler.signal = (pid, sig) => {
      calls.push({ pid, sig });
      // pid 20 dies on TERM; pid 21 ignores TERM and must be killed.
      if (sig === 'SIGTERM' && pid === 20) alive.delete(pid);
      if (sig === 'SIGKILL') alive.delete(pid);
    };

    await escalateKill([20, 21], { signaler, sleep, graceMs: 42 });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(42);
    expect(calls).toEqual([
      { pid: 20, sig: 'SIGTERM' },
      { pid: 21, sig: 'SIGTERM' },
      { pid: 21, sig: 'SIGKILL' },
    ]);
  });

  it('uses DEFAULT_ESCALATION_GRACE_MS when graceMs is omitted', async () => {
    const { signaler, calls } = createFakeSignaler([30]);
    // Survivor always — forces the grace path so we can observe the sleep arg.
    const sleep = vi.fn(async () => {});

    await escalateKill([30], { signaler, sleep });

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(DEFAULT_ESCALATION_GRACE_MS);
    expect(calls).toEqual([
      { pid: 30, sig: 'SIGTERM' },
      { pid: 30, sig: 'SIGKILL' },
    ]);
  });

  it('signals ALL pids with SIGTERM before any SIGKILL (multi-pid ordering)', async () => {
    // Even when one pid dies quickly on TERM and another ignores it, no
    // survivor may receive KILL before every pid has been TERM'd.
    const { signaler, calls, alive } = createFakeSignaler([201, 202, 203]);
    const sleep = vi.fn(async () => {});
    signaler.signal = (pid, sig) => {
      calls.push({ pid, sig });
      if (sig === 'SIGTERM' && (pid === 201 || pid === 203)) alive.delete(pid);
      if (sig === 'SIGKILL') alive.delete(pid);
    };

    await escalateKill([201, 202, 203], { signaler, sleep, graceMs: 5 });

    const termCalls = calls.filter((c) => c.sig === 'SIGTERM');
    const killCalls = calls.filter((c) => c.sig === 'SIGKILL');
    expect(termCalls).toEqual([
      { pid: 201, sig: 'SIGTERM' },
      { pid: 202, sig: 'SIGTERM' },
      { pid: 203, sig: 'SIGTERM' },
    ]);
    // Only the stubborn survivor is escalated.
    expect(killCalls).toEqual([{ pid: 202, sig: 'SIGKILL' }]);
    // Ordering: every TERM precedes every KILL in the overall trace.
    const lastTermIndex = calls.map((c) => c.sig).lastIndexOf('SIGTERM');
    const firstKillIndex = calls.map((c) => c.sig).indexOf('SIGKILL');
    expect(lastTermIndex).toBeLessThan(firstKillIndex);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('TERMs listed pids even when already dead, then skips sleep and KILL', async () => {
    // TERM is always attempted for every listed pid (caller already decided
    // they should be reaped); KILL is gated on isAlive after grace. Model
    // pids that were never alive — TERM still fires (production signaler
    // swallows ESRCH), then the all-dead check early-returns.
    const { signaler, calls } = createFakeSignaler([]); // none alive
    const sleep = vi.fn(async () => {});

    await escalateKill([40, 41], { signaler, sleep, graceMs: 5 });

    expect(calls).toEqual([
      { pid: 40, sig: 'SIGTERM' },
      { pid: 41, sig: 'SIGTERM' },
    ]);
    // All dead after TERM → early return, no sleep, no KILL.
    expect(sleep).not.toHaveBeenCalled();
  });
});
