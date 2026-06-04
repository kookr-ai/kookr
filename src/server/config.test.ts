import { describe, expect, test } from 'vitest';
import {
  DEFAULT_OPERATIONAL_ALERT_SUSTAIN_SAMPLES,
  readOperationalAlertConfigFromEnv,
} from './config.js';

describe('readOperationalAlertConfigFromEnv', () => {
  test('defaults to disabled thresholds when env is empty', () => {
    expect(readOperationalAlertConfigFromEnv({})).toEqual({
      cpuPercent: 0,
      memoryPercent: 0,
      eventLoopDelayMs: 0,
      sustainSamples: DEFAULT_OPERATIONAL_ALERT_SUSTAIN_SAMPLES,
    });
  });

  test('parses valid threshold values', () => {
    expect(
      readOperationalAlertConfigFromEnv({
        KOOKR_ALERT_CPU_PERCENT: '90',
        KOOKR_ALERT_MEMORY_PERCENT: '85.5',
        KOOKR_ALERT_EVENT_LOOP_DELAY_MS: '200',
        KOOKR_ALERT_SUSTAIN_SAMPLES: '5',
      }),
    ).toEqual({ cpuPercent: 90, memoryPercent: 85.5, eventLoopDelayMs: 200, sustainSamples: 5 });
  });

  test('clamps negative thresholds to 0 (disabled)', () => {
    const config = readOperationalAlertConfigFromEnv({
      KOOKR_ALERT_CPU_PERCENT: '-5',
      KOOKR_ALERT_MEMORY_PERCENT: '-0.1',
      KOOKR_ALERT_EVENT_LOOP_DELAY_MS: '-100',
    });
    expect(config.cpuPercent).toBe(0);
    expect(config.memoryPercent).toBe(0);
    expect(config.eventLoopDelayMs).toBe(0);
  });

  test('falls back to defaults for blank, non-numeric, or non-finite values', () => {
    const config = readOperationalAlertConfigFromEnv({
      KOOKR_ALERT_CPU_PERCENT: '   ',
      KOOKR_ALERT_MEMORY_PERCENT: 'abc',
      KOOKR_ALERT_EVENT_LOOP_DELAY_MS: 'Infinity',
    });
    expect(config.cpuPercent).toBe(0);
    expect(config.memoryPercent).toBe(0);
    expect(config.eventLoopDelayMs).toBe(0);
  });

  test('rejects fractional, zero, negative, or non-numeric sustainSamples', () => {
    for (const raw of ['3.5', '0', '-1', 'abc', '  ']) {
      expect(readOperationalAlertConfigFromEnv({ KOOKR_ALERT_SUSTAIN_SAMPLES: raw }).sustainSamples).toBe(
        DEFAULT_OPERATIONAL_ALERT_SUSTAIN_SAMPLES,
      );
    }
  });

  test('accepts integer-valued sustainSamples written with a trailing .0', () => {
    expect(
      readOperationalAlertConfigFromEnv({ KOOKR_ALERT_SUSTAIN_SAMPLES: '4.0' }).sustainSamples,
    ).toBe(4);
  });
});
