import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_LOAD_SHED_EVENT_LOOP_DELAY_MS,
  DEFAULT_LOAD_SHED_RECOVER_TICKS,
  DEFAULT_LOAD_SHED_SUSTAIN_TICKS,
  readLoadShedConfigFromEnv,
  WebSocketLoadShedGate,
  type WebSocketLoadShedConfig,
} from './websocket-load-shed.js';

const cfg = (over: Partial<WebSocketLoadShedConfig> = {}): WebSocketLoadShedConfig => ({
  eventLoopDelayThresholdMs: 100,
  sustainTicks: 3,
  recoverTicks: 3,
  ...over,
});

describe('readLoadShedConfigFromEnv', () => {
  test('defaults', () => {
    const config = readLoadShedConfigFromEnv({});
    expect(config).toEqual({
      eventLoopDelayThresholdMs: DEFAULT_LOAD_SHED_EVENT_LOOP_DELAY_MS,
      sustainTicks: DEFAULT_LOAD_SHED_SUSTAIN_TICKS,
      recoverTicks: DEFAULT_LOAD_SHED_RECOVER_TICKS,
    });
  });

  test('parses explicit values', () => {
    const config = readLoadShedConfigFromEnv({
      KOOKR_WS_LOAD_SHED_EVENT_LOOP_DELAY_MS: '250',
      KOOKR_WS_LOAD_SHED_SUSTAIN_TICKS: '5',
      KOOKR_WS_LOAD_SHED_RECOVER_TICKS: '2',
    });
    expect(config).toEqual({ eventLoopDelayThresholdMs: 250, sustainTicks: 5, recoverTicks: 2 });
  });

  test('0 threshold disables shedding (opt-out convention)', () => {
    expect(readLoadShedConfigFromEnv({ KOOKR_WS_LOAD_SHED_EVENT_LOOP_DELAY_MS: '0' }).eventLoopDelayThresholdMs).toBe(0);
  });

  test('invalid/blank values fall back to defaults', () => {
    expect(readLoadShedConfigFromEnv({ KOOKR_WS_LOAD_SHED_SUSTAIN_TICKS: '0' }).sustainTicks)
      .toBe(DEFAULT_LOAD_SHED_SUSTAIN_TICKS);
    expect(readLoadShedConfigFromEnv({ KOOKR_WS_LOAD_SHED_RECOVER_TICKS: 'abc' }).recoverTicks)
      .toBe(DEFAULT_LOAD_SHED_RECOVER_TICKS);
    expect(readLoadShedConfigFromEnv({ KOOKR_WS_LOAD_SHED_EVENT_LOOP_DELAY_MS: '-5' }).eventLoopDelayThresholdMs)
      .toBe(0);
  });
});

describe('WebSocketLoadShedGate', () => {
  test('does not engage before sustainTicks consecutive over-threshold samples', () => {
    const logger = { warn: vi.fn() };
    const gate = new WebSocketLoadShedGate(cfg({ sustainTicks: 3 }), { logger });

    expect(gate.noteSample(200)).toBe(false);
    expect(gate.noteSample(200)).toBe(false);
    expect(gate.isActive).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('engages on the Nth consecutive over-threshold sample and logs once', () => {
    const logger = { warn: vi.fn() };
    const gate = new WebSocketLoadShedGate(cfg({ sustainTicks: 3 }), { logger });

    gate.noteSample(200);
    gate.noteSample(200);
    expect(gate.noteSample(200)).toBe(true);
    expect(gate.isActive).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('load-shed mode engaged');

    // Staying above threshold does not re-log per sample (no log storm).
    gate.noteSample(200);
    gate.noteSample(200);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('a single under-threshold sample resets the above-streak (must be consecutive)', () => {
    const gate = new WebSocketLoadShedGate(cfg({ sustainTicks: 3 }));
    gate.noteSample(200);
    gate.noteSample(200);
    gate.noteSample(50); // breaks the streak
    gate.noteSample(200);
    gate.noteSample(200);
    expect(gate.isActive).toBe(false);
  });

  test('recovers only after recoverTicks consecutive under-threshold samples, and logs once', () => {
    const logger = { warn: vi.fn() };
    const gate = new WebSocketLoadShedGate(cfg({ sustainTicks: 2, recoverTicks: 2 }), { logger });
    gate.noteSample(200);
    gate.noteSample(200);
    expect(gate.isActive).toBe(true);

    expect(gate.noteSample(50)).toBe(true); // still active, only 1 under-sample so far
    expect(gate.noteSample(50)).toBe(false); // 2nd consecutive under-sample: recovers
    expect(gate.isActive).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(2); // 1 engage + 1 recover
    expect(logger.warn.mock.calls[1][0]).toContain('load-shed mode recovered');
  });

  test('missing/non-finite samples never move the streaks (fail open like the #1590 admission gate)', () => {
    const gate = new WebSocketLoadShedGate(cfg({ sustainTicks: 2 }));
    gate.noteSample(200);
    expect(gate.noteSample(null)).toBe(false);
    expect(gate.noteSample(undefined)).toBe(false);
    expect(gate.noteSample(Number.NaN)).toBe(false);
    // The original streak of 1 must still be intact — one more over-threshold sample engages.
    expect(gate.noteSample(200)).toBe(true);
  });

  test('threshold <= 0 disables the gate even under sustained saturation', () => {
    const gate = new WebSocketLoadShedGate(cfg({ eventLoopDelayThresholdMs: 0 }));
    for (let i = 0; i < 10; i++) gate.noteSample(999_999);
    expect(gate.isActive).toBe(false);
  });

  test('lastEventLoopDelayP95Ms tracks the most recent finite sample and starts null', () => {
    const gate = new WebSocketLoadShedGate(cfg());
    expect(gate.lastEventLoopDelayP95Ms).toBeNull();
    gate.noteSample(42);
    expect(gate.lastEventLoopDelayP95Ms).toBe(42);
    gate.noteSample(null); // missing sample does not clobber the last known value
    expect(gate.lastEventLoopDelayP95Ms).toBe(42);
    gate.noteSample(7);
    expect(gate.lastEventLoopDelayP95Ms).toBe(7);
  });

  test('recordSkippedSnapshot / skippedSinceEngaged track and reset around an episode', () => {
    const gate = new WebSocketLoadShedGate(cfg({ sustainTicks: 1, recoverTicks: 1 }));
    gate.noteSample(200); // engages
    gate.recordSkippedSnapshot();
    gate.recordSkippedSnapshot();
    expect(gate.skippedSinceEngaged).toBe(2);
    gate.noteSample(50); // recovers, resets the counter
    expect(gate.skippedSinceEngaged).toBe(0);
  });
});
