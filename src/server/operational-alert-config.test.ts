import { describe, expect, test, afterEach } from 'vitest';
import {
  getOperationalAlertConfig,
  getOperationalAlertConfigState,
  resetOperationalAlertConfig,
  setOperationalAlertConfig,
} from './operational-alert-config.js';
import {
  DEFAULT_OPERATIONAL_ALERT_CIRCUIT_BREAKER_OPEN_MS,
  DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_BYTES,
  DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT,
  DEFAULT_OPERATIONAL_ALERT_PROCESS_RSS_BYTES,
  DEFAULT_OPERATIONAL_ALERT_PROVIDER_FALLBACK_SUBSTITUTIONS,
  DEFAULT_OPERATIONAL_ALERT_PROVIDER_FALLBACK_WINDOW_MS,
  DEFAULT_OPERATIONAL_ALERT_PROVIDER_PAUSED_MS,
  DEFAULT_OPERATIONAL_ALERT_SUSTAIN_SAMPLES,
} from './config.js';

describe('operational-alert-config runtime holder', () => {
  afterEach(() => {
    resetOperationalAlertConfig({});
  });

  test('seeds current and default config from env', () => {
    resetOperationalAlertConfig({
      KOOKR_ALERT_CPU_PERCENT: '91',
      KOOKR_ALERT_MEMORY_PERCENT: '82',
      KOOKR_ALERT_EVENT_LOOP_DELAY_MS: '150',
      KOOKR_ALERT_DATA_DIR_FREE_PERCENT: '4',
      KOOKR_ALERT_DATA_DIR_FREE_BYTES: '1000',
      KOOKR_ALERT_CIRCUIT_BREAKER_OPEN_MS: '120000',
      KOOKR_ALERT_SUSTAIN_SAMPLES: '4',
    });

    expect(getOperationalAlertConfigState()).toEqual({
      config: {
        cpuPercent: 91,
        memoryPercent: 82,
        eventLoopDelayMs: 150,
        processRssBytes: DEFAULT_OPERATIONAL_ALERT_PROCESS_RSS_BYTES,
        dataDirectoryFreePercent: 4,
        dataDirectoryFreeBytes: 1000,
        circuitBreakerOpenMs: 120_000,
        providerFallbackSubstitutions: DEFAULT_OPERATIONAL_ALERT_PROVIDER_FALLBACK_SUBSTITUTIONS,
        providerFallbackWindowMs: DEFAULT_OPERATIONAL_ALERT_PROVIDER_FALLBACK_WINDOW_MS,
        providerPausedMs: DEFAULT_OPERATIONAL_ALERT_PROVIDER_PAUSED_MS,
        sustainSamples: 4,
      },
      default: {
        cpuPercent: 91,
        memoryPercent: 82,
        eventLoopDelayMs: 150,
        processRssBytes: DEFAULT_OPERATIONAL_ALERT_PROCESS_RSS_BYTES,
        dataDirectoryFreePercent: 4,
        dataDirectoryFreeBytes: 1000,
        circuitBreakerOpenMs: 120_000,
        providerFallbackSubstitutions: DEFAULT_OPERATIONAL_ALERT_PROVIDER_FALLBACK_SUBSTITUTIONS,
        providerFallbackWindowMs: DEFAULT_OPERATIONAL_ALERT_PROVIDER_FALLBACK_WINDOW_MS,
        providerPausedMs: DEFAULT_OPERATIONAL_ALERT_PROVIDER_PAUSED_MS,
        sustainSamples: 4,
      },
    });
  });

  test('applies a partial update without changing boot defaults', () => {
    resetOperationalAlertConfig({ KOOKR_ALERT_CPU_PERCENT: '70' });

    expect(setOperationalAlertConfig({
      memoryPercent: 88,
      circuitBreakerOpenMs: 45_000,
      sustainSamples: 2,
    })).toEqual({ ok: true });

    expect(getOperationalAlertConfigState()).toEqual({
      config: {
        cpuPercent: 70,
        memoryPercent: 88,
        eventLoopDelayMs: 0,
        processRssBytes: DEFAULT_OPERATIONAL_ALERT_PROCESS_RSS_BYTES,
        dataDirectoryFreePercent: DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT,
        dataDirectoryFreeBytes: DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_BYTES,
        circuitBreakerOpenMs: 45_000,
        providerFallbackSubstitutions: DEFAULT_OPERATIONAL_ALERT_PROVIDER_FALLBACK_SUBSTITUTIONS,
        providerFallbackWindowMs: DEFAULT_OPERATIONAL_ALERT_PROVIDER_FALLBACK_WINDOW_MS,
        providerPausedMs: DEFAULT_OPERATIONAL_ALERT_PROVIDER_PAUSED_MS,
        sustainSamples: 2,
      },
      default: {
        cpuPercent: 70,
        memoryPercent: 0,
        eventLoopDelayMs: 0,
        processRssBytes: DEFAULT_OPERATIONAL_ALERT_PROCESS_RSS_BYTES,
        dataDirectoryFreePercent: DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT,
        dataDirectoryFreeBytes: DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_BYTES,
        circuitBreakerOpenMs: DEFAULT_OPERATIONAL_ALERT_CIRCUIT_BREAKER_OPEN_MS,
        providerFallbackSubstitutions: DEFAULT_OPERATIONAL_ALERT_PROVIDER_FALLBACK_SUBSTITUTIONS,
        providerFallbackWindowMs: DEFAULT_OPERATIONAL_ALERT_PROVIDER_FALLBACK_WINDOW_MS,
        providerPausedMs: DEFAULT_OPERATIONAL_ALERT_PROVIDER_PAUSED_MS,
        sustainSamples: DEFAULT_OPERATIONAL_ALERT_SUSTAIN_SAMPLES,
      },
    });
  });

  test('returns clones so callers cannot mutate holder state by reference', () => {
    resetOperationalAlertConfig({ KOOKR_ALERT_CPU_PERCENT: '70' });

    const config = getOperationalAlertConfig();
    config.cpuPercent = 1;

    expect(getOperationalAlertConfig().cpuPercent).toBe(70);
  });

  test('rejects invalid updates without partially applying prior fields', () => {
    resetOperationalAlertConfig({ KOOKR_ALERT_CPU_PERCENT: '70' });

    expect(setOperationalAlertConfig({ memoryPercent: 88, sustainSamples: 0 })).toEqual({
      ok: false,
      error: 'invalid-sustain-samples',
      field: 'sustainSamples',
    });

    expect(getOperationalAlertConfig()).toEqual({
      cpuPercent: 70,
      memoryPercent: 0,
      eventLoopDelayMs: 0,
      processRssBytes: DEFAULT_OPERATIONAL_ALERT_PROCESS_RSS_BYTES,
      dataDirectoryFreePercent: DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_PERCENT,
      dataDirectoryFreeBytes: DEFAULT_OPERATIONAL_ALERT_DATA_DIR_FREE_BYTES,
      circuitBreakerOpenMs: DEFAULT_OPERATIONAL_ALERT_CIRCUIT_BREAKER_OPEN_MS,
      providerFallbackSubstitutions: DEFAULT_OPERATIONAL_ALERT_PROVIDER_FALLBACK_SUBSTITUTIONS,
      providerFallbackWindowMs: DEFAULT_OPERATIONAL_ALERT_PROVIDER_FALLBACK_WINDOW_MS,
      providerPausedMs: DEFAULT_OPERATIONAL_ALERT_PROVIDER_PAUSED_MS,
      sustainSamples: DEFAULT_OPERATIONAL_ALERT_SUSTAIN_SAMPLES,
    });
  });

  test('rejects non-object, empty, negative, and non-integer updates', () => {
    expect(setOperationalAlertConfig(null)).toEqual({ ok: false, error: 'invalid-payload' });
    expect(setOperationalAlertConfig({ unrelated: true })).toEqual({ ok: false, error: 'empty-update' });
    expect(setOperationalAlertConfig({ cpuPercent: -1 })).toEqual({
      ok: false,
      error: 'invalid-threshold',
      field: 'cpuPercent',
    });
    expect(setOperationalAlertConfig({ sustainSamples: 1.5 })).toEqual({
      ok: false,
      error: 'invalid-sustain-samples',
      field: 'sustainSamples',
    });
  });
});
