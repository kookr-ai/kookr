import { describe, expect, test } from 'vitest';
import { nextEligiblePhase, type Phase, type PhaseMergeProbe } from './phase-ledger.js';

/** A probe that treats the given PR numbers as merge-reachable. */
function mergedProbe(...merged: number[]): PhaseMergeProbe {
  const set = new Set(merged);
  return (pr) => set.has(pr);
}

describe('nextEligiblePhase — empty and complete chains', () => {
  test('empty chain is complete', () => {
    const result = nextEligiblePhase([], mergedProbe());
    expect(result.outcome).toBe('complete');
    expect(result.phase).toBeNull();
    expect(result.blockedOn).toBeNull();
    expect(result.reason).toContain('no phases');
  });

  test('all phases merge-reachable → complete', () => {
    const phases: Phase[] = [
      { id: 'P1', prNumber: 10, status: 'merged' },
      { id: 'P2', prNumber: 11, status: 'merged' },
    ];
    const result = nextEligiblePhase(phases, mergedProbe(10, 11));
    expect(result.outcome).toBe('complete');
    expect(result.phase).toBeNull();
    expect(result.reason).toContain('all phases merged');
  });
});

describe('nextEligiblePhase — eligible selection', () => {
  test('first phase with no PR is eligible', () => {
    const phases: Phase[] = [{ id: 'P1', status: 'pending' }, { id: 'P2', status: 'pending' }];
    const result = nextEligiblePhase(phases, mergedProbe());
    expect(result.outcome).toBe('eligible');
    expect(result.phase?.id).toBe('P1');
    expect(result.blockedOn).toBeNull();
  });

  test('advances to the next unstarted phase once the predecessor merged', () => {
    const phases: Phase[] = [
      { id: 'P1', prNumber: 10, status: 'merged' },
      { id: 'P2', status: 'pending' },
      { id: 'P3', status: 'pending' },
    ];
    const result = nextEligiblePhase(phases, mergedProbe(10));
    expect(result.outcome).toBe('eligible');
    expect(result.phase?.id).toBe('P2');
  });
});

describe('nextEligiblePhase — blocked (dependency unmerged)', () => {
  test('a recorded-but-unmerged PR blocks the chain instead of completing it', () => {
    // P1 opened PR #10 but it has NOT merged yet — the classic deadlock: the
    // next phase must not be treated as "chain complete".
    const phases: Phase[] = [
      { id: 'P1', prNumber: 10, status: 'in-flight' },
      { id: 'P2', status: 'pending' },
    ];
    const result = nextEligiblePhase(phases, mergedProbe(/* nothing merged */));
    expect(result.outcome).toBe('blocked');
    expect(result.phase).toBeNull();
    expect(result.blockedOn?.id).toBe('P1');
    expect(result.reason).toContain('#10');
  });

  test('strict-sequential: a blocked middle phase is NOT skipped for a later startable phase', () => {
    // P1 merged, P2 has an open (unmerged) PR, P3 is unstarted. A naive
    // "first pending phase" scan would pick P3; strict-sequential must stop at P2.
    const phases: Phase[] = [
      { id: 'P1', prNumber: 10, status: 'merged' },
      { id: 'P2', prNumber: 11, status: 'in-flight' },
      { id: 'P3', status: 'pending' },
    ];
    const result = nextEligiblePhase(phases, mergedProbe(10));
    expect(result.outcome).toBe('blocked');
    expect(result.phase).toBeNull();
    expect(result.blockedOn?.id).toBe('P2');
  });

  test('a recorded-blocked phase surfaces "recorded blocked" in the reason', () => {
    const phases: Phase[] = [
      { id: 'P1', prNumber: 10, status: 'blocked' },
      { id: 'P2', status: 'pending' },
    ];
    const result = nextEligiblePhase(phases, mergedProbe());
    expect(result.outcome).toBe('blocked');
    expect(result.reason).toContain('recorded blocked');
  });

  test('blocked flips to eligible once the dependency PR becomes merge-reachable', () => {
    const phases: Phase[] = [
      { id: 'P1', prNumber: 10, status: 'in-flight' },
      { id: 'P2', status: 'pending' },
    ];
    const blocked = nextEligiblePhase(phases, mergedProbe());
    expect(blocked.outcome).toBe('blocked');

    // Same ledger, probe now reports #10 reachable → P2 becomes workable.
    const eligible = nextEligiblePhase(phases, mergedProbe(10));
    expect(eligible.outcome).toBe('eligible');
    expect(eligible.phase?.id).toBe('P2');
  });
});

describe('nextEligiblePhase — satisfaction is reachability, not recorded status', () => {
  test('a phase recorded merged but not reachable (reverted) re-blocks downstream', () => {
    // P1 says merged, but reachability against the fresh base says otherwise
    // (its merge was reverted). Downstream must halt, not sail past.
    const phases: Phase[] = [
      { id: 'P1', prNumber: 10, status: 'merged' },
      { id: 'P2', prNumber: 11, status: 'merged' },
    ];
    const result = nextEligiblePhase(phases, mergedProbe(/* #10 no longer reachable */ 11));
    expect(result.outcome).toBe('blocked');
    expect(result.blockedOn?.id).toBe('P1');
    expect(result.reason).toContain('reverted');
  });

  test('a phase recorded pending but whose PR is reachable is treated as merged', () => {
    // Crash-after-merge-before-tick: ledger still says pending, but the PR
    // merged. Reachability wins, so we advance rather than reworking P1.
    const phases: Phase[] = [
      { id: 'P1', prNumber: 10, status: 'pending' },
      { id: 'P2', status: 'pending' },
    ];
    const result = nextEligiblePhase(phases, mergedProbe(10));
    expect(result.outcome).toBe('eligible');
    expect(result.phase?.id).toBe('P2');
  });
});
