import { describe, expect, it } from 'vitest';
import { TerminalInputRttMetrics } from './terminal-input-rtt-metrics.js';

describe('TerminalInputRttMetrics', () => {
  it('reports an empty snapshot before any observation', () => {
    const metrics = new TerminalInputRttMetrics();
    expect(metrics.snapshot()).toMatchObject({
      schemaVersion: 'terminal-input-rtt-metrics.v1',
      count: 0,
      sampleCount: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
    });
  });

  it('computes p50/p95/p99 over recorded samples', () => {
    const metrics = new TerminalInputRttMetrics();
    // 1..100 ms.
    for (let ms = 1; ms <= 100; ms += 1) metrics.record(ms);
    const snapshot = metrics.snapshot();
    expect(snapshot.count).toBe(100);
    expect(snapshot.sampleCount).toBe(100);
    // ceil(rank/100 * n) - 1 index into the sorted 1..100 array.
    expect(snapshot.p50Ms).toBe(50);
    expect(snapshot.p95Ms).toBe(95);
    expect(snapshot.p99Ms).toBe(99);
  });

  it('rounds quantiles to two decimals', () => {
    const metrics = new TerminalInputRttMetrics();
    metrics.record(1.23456);
    const snapshot = metrics.snapshot();
    expect(snapshot.p50Ms).toBe(1.23);
  });

  it('ignores non-finite and negative durations', () => {
    const metrics = new TerminalInputRttMetrics();
    metrics.record(Number.NaN);
    metrics.record(Number.POSITIVE_INFINITY);
    metrics.record(-5);
    metrics.record(10);
    const snapshot = metrics.snapshot();
    expect(snapshot.count).toBe(1);
    expect(snapshot.sampleCount).toBe(1);
    expect(snapshot.p50Ms).toBe(10);
  });

  it('keeps count monotonic while bounding retained samples to maxSamples', () => {
    const metrics = new TerminalInputRttMetrics({ maxSamples: 4 });
    for (const ms of [10, 20, 30, 40, 50, 60]) metrics.record(ms);
    const snapshot = metrics.snapshot();
    // count tracks every observation; sampleCount is capped by the ring buffer.
    expect(snapshot.count).toBe(6);
    expect(snapshot.sampleCount).toBe(4);
    expect(snapshot.maxSamples).toBe(4);
    // The ring overwrote the two oldest (10, 20); retained 30,40,50,60.
    expect(snapshot.p50Ms).toBe(40);
    expect(snapshot.p99Ms).toBe(60);
  });

  it('measures elapsed time via an injectable clock', () => {
    const clock = [5, 12];
    const metrics = new TerminalInputRttMetrics({ nowMs: () => clock.shift() ?? 0 });
    const startedAt = metrics.now();
    metrics.record(metrics.now() - startedAt);
    const snapshot = metrics.snapshot();
    expect(snapshot.count).toBe(1);
    expect(snapshot.p50Ms).toBe(7);
  });

  it('falls back to the default sample cap for invalid maxSamples options', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const metrics = new TerminalInputRttMetrics({ maxSamples: bad });
      expect(metrics.snapshot().maxSamples).toBe(512);
    }
  });
});
