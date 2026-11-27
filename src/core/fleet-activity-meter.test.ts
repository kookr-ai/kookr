import { describe, expect, test } from 'vitest';
import {
  SlidingEventCounter,
  TokenRateMeter,
  type TokenTotals,
} from './fleet-activity-meter.js';

function totals(overrides: Partial<TokenTotals> = {}): TokenTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...overrides };
}

describe('SlidingEventCounter', () => {
  test('counts events inside the trailing window', () => {
    const counter = new SlidingEventCounter(60_000);
    counter.record(1_000);
    counter.record(1_400);
    counter.record(30_000);
    expect(counter.count(30_000)).toBe(3);
  });

  test('forgets events once they fall wholly outside the window', () => {
    const counter = new SlidingEventCounter(60_000);
    counter.record(1_000);
    counter.record(50_000);
    expect(counter.count(60_500)).toBe(2);
    // The first event's one-second bucket [1000, 2000) ends before 62_000 - 60_000.
    expect(counter.count(62_000)).toBe(1);
    expect(counter.count(200_000)).toBe(0);
  });

  test('an empty counter reads zero', () => {
    expect(new SlidingEventCounter().count(5_000)).toBe(0);
  });

  test('memory stays bounded by the window under a sustained burst', () => {
    const counter = new SlidingEventCounter(10_000);
    for (let ms = 0; ms < 120_000; ms += 10) counter.record(ms);
    // 100 events per second for 10 s (+ the partly covered oldest bucket).
    const count = counter.count(120_000);
    expect(count).toBeGreaterThanOrEqual(1_000);
    expect(count).toBeLessThanOrEqual(1_100);
  });
});

describe('TokenRateMeter', () => {
  test('reports nothing before it has watched for any time', () => {
    const meter = new TokenRateMeter(30_000);
    expect(meter.rates(0)).toBeNull();
    meter.observe(new Map([['a', totals({ outputTokens: 500 })]]), 1_000);
    expect(meter.rates(1_000)).toBeNull();
  });

  test('a task seen for the first time sets a baseline and adds no throughput', () => {
    const meter = new TokenRateMeter(30_000);
    // A resumed transcript already holds 2M cached tokens: that is history.
    meter.observe(new Map([['a', totals({ outputTokens: 90_000, cacheReadTokens: 2_000_000 })]]), 0);
    expect(meter.rates(5_000)).toEqual({ generatedPerSec: 0, readPerSec: 0, cacheReadPerSec: 0 });
  });

  test('averages growth across tasks over the time watched', () => {
    const meter = new TokenRateMeter(30_000);
    meter.observe(new Map([['a', totals()], ['b', totals()]]), 0);
    meter.observe(new Map([
      ['a', totals({ outputTokens: 600, inputTokens: 10, cacheReadTokens: 9_000, cacheWriteTokens: 990 })],
      ['b', totals({ outputTokens: 400, cacheReadTokens: 1_000 })],
    ]), 10_000);
    expect(meter.rates(10_000)).toEqual({
      generatedPerSec: 100,
      readPerSec: 1_100,
      cacheReadPerSec: 1_000,
    });
  });

  test('once a full window has passed, old growth drops out', () => {
    const meter = new TokenRateMeter(30_000);
    meter.observe(new Map([['a', totals()]]), 0);
    meter.observe(new Map([['a', totals({ outputTokens: 3_000 })]]), 5_000);
    expect(meter.rates(30_000)?.generatedPerSec).toBe(100);
    // 5_000 is no longer inside (35_001 - 30_000, 35_001].
    expect(meter.rates(35_001)?.generatedPerSec).toBe(0);
  });

  test('a total that went down re-baselines instead of producing a negative or huge rate', () => {
    const meter = new TokenRateMeter(30_000);
    meter.observe(new Map([['a', totals({ outputTokens: 5_000 })]]), 0);
    meter.observe(new Map([['a', totals({ outputTokens: 200 })]]), 5_000);
    expect(meter.rates(5_000)?.generatedPerSec).toBe(0);
    meter.observe(new Map([['a', totals({ outputTokens: 700 })]]), 10_000);
    expect(meter.rates(10_000)?.generatedPerSec).toBe(50);
  });

  test('a task that disappears and comes back starts from a fresh baseline', () => {
    const meter = new TokenRateMeter(30_000);
    meter.observe(new Map([['a', totals({ outputTokens: 100 })]]), 0);
    meter.observe(new Map(), 5_000);
    meter.observe(new Map([['a', totals({ outputTokens: 9_100 })]]), 10_000);
    expect(meter.rates(10_000)?.generatedPerSec).toBe(0);
  });

  test('an idle fleet reads zero, not null, once the meter is watching', () => {
    const meter = new TokenRateMeter(30_000);
    meter.observe(new Map(), 0);
    meter.observe(new Map(), 4_000);
    expect(meter.rates(4_000)).toEqual({ generatedPerSec: 0, readPerSec: 0, cacheReadPerSec: 0 });
  });
});
