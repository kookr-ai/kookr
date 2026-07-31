import { describe, expect, test } from 'vitest';
import {
  DEFAULT_LIVENESS_SWEEP_ENABLED,
  readDashboardFanoutConfigFromEnv,
} from './websocket-backpressure-config.js';
import { DEFAULT_BACKPRESSURE_DISCONNECT_AFTER_SKIPS } from './viewer-broadcaster.js';

describe('readDashboardFanoutConfigFromEnv', () => {
  test('defaults', () => {
    expect(readDashboardFanoutConfigFromEnv({})).toEqual({
      backpressureDisconnectAfterSkips: DEFAULT_BACKPRESSURE_DISCONNECT_AFTER_SKIPS,
      livenessSweepEnabled: DEFAULT_LIVENESS_SWEEP_ENABLED,
    });
  });

  test('parses explicit values', () => {
    expect(readDashboardFanoutConfigFromEnv({
      KOOKR_WS_BACKPRESSURE_DISCONNECT_AFTER_SKIPS: '10',
      KOOKR_WS_LIVENESS_SWEEP_ENABLED: 'false',
    })).toEqual({
      backpressureDisconnectAfterSkips: 10,
      livenessSweepEnabled: false,
    });
  });

  test.each(['0', 'false', 'off', 'no', 'FALSE', 'Off'])('%s disables the liveness sweep', (val) => {
    expect(readDashboardFanoutConfigFromEnv({ KOOKR_WS_LIVENESS_SWEEP_ENABLED: val }).livenessSweepEnabled).toBe(false);
  });

  test.each(['1', 'true', 'on', 'yes', 'TRUE'])('%s enables the liveness sweep', (val) => {
    expect(readDashboardFanoutConfigFromEnv({ KOOKR_WS_LIVENESS_SWEEP_ENABLED: val }).livenessSweepEnabled).toBe(true);
  });

  test('0 disables the sustained-skip disconnect (opt-out convention, R9)', () => {
    expect(readDashboardFanoutConfigFromEnv({ KOOKR_WS_BACKPRESSURE_DISCONNECT_AFTER_SKIPS: '0' }).backpressureDisconnectAfterSkips)
      .toBe(0);
  });

  test('invalid/blank/negative values fall back to defaults', () => {
    expect(readDashboardFanoutConfigFromEnv({ KOOKR_WS_BACKPRESSURE_DISCONNECT_AFTER_SKIPS: '1.5' }).backpressureDisconnectAfterSkips)
      .toBe(DEFAULT_BACKPRESSURE_DISCONNECT_AFTER_SKIPS);
    expect(readDashboardFanoutConfigFromEnv({ KOOKR_WS_BACKPRESSURE_DISCONNECT_AFTER_SKIPS: '-1' }).backpressureDisconnectAfterSkips)
      .toBe(DEFAULT_BACKPRESSURE_DISCONNECT_AFTER_SKIPS);
    expect(readDashboardFanoutConfigFromEnv({ KOOKR_WS_LIVENESS_SWEEP_ENABLED: 'garbage' }).livenessSweepEnabled)
      .toBe(DEFAULT_LIVENESS_SWEEP_ENABLED);
  });
});
