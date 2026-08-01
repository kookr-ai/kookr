import { describe, expect, it } from 'vitest';
import {
  HotPathSampler,
  HOT_PATH_SAMPLER_SCHEMA_VERSION,
  getHotPathSampler,
  recordHotPath,
  resetHotPathSamplerForTests,
} from './hot-path-sampler.js';

/** Controllable monotonic clock so window math is deterministic. */
function fakeClock(startMs = 0): { nowMs: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    nowMs: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('HotPathSampler', () => {
  it('ranks labels by total time burned, descending, within a window', () => {
    const clock = fakeClock();
    const sampler = new HotPathSampler({ nowMs: clock.nowMs, windowsMinutes: [5], topK: 10 });

    sampler.record('snapshot_rebuild', 10);
    sampler.record('snapshot_rebuild', 30); // total 40
    sampler.record('hook_parse', 5);
    sampler.record('hook_parse', 5); // total 10
    sampler.record('task_save', 100); // total 100

    const snap = sampler.snapshot();
    expect(snap.schemaVersion).toBe(HOT_PATH_SAMPLER_SCHEMA_VERSION);
    expect(snap.windows).toHaveLength(1);
    const paths = snap.windows[0].paths;
    expect(paths.map((p) => p.label)).toEqual(['task_save', 'snapshot_rebuild', 'hook_parse']);
    expect(paths[0]).toMatchObject({ label: 'task_save', count: 1, totalMs: 100, maxMs: 100, meanMs: 100 });
    expect(paths[1]).toMatchObject({ label: 'snapshot_rebuild', count: 2, totalMs: 40, meanMs: 20, maxMs: 30 });
    expect(snap.windows[0].sampleCount).toBe(5);
  });

  it('excludes samples older than the window and reports both default windows', () => {
    const clock = fakeClock();
    const sampler = new HotPathSampler({ nowMs: clock.nowMs, windowsMinutes: [5, 15] });

    sampler.record('old', 50); // t=0
    clock.advance(10 * 60_000); // +10 min
    sampler.record('recent', 20); // t=10min

    const snap = sampler.snapshot();
    const [w5, w15] = snap.windows;
    expect(w5.windowMinutes).toBe(5);
    expect(w15.windowMinutes).toBe(15);
    // 5-min window (t in [5min, 10min]) sees only 'recent'.
    expect(w5.paths.map((p) => p.label)).toEqual(['recent']);
    expect(w5.sampleCount).toBe(1);
    // 15-min window (t in [-5min, 10min]) sees both.
    expect(w15.paths.map((p) => p.label).sort()).toEqual(['old', 'recent']);
    expect(w15.sampleCount).toBe(2);
  });

  it('computes p95 and max per label', () => {
    const clock = fakeClock();
    const sampler = new HotPathSampler({ nowMs: clock.nowMs, windowsMinutes: [5] });
    for (let i = 1; i <= 100; i += 1) sampler.record('x', i); // 1..100
    const entry = sampler.snapshot().windows[0].paths[0];
    expect(entry.count).toBe(100);
    expect(entry.maxMs).toBe(100);
    expect(entry.p95Ms).toBe(95);
  });

  it('ignores non-finite and negative durations', () => {
    const sampler = new HotPathSampler({ windowsMinutes: [5] });
    sampler.record('x', Number.NaN);
    sampler.record('x', Number.POSITIVE_INFINITY);
    sampler.record('x', -1);
    sampler.record('x', 0); // valid (zero allowed)
    const snap = sampler.snapshot();
    expect(snap.retainedCount).toBe(1);
    expect(snap.windows[0].paths[0]).toMatchObject({ label: 'x', count: 1, totalMs: 0 });
  });

  it('caps label cardinality and counts dropped records', () => {
    const sampler = new HotPathSampler({ maxLabels: 2, windowsMinutes: [5] });
    sampler.record('a', 1);
    sampler.record('b', 1);
    sampler.record('c', 1); // dropped — new label past cap
    sampler.record('a', 1); // still recorded — known label
    const snap = sampler.snapshot();
    expect(snap.labelCount).toBe(2);
    expect(snap.droppedLabelCount).toBe(1);
    expect(snap.windows[0].paths.map((p) => p.label).sort()).toEqual(['a', 'b']);
  });

  it('overwrites oldest entries past capacity (bounded ring)', () => {
    const clock = fakeClock();
    const sampler = new HotPathSampler({ capacity: 3, nowMs: clock.nowMs, windowsMinutes: [60] });
    for (let i = 0; i < 5; i += 1) {
      sampler.record('x', 10);
      clock.advance(1);
    }
    const snap = sampler.snapshot();
    expect(snap.capacity).toBe(3);
    expect(snap.retainedCount).toBe(3);
    expect(snap.windows[0].paths[0].count).toBe(3);
  });

  it('time() records even when the function throws, then rethrows', () => {
    const sampler = new HotPathSampler({ windowsMinutes: [5] });
    const result = sampler.time('ok', () => 42);
    expect(result).toBe(42);
    expect(() => sampler.time('boom', () => {
      throw new Error('nope');
    })).toThrow('nope');
    const labels = sampler.snapshot().windows[0].paths.map((p) => p.label).sort();
    expect(labels).toEqual(['boom', 'ok']);
  });

  it('honors a topK override in snapshot()', () => {
    const sampler = new HotPathSampler({ windowsMinutes: [5], topK: 10 });
    sampler.record('a', 3);
    sampler.record('b', 2);
    sampler.record('c', 1);
    expect(sampler.snapshot({ topK: 2 }).windows[0].paths.map((p) => p.label)).toEqual(['a', 'b']);
  });

  it('returns an empty-but-valid snapshot when nothing was recorded', () => {
    const snap = new HotPathSampler({ windowsMinutes: [5, 15] }).snapshot();
    expect(snap.retainedCount).toBe(0);
    expect(snap.labelCount).toBe(0);
    expect(snap.windows.every((w) => w.paths.length === 0 && w.sampleCount === 0)).toBe(true);
  });
});

describe('process-wide sampler', () => {
  it('recordHotPath writes into the singleton returned by getHotPathSampler', () => {
    resetHotPathSamplerForTests();
    recordHotPath('task_save', 12);
    const snap = getHotPathSampler().snapshot();
    const labels = snap.windows.flatMap((w) => w.paths.map((p) => p.label));
    expect(labels).toContain('task_save');
    resetHotPathSamplerForTests();
  });
});
