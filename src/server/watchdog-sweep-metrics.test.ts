import { describe, expect, test } from 'vitest';
import { WatchdogSweepMetrics } from './watchdog-sweep-metrics.js';

describe('WatchdogSweepMetrics (issue #2770)', () => {
  test('starts at zero', () => {
    expect(new WatchdogSweepMetrics().getSnapshot()).toEqual({
      sweepsTotal: 0,
      agentsCheckedTotal: 0,
      skippedTotal: 0,
      probeTimeoutsTotal: 0,
      captureTimeoutsTotal: 0,
      drainTimeoutsTotal: 0,
      lastSweepCheckedCount: 0,
      lastSweepSkippedCount: 0,
      lastSweepDurationMs: 0,
      oldestCheckAgeMs: 0,
      trackedAgents: 0,
    });
  });

  test('probe timeouts accumulate by kind and roll up into the total', () => {
    const m = new WatchdogSweepMetrics();
    m.recordProbeTimeout('capture');
    m.recordProbeTimeout('capture');
    m.recordProbeTimeout('drain');
    const snap = m.getSnapshot();
    expect(snap.captureTimeoutsTotal).toBe(2);
    expect(snap.drainTimeoutsTotal).toBe(1);
    expect(snap.probeTimeoutsTotal).toBe(3);
  });

  test('recordSweep bumps cumulative counters and overwrites the last-sweep gauges', () => {
    const m = new WatchdogSweepMetrics();
    m.recordSweep({ checked: 2, skipped: 1, durationMs: 4_000, oldestCheckAgeMs: 12_345, trackedAgents: 3 });
    m.recordSweep({ checked: 3, skipped: 0, durationMs: 900, oldestCheckAgeMs: 500, trackedAgents: 3 });
    const snap = m.getSnapshot();
    expect(snap.sweepsTotal).toBe(2);
    expect(snap.agentsCheckedTotal).toBe(5);
    expect(snap.skippedTotal).toBe(1);
    // Gauges reflect the MOST RECENT sweep only.
    expect(snap.lastSweepCheckedCount).toBe(3);
    expect(snap.lastSweepSkippedCount).toBe(0);
    expect(snap.lastSweepDurationMs).toBe(900);
    expect(snap.oldestCheckAgeMs).toBe(500);
    expect(snap.trackedAgents).toBe(3);
  });

  test('negative / fractional inputs are clamped and rounded', () => {
    const m = new WatchdogSweepMetrics();
    m.recordSweep({ checked: -1, skipped: -5, durationMs: 3.7, oldestCheckAgeMs: 9.4, trackedAgents: -2 });
    const snap = m.getSnapshot();
    expect(snap.agentsCheckedTotal).toBe(0);
    expect(snap.skippedTotal).toBe(0);
    expect(snap.lastSweepDurationMs).toBe(4);
    expect(snap.oldestCheckAgeMs).toBe(9);
    expect(snap.trackedAgents).toBe(0);
  });
});
