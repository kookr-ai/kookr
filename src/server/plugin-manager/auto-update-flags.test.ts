import { describe, test, expect } from 'vitest';
import {
  autoUpdateApplyEnabled,
  autoUpdateSweepIntervalMs,
  DEFAULT_AUTO_UPDATE_SWEEP_MS,
} from './auto-update-flags.js';

describe('auto-update flags', () => {
  test('apply gate is off unless explicitly 1/true', () => {
    expect(autoUpdateApplyEnabled({})).toBe(false);
    expect(autoUpdateApplyEnabled({ KOOKR_PLUGIN_AUTO_UPDATE: '0' })).toBe(false);
    expect(autoUpdateApplyEnabled({ KOOKR_PLUGIN_AUTO_UPDATE: '1' })).toBe(true);
    expect(autoUpdateApplyEnabled({ KOOKR_PLUGIN_AUTO_UPDATE: 'true' })).toBe(true);
  });

  test('sweep interval: valid ≥60s override wins, else the default', () => {
    expect(autoUpdateSweepIntervalMs({})).toBe(DEFAULT_AUTO_UPDATE_SWEEP_MS);
    expect(autoUpdateSweepIntervalMs({ KOOKR_PLUGIN_AUTO_UPDATE_INTERVAL_MS: '120000' })).toBe(120000);
    // Below the 60s floor, non-numeric, and negative all fall back to the default.
    expect(autoUpdateSweepIntervalMs({ KOOKR_PLUGIN_AUTO_UPDATE_INTERVAL_MS: '5000' })).toBe(DEFAULT_AUTO_UPDATE_SWEEP_MS);
    expect(autoUpdateSweepIntervalMs({ KOOKR_PLUGIN_AUTO_UPDATE_INTERVAL_MS: 'abc' })).toBe(DEFAULT_AUTO_UPDATE_SWEEP_MS);
    expect(autoUpdateSweepIntervalMs({ KOOKR_PLUGIN_AUTO_UPDATE_INTERVAL_MS: '-1' })).toBe(DEFAULT_AUTO_UPDATE_SWEEP_MS);
  });
});
