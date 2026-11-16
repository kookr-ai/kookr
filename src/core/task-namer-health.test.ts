import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  emptyTaskNamerHealthState,
  evaluateTaskNamerHealth,
  readTaskNamerAlertThresholdMs,
  recordTaskNamerOutcome,
  TaskNamerHealthTracker,
  type TaskNamerHealthState,
  type TaskNamerOutcome,
} from './task-namer-health.js';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-11-16T00:00:00.000Z');
const ON = { enabled: true, thresholdMs: 6 * HOUR };

function replay(events: Array<[TaskNamerOutcome, number]>): TaskNamerHealthState {
  return events.reduce(
    (state, [outcome, at]) => recordTaskNamerOutcome(state, outcome, at),
    emptyTaskNamerHealthState(),
  );
}

describe('evaluateTaskNamerHealth (issue #3616)', () => {
  test('fresh install: enabled, not silent, nothing recorded', () => {
    expect(evaluateTaskNamerHealth(emptyTaskNamerHealthState(), ON)).toEqual({
      enabled: true,
      silent: false,
      thresholdMs: 6 * HOUR,
      lastSuccessAt: null,
      failingSince: null,
      lastFailureAt: null,
      failedAttempts: 0,
    });
  });

  test('every attempt failing across the threshold makes the namer silent', () => {
    const state = replay([['success', T0], ['failure', T0 + HOUR], ['failure', T0 + 4 * HOUR], ['failure', T0 + 7 * HOUR]]);
    expect(evaluateTaskNamerHealth(state, ON)).toMatchObject({
      silent: true,
      lastSuccessAt: '2026-11-16T00:00:00.000Z',
      failingSince: '2026-11-16T01:00:00.000Z',
      lastFailureAt: '2026-11-16T07:00:00.000Z',
      failedAttempts: 3,
    });
  });

  test('a streak exactly at the threshold fires; one millisecond short does not', () => {
    expect(evaluateTaskNamerHealth(replay([['failure', T0], ['failure', T0 + 6 * HOUR]]), ON).silent).toBe(true);
    expect(evaluateTaskNamerHealth(replay([['failure', T0], ['failure', T0 + 6 * HOUR - 1]]), ON).silent).toBe(false);
  });

  test('one failure after a long idle gap is not silent: the streak is measured between failures', () => {
    // Last success 20 hours before the only failure; no attempts in between.
    const state = replay([['success', T0], ['failure', T0 + 20 * HOUR]]);
    expect(evaluateTaskNamerHealth(state, ON).silent).toBe(false);
  });

  test('a single success clears the streak', () => {
    const state = replay([['failure', T0], ['failure', T0 + 8 * HOUR], ['success', T0 + 9 * HOUR]]);
    expect(evaluateTaskNamerHealth(state, ON)).toMatchObject({
      silent: false,
      failingSince: null,
      lastFailureAt: null,
      failedAttempts: 0,
      lastSuccessAt: new Date(T0 + 9 * HOUR).toISOString(),
    });
  });

  test('a failure after a success starts a new streak from that failure', () => {
    const state = replay([['failure', T0], ['success', T0 + HOUR], ['failure', T0 + 2 * HOUR], ['failure', T0 + 7 * HOUR]]);
    expect(evaluateTaskNamerHealth(state, ON)).toMatchObject({ silent: false, failedAttempts: 2 });
  });

  test('no LLM provider configured, or threshold 0: disabled and never silent', () => {
    const dead = replay([['failure', T0], ['failure', T0 + 30 * HOUR]]);
    expect(evaluateTaskNamerHealth(dead, { enabled: false, thresholdMs: 6 * HOUR })).toMatchObject({ enabled: false, silent: false });
    expect(evaluateTaskNamerHealth(dead, { enabled: true, thresholdMs: 0 })).toMatchObject({ enabled: false, silent: false });
  });
});

describe('readTaskNamerAlertThresholdMs', () => {
  test.each([
    [undefined, 6 * HOUR],
    ['', 6 * HOUR],
    ['  ', 6 * HOUR],
    ['abc', 6 * HOUR],
    ['2', 2 * HOUR],
    ['0.5', HOUR / 2],
    ['0', 0],
    ['-3', 0],
  ])('KOOKR_TASK_NAMER_ALERT_HOURS=%j → %i ms', (raw, expected) => {
    expect(readTaskNamerAlertThresholdMs(raw === undefined ? {} : { KOOKR_TASK_NAMER_ALERT_HOURS: raw })).toBe(expected);
  });
});

describe('TaskNamerHealthTracker persistence', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
    vi.restoreAllMocks();
  });

  function tempPath(): string {
    dir = mkdtempSync(join(tmpdir(), 'task-namer-health-'));
    return join(dir, 'task-namer-health.json');
  }

  test('a streak survives a restart and keeps counting', () => {
    const path = tempPath();
    let now = T0;
    const before = new TaskNamerHealthTracker({ path, ...ON, now: () => now });
    before.record('failure');
    now = T0 + 3 * HOUR;
    before.record('failure');
    expect(before.snapshot().silent).toBe(false);

    // The server restarts: a new tracker reads the same file.
    const after = new TaskNamerHealthTracker({ path, ...ON, now: () => now });
    expect(after.snapshot()).toMatchObject({ failedAttempts: 2, failingSince: new Date(T0).toISOString() });
    now = T0 + 6 * HOUR;
    after.record('failure');
    expect(after.snapshot()).toMatchObject({ silent: true, failedAttempts: 3 });
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({
      lastSuccessAt: null,
      failingSince: T0,
      lastFailureAt: T0 + 6 * HOUR,
      failedAttempts: 3,
    });
  });

  test('a missing or corrupt file starts empty', () => {
    const path = tempPath();
    expect(new TaskNamerHealthTracker({ path, ...ON }).snapshot().failedAttempts).toBe(0);
    writeFileSync(path, '{"lastSuccessAt": "yesterday", "failedAttempts": 2');
    expect(new TaskNamerHealthTracker({ path, ...ON }).snapshot().failedAttempts).toBe(0);
    writeFileSync(path, JSON.stringify({ lastSuccessAt: null, failingSince: null, lastFailureAt: null, failedAttempts: -1 }));
    expect(new TaskNamerHealthTracker({ path, ...ON }).snapshot().failedAttempts).toBe(0);
  });

  test('a failed save is logged and never throws into naming', () => {
    const path = tempPath();
    // A directory where the file should be makes the rename fail.
    const blocked = join(path, 'nested', 'x');
    writeFileSync(path, 'not a directory');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tracker = new TaskNamerHealthTracker({ path: blocked, ...ON });
    expect(() => tracker.record('failure')).not.toThrow();
    expect(tracker.snapshot().failedAttempts).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('namer health record'), expect.anything());
  });
});
