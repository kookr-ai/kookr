import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAUSED_CONSECUTIVE_FAILURES,
  makePausedByFailureSnapshot,
} from './paused-schedules-fixture.js';

describe('makePausedByFailureSnapshot', () => {
  it('builds a ScheduleStatusSnapshot with schedulesPausedByFailure of the requested length', () => {
    const snapshot = makePausedByFailureSnapshot({
      count: 3,
      names: ['orchestrator', 'deploy-conv', 'sentinel'],
    });

    expect(snapshot.schedulesPausedByFailure).toEqual([
      { id: 'sched-1', name: 'orchestrator', consecutiveFailures: DEFAULT_PAUSED_CONSECUTIVE_FAILURES },
      { id: 'sched-2', name: 'deploy-conv', consecutiveFailures: DEFAULT_PAUSED_CONSECUTIVE_FAILURES },
      { id: 'sched-3', name: 'sentinel', consecutiveFailures: DEFAULT_PAUSED_CONSECUTIVE_FAILURES },
    ]);
    expect(snapshot.schedulesPausedByFailure).toHaveLength(3);
    expect(snapshot).toMatchObject({
      timezone: 'UTC',
      catchUpMode: 'manual',
      catchUpEnabled: false,
      schedulerHealthy: true,
    });
  });

  it('fills missing names and ignores extras', () => {
    const shortNames = makePausedByFailureSnapshot({ count: 2, names: ['orchestrator'] });
    expect(shortNames.schedulesPausedByFailure?.map((row) => row.name)).toEqual([
      'orchestrator',
      'paused-schedule-2',
    ]);

    const extraNames = makePausedByFailureSnapshot({
      count: 1,
      names: ['orchestrator', 'unused'],
    });
    expect(extraNames.schedulesPausedByFailure).toEqual([
      { id: 'sched-1', name: 'orchestrator', consecutiveFailures: DEFAULT_PAUSED_CONSECUTIVE_FAILURES },
    ]);
  });

  it('uses names.length when count is omitted', () => {
    const snapshot = makePausedByFailureSnapshot({ names: ['orchestrator', 'idea-scout'] });
    expect(snapshot.schedulesPausedByFailure).toHaveLength(2);
    expect(snapshot.schedulesPausedByFailure?.map((row) => row.name)).toEqual([
      'orchestrator',
      'idea-scout',
    ]);
  });

  it('emits an empty array when count is 0 or names is empty', () => {
    expect(makePausedByFailureSnapshot({ count: 0 }).schedulesPausedByFailure).toEqual([]);
    expect(makePausedByFailureSnapshot({ names: [] }).schedulesPausedByFailure).toEqual([]);
  });

  it('omits schedulesPausedByFailure when count and names are undefined', () => {
    const omitted = makePausedByFailureSnapshot();
    expect(omitted).not.toHaveProperty('schedulesPausedByFailure');
    expect(omitted.schedulesPausedByFailure).toBeUndefined();

    const explicitUndefined = makePausedByFailureSnapshot({});
    expect(explicitUndefined).not.toHaveProperty('schedulesPausedByFailure');
  });

  it('rejects a non-integer or negative count', () => {
    expect(() => makePausedByFailureSnapshot({ count: -1 })).toThrow(/non-negative integer/);
    expect(() => makePausedByFailureSnapshot({ count: 1.5 })).toThrow(/non-negative integer/);
    expect(() => makePausedByFailureSnapshot({ count: Number.NaN })).toThrow(/non-negative integer/);
  });
});
