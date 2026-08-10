import { describe, expect, it } from 'vitest';
import { resolveRalphCostSignal } from './ralph.js';

describe('resolveRalphCostSignal (issue #2193 gap 3)', () => {
  it('marks null cumulative cost as unavailable', () => {
    expect(resolveRalphCostSignal({
      cumulativeCostUsd: null,
      totalIterations: 0,
    })).toBe('unavailable');
  });

  it('marks known-zero cost after iterations with a cost cap as unavailable (subscription paper guardrail)', () => {
    expect(resolveRalphCostSignal({
      costCapUsd: 25,
      cumulativeCostUsd: 0,
      totalIterations: 3,
    })).toBe('unavailable');
  });

  it('treats known-zero with no cost cap as available', () => {
    expect(resolveRalphCostSignal({
      cumulativeCostUsd: 0,
      totalIterations: 3,
    })).toBe('available');
  });

  it('treats positive cumulative cost as available even with a cost cap', () => {
    expect(resolveRalphCostSignal({
      costCapUsd: 25,
      cumulativeCostUsd: 1.25,
      totalIterations: 2,
    })).toBe('available');
  });

  it('does not flag zero cost before any iterations have finished', () => {
    expect(resolveRalphCostSignal({
      costCapUsd: 25,
      cumulativeCostUsd: 0,
      totalIterations: 0,
    })).toBe('available');
  });
});
