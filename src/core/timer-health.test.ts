import { describe, expect, test } from 'vitest';
import {
  TIMER_HEALTH_OVERDUE_INTERVALS,
  TIMER_HEALTH_SCHEMA_VERSION,
  TimerHealthTracker,
} from './timer-health.js';

describe('TimerHealthTracker (issue #1771)', () => {
  test('registers loops, stamps lastFiredAt, and computes overdue from last fire', () => {
    let nowMs = Date.parse('2026-08-01T10:00:00.000Z');
    const tracker = new TimerHealthTracker(() => nowMs);

    tracker.register('tokenScan', 5_000);
    tracker.register('save', 60_000);

    let snap = tracker.snapshot();
    expect(snap.schemaVersion).toBe(TIMER_HEALTH_SCHEMA_VERSION);
    expect(snap.loops).toHaveLength(2);
    expect(snap.loops.find((l) => l.name === 'tokenScan')).toMatchObject({
      lastFiredAt: null,
      expectedIntervalMs: 5_000,
      overdue: false,
    });

    nowMs += 1_000;
    tracker.recordFire('tokenScan');
    snap = tracker.snapshot();
    expect(snap.loops.find((l) => l.name === 'tokenScan')).toMatchObject({
      lastFiredAt: '2026-08-01T10:00:01.000Z',
      overdue: false,
    });

    // Just past 2× cadence since last fire → overdue.
    nowMs += 5_000 * TIMER_HEALTH_OVERDUE_INTERVALS + 1;
    snap = tracker.snapshot();
    expect(snap.loops.find((l) => l.name === 'tokenScan')?.overdue).toBe(true);
    // save never fired but age since register is still under 2× 60s.
    expect(snap.loops.find((l) => l.name === 'save')?.overdue).toBe(false);
  });

  test('never-fired loop becomes overdue after 2× expected interval from register', () => {
    let nowMs = Date.parse('2026-08-01T12:00:00.000Z');
    const tracker = new TimerHealthTracker(() => nowMs);
    tracker.register('liveness', 10_000);

    nowMs += 10_000 * TIMER_HEALTH_OVERDUE_INTERVALS;
    expect(tracker.snapshot().loops[0]?.overdue).toBe(false);

    nowMs += 1;
    expect(tracker.snapshot().loops[0]?.overdue).toBe(true);
    expect(tracker.snapshot().loops[0]?.lastFiredAt).toBeNull();
  });

  test('recordFire can refresh expectedIntervalMs for adaptive quota poll', () => {
    let nowMs = Date.parse('2026-08-01T14:00:00.000Z');
    const tracker = new TimerHealthTracker(() => nowMs);
    tracker.register('quotaPoll', 120_000);
    tracker.recordFire('quotaPoll', 240_000);
    expect(tracker.snapshot().loops[0]).toMatchObject({
      name: 'quotaPoll',
      expectedIntervalMs: 240_000,
      lastFiredAt: '2026-08-01T14:00:00.000Z',
      overdue: false,
    });
  });

  test('snapshot lists loops in stable name order', () => {
    const tracker = new TimerHealthTracker(() => Date.parse('2026-08-01T00:00:00.000Z'));
    tracker.register('watchdog', 5_000);
    tracker.register('liveness', 15_000);
    tracker.register('save', 60_000);
    expect(tracker.snapshot().loops.map((l) => l.name)).toEqual([
      'liveness',
      'save',
      'watchdog',
    ]);
  });
});
