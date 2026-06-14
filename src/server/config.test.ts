import { describe, expect, test } from 'vitest';
import {
  DEFAULT_OPERATIONAL_ALERT_CIRCUIT_BREAKER_OPEN_MS,
  DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_BYTES,
  DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT,
  DEFAULT_OPERATIONAL_ALERT_SUSTAIN_SAMPLES,
  DEFAULT_REQUEST_BODY_LIMIT_BYTES,
  readOperationalAlertConfigFromEnv,
  readRequestBodyLimitBytesFromEnv,
} from './config.js';

describe('readOperationalAlertConfigFromEnv', () => {
  test('defaults CPU, memory, and event-loop thresholds off with conservative disk thresholds', () => {
    expect(readOperationalAlertConfigFromEnv({})).toEqual({
      cpuPercent: 0,
      memoryPercent: 0,
      eventLoopDelayMs: 0,
      dataDirectoryFreePercent: DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT,
      dataDirectoryFreeBytes: DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_BYTES,
      circuitBreakerOpenMs: DEFAULT_OPERATIONAL_ALERT_CIRCUIT_BREAKER_OPEN_MS,
      sustainSamples: DEFAULT_OPERATIONAL_ALERT_SUSTAIN_SAMPLES,
    });
  });

  test('parses valid threshold values', () => {
    expect(
      readOperationalAlertConfigFromEnv({
        KOOKR_ALERT_CPU_PERCENT: '90',
        KOOKR_ALERT_MEMORY_PERCENT: '85.5',
        KOOKR_ALERT_EVENT_LOOP_DELAY_MS: '200',
        KOOKR_ALERT_DATA_DIR_FREE_PERCENT: '4.5',
        KOOKR_ALERT_DATA_DIR_FREE_BYTES: '1073741824',
        KOOKR_ALERT_CIRCUIT_BREAKER_OPEN_MS: '120000',
        KOOKR_ALERT_SUSTAIN_SAMPLES: '5',
      }),
    ).toEqual({
      cpuPercent: 90,
      memoryPercent: 85.5,
      eventLoopDelayMs: 200,
      dataDirectoryFreePercent: 4.5,
      dataDirectoryFreeBytes: 1_073_741_824,
      circuitBreakerOpenMs: 120_000,
      sustainSamples: 5,
    });
  });

  test('clamps negative thresholds to 0 (disabled)', () => {
    const config = readOperationalAlertConfigFromEnv({
      KOOKR_ALERT_CPU_PERCENT: '-5',
      KOOKR_ALERT_MEMORY_PERCENT: '-0.1',
      KOOKR_ALERT_EVENT_LOOP_DELAY_MS: '-100',
      KOOKR_ALERT_DATA_DIR_FREE_PERCENT: '-1',
      KOOKR_ALERT_DATA_DIR_FREE_BYTES: '-1',
      KOOKR_ALERT_CIRCUIT_BREAKER_OPEN_MS: '-1',
    });
    expect(config.cpuPercent).toBe(0);
    expect(config.memoryPercent).toBe(0);
    expect(config.eventLoopDelayMs).toBe(0);
    expect(config.dataDirectoryFreePercent).toBe(0);
    expect(config.dataDirectoryFreeBytes).toBe(0);
    expect(config.circuitBreakerOpenMs).toBe(0);
  });

  test('falls back to defaults for blank, non-numeric, or non-finite values', () => {
    const config = readOperationalAlertConfigFromEnv({
      KOOKR_ALERT_CPU_PERCENT: '   ',
      KOOKR_ALERT_MEMORY_PERCENT: 'abc',
      KOOKR_ALERT_EVENT_LOOP_DELAY_MS: 'Infinity',
      KOOKR_ALERT_DATA_DIR_FREE_PERCENT: 'abc',
      KOOKR_ALERT_DATA_DIR_FREE_BYTES: 'Infinity',
      KOOKR_ALERT_CIRCUIT_BREAKER_OPEN_MS: 'abc',
    });
    expect(config.cpuPercent).toBe(0);
    expect(config.memoryPercent).toBe(0);
    expect(config.eventLoopDelayMs).toBe(0);
    expect(config.dataDirectoryFreePercent).toBe(DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT);
    expect(config.dataDirectoryFreeBytes).toBe(DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_BYTES);
    expect(config.circuitBreakerOpenMs).toBe(DEFAULT_OPERATIONAL_ALERT_CIRCUIT_BREAKER_OPEN_MS);
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

describe('readRequestBodyLimitBytesFromEnv', () => {
  test('defaults to the documented request body limit when env is empty', () => {
    expect(readRequestBodyLimitBytesFromEnv({})).toBe(DEFAULT_REQUEST_BODY_LIMIT_BYTES);
  });

  test('accepts a positive integer byte limit', () => {
    expect(readRequestBodyLimitBytesFromEnv({ KOOKR_REQUEST_BODY_LIMIT_BYTES: '2048' })).toBe(2048);
  });

  test('falls back to default for blank, zero, negative, fractional, or non-numeric values', () => {
    for (const raw of ['  ', '0', '-1', '3.5', 'abc', 'Infinity']) {
      expect(readRequestBodyLimitBytesFromEnv({ KOOKR_REQUEST_BODY_LIMIT_BYTES: raw })).toBe(
        DEFAULT_REQUEST_BODY_LIMIT_BYTES,
      );
    }
  });
});
