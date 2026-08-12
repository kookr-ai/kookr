import { describe, expect, it } from 'vitest';
import {
  accumulateInventPriorityCount,
  classifyInventPriority,
  DEFAULT_STARVATION_INVENT_BLOCKED_EMPTY_THRESHOLD,
  emptyInventPriorityCounts,
  hasProductInventRunway,
  inventPriorityScore,
  isInventPressure,
  shouldSuppressMicroInvent,
  starvationInventExtraInstruction,
} from './starvation-invent-policy.js';

describe('classifyInventPriority', () => {
  it('classifies dual-priority product labels as product', () => {
    expect(classifyInventPriority('anything', ['acquisition'])).toBe('product');
    expect(classifyInventPriority('control room density', ['product-surface-ux'])).toBe(
      'product',
    );
    expect(classifyInventPriority('Umbrella: acquisition redundancy & failover')).toBe(
      'product',
    );
    expect(classifyInventPriority('control-room UX density residual')).toBe('product');
  });

  it('classifies micro-hardening / detection-rollup ops polish as micro', () => {
    expect(
      classifyInventPriority('chore: detection-rollup retention path', ['idea-scout']),
    ).toBe('micro');
    expect(classifyInventPriority('micro-hardening doctor path', ['micro-hardening'])).toBe(
      'micro',
    );
  });

  it('product wins over micro when both signals present', () => {
    expect(
      classifyInventPriority('acquisition probe', ['micro-hardening', 'acquisition']),
    ).toBe('product');
  });

  it('falls back to other for unlabeled generic work', () => {
    expect(classifyInventPriority('feat: random improvement', ['enhancement'])).toBe('other');
  });
});

describe('isInventPressure', () => {
  it('fires when consecutiveBlockedEmpty ≥ threshold', () => {
    expect(
      isInventPressure({
        consecutiveBlockedEmpty: DEFAULT_STARVATION_INVENT_BLOCKED_EMPTY_THRESHOLD,
      }),
    ).toBe(true);
    expect(isInventPressure({ consecutiveBlockedEmpty: 10 })).toBe(true);
    expect(isInventPressure({ consecutiveBlockedEmpty: 2 })).toBe(false);
  });

  it('fires when product belt empty with free slots', () => {
    expect(
      isInventPressure({
        openProductMetricIssues: 0,
        freeSlots: 5,
        freeSlotsThreshold: 3,
      }),
    ).toBe(true);
    expect(
      isInventPressure({
        openProductMetricIssues: 2,
        freeSlots: 5,
      }),
    ).toBe(false);
    expect(
      isInventPressure({
        openProductMetricIssues: 0,
        freeSlots: 1,
      }),
    ).toBe(false);
  });
});

describe('shouldSuppressMicroInvent', () => {
  it('suppresses micro only under pressure with product runway', () => {
    expect(shouldSuppressMicroInvent(true, true)).toBe(true);
    expect(shouldSuppressMicroInvent(true, false)).toBe(false);
    expect(shouldSuppressMicroInvent(false, true)).toBe(false);
  });

  it('hasProductInventRunway requires umbrella or product ready', () => {
    expect(hasProductInventRunway({ productUmbrellaEligible: true })).toBe(true);
    expect(hasProductInventRunway({ productReadyCount: 2 })).toBe(true);
    expect(hasProductInventRunway({})).toBe(false);
  });
});

describe('inventPriorityScore + counters', () => {
  it('ranks product > other > micro', () => {
    expect(inventPriorityScore('product')).toBeGreaterThan(inventPriorityScore('other'));
    expect(inventPriorityScore('other')).toBeGreaterThan(inventPriorityScore('micro'));
  });

  it('accumulates invent class counts', () => {
    let counts = emptyInventPriorityCounts();
    counts = accumulateInventPriorityCount(counts, 'product', 2);
    counts = accumulateInventPriorityCount(counts, 'micro', 1);
    expect(counts).toEqual({ product: 2, micro: 1, other: 0 });
  });
});

describe('starvationInventExtraInstruction', () => {
  it('steers dual-priority product invent under drought', () => {
    const text = starvationInventExtraInstruction({
      consecutiveBlockedEmpty: 10,
      runKey: 'run-1',
      disqualifierSummary: 'all open PRs',
    });
    expect(text).toMatch(/consecutiveBlockedEmpty=10/);
    expect(text).toMatch(/acquisition/);
    expect(text).toMatch(/product-surface-ux/);
    expect(text).toMatch(/micro-hardening/);
    expect(text).toMatch(/#2358/);
  });
});
