import { describe, expect, test } from 'vitest';
import {
  calculateMemoryUsage,
  CpuUsageTracker,
  isDataDirectoryFreeCritical,
  type CpuCoreSample,
} from './system-resource-metrics.js';

function cpu(user: number, idle: number, sys = 0): CpuCoreSample {
  return { times: { user, nice: 0, sys, idle, irq: 0 } };
}

describe('CpuUsageTracker', () => {
  test('returns warming-up on first sample', () => {
    const tracker = new CpuUsageTracker({ intervalMs: 2_000 });

    expect(tracker.update([cpu(10, 90)], 1_000)).toEqual({
      usagePercent: null,
      sampleGapMs: null,
      unavailable: ['cpu_warming_up'],
    });
  });

  test('calculates aggregate CPU usage from cumulative deltas', () => {
    const tracker = new CpuUsageTracker({ intervalMs: 2_000 });
    tracker.update([cpu(100, 900), cpu(200, 800)], 1_000);

    const result = tracker.update([cpu(160, 940), cpu(260, 840)], 3_000);

    expect(result.sampleGapMs).toBe(2_000);
    expect(result.unavailable).toEqual([]);
    expect(result.usagePercent).toBeCloseTo(60);
  });

  test('resets the baseline when logical CPU count changes', () => {
    const tracker = new CpuUsageTracker({ intervalMs: 2_000 });
    tracker.update([cpu(100, 900)], 1_000);

    expect(tracker.update([cpu(120, 930), cpu(5, 95)], 3_000)).toEqual({
      usagePercent: null,
      sampleGapMs: 2_000,
      unavailable: ['cpu_delta_invalid'],
    });
  });

  test('resets the baseline when a counter moves backwards', () => {
    const tracker = new CpuUsageTracker({ intervalMs: 2_000 });
    tracker.update([cpu(100, 900)], 1_000);

    expect(tracker.update([cpu(90, 920)], 3_000)).toEqual({
      usagePercent: null,
      sampleGapMs: 2_000,
      unavailable: ['cpu_delta_invalid'],
    });
  });

  test('keeps CPU visible during shorter delayed samples', () => {
    const tracker = new CpuUsageTracker({ intervalMs: 2_000 });
    tracker.update([cpu(100, 900)], 1_000);

    const result = tracker.update([cpu(220, 980)], 8_000);

    expect(result.sampleGapMs).toBe(7_000);
    expect(result.usagePercent).toBeCloseTo(60);
  });

  test('resets after a sleep-sized sample gap', () => {
    const tracker = new CpuUsageTracker({ intervalMs: 2_000 });
    tracker.update([cpu(100, 900)], 1_000);

    expect(tracker.update([cpu(200, 1_000)], 40_000)).toEqual({
      usagePercent: null,
      sampleGapMs: 39_000,
      unavailable: ['cpu_delta_invalid'],
    });
  });

  test('returns unavailable when no CPU samples are present', () => {
    const tracker = new CpuUsageTracker();

    expect(tracker.update([], 1_000)).toEqual({
      usagePercent: null,
      sampleGapMs: null,
      unavailable: ['cpu_unavailable'],
    });
  });
});

describe('calculateMemoryUsage', () => {
  test('calculates RAM used percent from total and free bytes', () => {
    expect(calculateMemoryUsage(1_000, 250)).toEqual({
      memoryUsedPercent: 75,
      memoryFreeBytes: 250,
      memoryTotalBytes: 1_000,
      unavailable: [],
    });
  });

  test('returns unavailable for invalid total memory', () => {
    expect(calculateMemoryUsage(0, 0)).toEqual({
      memoryUsedPercent: null,
      memoryFreeBytes: null,
      memoryTotalBytes: null,
      unavailable: ['memory_unavailable'],
    });
  });

  test('bounds implausible free memory values', () => {
    expect(calculateMemoryUsage(1_000, 2_000)).toMatchObject({
      memoryUsedPercent: 0,
      memoryFreeBytes: 1_000,
      memoryTotalBytes: 1_000,
    });
  });
});

describe('isDataDirectoryFreeCritical (issue #1992)', () => {
  test('returns false when both floors are disabled', () => {
    expect(isDataDirectoryFreeCritical({
      freePercent: 0,
      freeBytes: 0,
      percentThreshold: 0,
      bytesThreshold: 0,
    })).toBe(false);
  });

  test('breaches on free percent at or below the floor', () => {
    expect(isDataDirectoryFreeCritical({
      freePercent: 5,
      freeBytes: 10_000_000_000,
      percentThreshold: 5,
      bytesThreshold: 0,
    })).toBe(true);
    expect(isDataDirectoryFreeCritical({
      freePercent: 5.1,
      freeBytes: 10_000_000_000,
      percentThreshold: 5,
      bytesThreshold: 0,
    })).toBe(false);
  });

  test('breaches on free bytes at or below the floor', () => {
    expect(isDataDirectoryFreeCritical({
      freePercent: 50,
      freeBytes: 1_000,
      percentThreshold: 0,
      bytesThreshold: 1_000,
    })).toBe(true);
    expect(isDataDirectoryFreeCritical({
      freePercent: 50,
      freeBytes: 1_001,
      percentThreshold: 0,
      bytesThreshold: 1_000,
    })).toBe(false);
  });

  test('fails open on missing / non-finite readings for the enabled floors', () => {
    expect(isDataDirectoryFreeCritical({
      freePercent: null,
      freeBytes: null,
      percentThreshold: 5,
      bytesThreshold: 1_000,
    })).toBe(false);
    expect(isDataDirectoryFreeCritical({
      freePercent: Number.NaN,
      freeBytes: Number.POSITIVE_INFINITY,
      percentThreshold: 5,
      bytesThreshold: 1_000,
    })).toBe(false);
  });

  test('OR of floors: either enabled breach trips', () => {
    expect(isDataDirectoryFreeCritical({
      freePercent: 1,
      freeBytes: 99_000_000_000,
      percentThreshold: 5,
      bytesThreshold: 2_000_000_000,
    })).toBe(true);
    expect(isDataDirectoryFreeCritical({
      freePercent: 50,
      freeBytes: 100,
      percentThreshold: 5,
      bytesThreshold: 2_000_000_000,
    })).toBe(true);
  });
});
