import { describe, expect, test } from 'vitest';
import {
  DEFAULT_NON_CRITICAL_TIMER_PAUSE_EVENT_LOOP_DELAY_MS,
  NonCriticalTimerPauseGate,
  createNonCriticalTimerPauseGate,
  readNonCriticalTimerPauseConfigFromEnv,
  shouldSkipNonCriticalTimerTick,
} from './non-critical-timer-pause.js';

describe('shouldSkipNonCriticalTimerTick', () => {
  test('skips when delayP95 is strictly greater than threshold', () => {
    expect(shouldSkipNonCriticalTimerTick({ eventLoopDelayP95Ms: 1_501, thresholdMs: 1_500 })).toBe(true);
    expect(shouldSkipNonCriticalTimerTick({ eventLoopDelayP95Ms: 5_000, thresholdMs: 1_500 })).toBe(true);
  });

  test('does not skip at or below threshold (strict >)', () => {
    expect(shouldSkipNonCriticalTimerTick({ eventLoopDelayP95Ms: 1_500, thresholdMs: 1_500 })).toBe(false);
    expect(shouldSkipNonCriticalTimerTick({ eventLoopDelayP95Ms: 0, thresholdMs: 1_500 })).toBe(false);
    expect(shouldSkipNonCriticalTimerTick({ eventLoopDelayP95Ms: 1_499.9, thresholdMs: 1_500 })).toBe(false);
  });

  test('fails open when threshold is disabled (0) or non-positive', () => {
    expect(shouldSkipNonCriticalTimerTick({ eventLoopDelayP95Ms: 50_000, thresholdMs: 0 })).toBe(false);
    expect(shouldSkipNonCriticalTimerTick({ eventLoopDelayP95Ms: 50_000, thresholdMs: -1 })).toBe(false);
  });

  test('fails open when sample is missing or non-finite', () => {
    expect(shouldSkipNonCriticalTimerTick({ eventLoopDelayP95Ms: null, thresholdMs: 1_500 })).toBe(false);
    expect(shouldSkipNonCriticalTimerTick({ eventLoopDelayP95Ms: undefined, thresholdMs: 1_500 })).toBe(false);
    expect(shouldSkipNonCriticalTimerTick({ eventLoopDelayP95Ms: Number.NaN, thresholdMs: 1_500 })).toBe(false);
    expect(shouldSkipNonCriticalTimerTick({ eventLoopDelayP95Ms: Number.POSITIVE_INFINITY, thresholdMs: 1_500 })).toBe(false);
  });
});

describe('readNonCriticalTimerPauseConfigFromEnv', () => {
  test('defaults to the documented threshold when unset', () => {
    expect(readNonCriticalTimerPauseConfigFromEnv({}).eventLoopDelayThresholdMs)
      .toBe(DEFAULT_NON_CRITICAL_TIMER_PAUSE_EVENT_LOOP_DELAY_MS);
  });

  test('parses a custom threshold and treats 0 as disabled', () => {
    expect(readNonCriticalTimerPauseConfigFromEnv({
      KOOKR_NON_CRITICAL_TIMER_PAUSE_EVENT_LOOP_DELAY_MS: '250',
    }).eventLoopDelayThresholdMs).toBe(250);
    expect(readNonCriticalTimerPauseConfigFromEnv({
      KOOKR_NON_CRITICAL_TIMER_PAUSE_EVENT_LOOP_DELAY_MS: '0',
    }).eventLoopDelayThresholdMs).toBe(0);
  });

  test('falls back on invalid / blank values; clamps negatives to 0', () => {
    expect(readNonCriticalTimerPauseConfigFromEnv({
      KOOKR_NON_CRITICAL_TIMER_PAUSE_EVENT_LOOP_DELAY_MS: 'NaN',
    }).eventLoopDelayThresholdMs).toBe(DEFAULT_NON_CRITICAL_TIMER_PAUSE_EVENT_LOOP_DELAY_MS);
    expect(readNonCriticalTimerPauseConfigFromEnv({
      KOOKR_NON_CRITICAL_TIMER_PAUSE_EVENT_LOOP_DELAY_MS: '',
    }).eventLoopDelayThresholdMs).toBe(DEFAULT_NON_CRITICAL_TIMER_PAUSE_EVENT_LOOP_DELAY_MS);
    expect(readNonCriticalTimerPauseConfigFromEnv({
      KOOKR_NON_CRITICAL_TIMER_PAUSE_EVENT_LOOP_DELAY_MS: '-5',
    }).eventLoopDelayThresholdMs).toBe(0);
  });
});

describe('NonCriticalTimerPauseGate', () => {
  test('skips after an elevated sample, resumes automatically when delay drops', () => {
    const gate = new NonCriticalTimerPauseGate({ eventLoopDelayThresholdMs: 1_000 });
    expect(gate.shouldSkipTick()).toBe(false); // fail open before first sample

    gate.noteSample(2_000);
    expect(gate.shouldSkipTick()).toBe(true);
    expect(gate.getSnapshot().paused).toBe(true);
    expect(gate.getSnapshot().lastEventLoopDelayP95Ms).toBe(2_000);

    gate.noteSample(100);
    expect(gate.shouldSkipTick()).toBe(false);
    expect(gate.getSnapshot().paused).toBe(false);
  });

  test('recordPause increments pausedTicksTotal (pause metric)', () => {
    const gate = createNonCriticalTimerPauseGate({ eventLoopDelayThresholdMs: 1_000 });
    gate.noteSample(5_000);
    expect(gate.recordPause('github-state-fetch')).toBe(1);
    expect(gate.recordPause('maintenancePrune')).toBe(2);
    expect(gate.getSnapshot().pausedTicksTotal).toBe(2);
  });

  test('null samples do not clear a prior elevated sample', () => {
    const gate = new NonCriticalTimerPauseGate({ eventLoopDelayThresholdMs: 1_000 });
    gate.noteSample(3_000);
    gate.noteSample(null);
    expect(gate.shouldSkipTick()).toBe(true);
  });

  test('disabled gate never skips even with elevated samples', () => {
    const gate = new NonCriticalTimerPauseGate({ eventLoopDelayThresholdMs: 0 });
    gate.noteSample(50_000);
    expect(gate.shouldSkipTick()).toBe(false);
    expect(gate.getSnapshot().thresholdMs).toBe(0);
  });
});
