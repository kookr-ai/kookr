import { describe, test, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_SETTINGS, type KookrSettings } from '../core/settings-store.js';
import type { GitHubScannerService } from '../core/github-scanner-service.js';
import type { Watchdog } from '../core/watchdog.js';
import type { Monitor } from '../core/monitor.js';
import { applySettingsSideEffects } from './settings-side-effects.js';

const { mockSaveSettings } = vi.hoisted(() => ({
  mockSaveSettings: vi.fn(async () => undefined),
}));

vi.mock('../core/settings-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/settings-store.js')>();
  return {
    ...actual,
    saveSettings: mockSaveSettings,
  };
});

function settings(overrides: Partial<KookrSettings> = {}): KookrSettings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

function createDeps(prev: Partial<KookrSettings> = {}, next: Partial<KookrSettings> = {}) {
  const githubScanner = {
    stop: vi.fn(),
    start: vi.fn(async () => true),
    reconfigure: vi.fn(),
  };
  const watchdog = {
    reconfigure: vi.fn(),
  };
  const monitor = {
    setAnomalyConfig: vi.fn(),
  };

  return {
    prevSettings: settings(prev),
    newSettings: settings(next),
    settingsFile: '/tmp/kookr-settings-side-effects-test.json',
    githubScanner: githubScanner as unknown as GitHubScannerService,
    watchdog: watchdog as unknown as Watchdog,
    monitor: monitor as unknown as Monitor,
    spies: { githubScanner, watchdog, monitor },
  };
}

describe('applySettingsSideEffects', () => {
  beforeEach(() => {
    mockSaveSettings.mockClear();
    mockSaveSettings.mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  test('persists new settings via saveSettings before applying side effects', async () => {
    const deps = createDeps({}, { githubPollingEnabled: false });
    await applySettingsSideEffects(deps);
    expect(mockSaveSettings).toHaveBeenCalledOnce();
    expect(mockSaveSettings).toHaveBeenCalledWith(deps.settingsFile, deps.newSettings);
  });

  test('polling toggle off calls githubScanner.stop() and not reconfigure', async () => {
    const deps = createDeps(
      { githubPollingEnabled: true },
      { githubPollingEnabled: false },
    );

    const warnings = await applySettingsSideEffects(deps);

    expect(deps.spies.githubScanner.stop).toHaveBeenCalledOnce();
    expect(deps.spies.githubScanner.start).not.toHaveBeenCalled();
    expect(deps.spies.githubScanner.reconfigure).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  test('polling toggle on calls githubScanner.start() and not reconfigure', async () => {
    const deps = createDeps(
      { githubPollingEnabled: false },
      { githubPollingEnabled: true },
    );

    const warnings = await applySettingsSideEffects(deps);

    expect(deps.spies.githubScanner.start).toHaveBeenCalledOnce();
    expect(deps.spies.githubScanner.stop).not.toHaveBeenCalled();
    expect(deps.spies.githubScanner.reconfigure).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  test('interval-only change while enabled calls githubScanner.reconfigure()', async () => {
    const deps = createDeps(
      { githubPollingEnabled: true, githubPollingIntervalSec: 60 },
      { githubPollingEnabled: true, githubPollingIntervalSec: 120 },
    );

    const warnings = await applySettingsSideEffects(deps);

    expect(deps.spies.githubScanner.reconfigure).toHaveBeenCalledOnce();
    expect(deps.spies.githubScanner.reconfigure).toHaveBeenCalledWith({
      stateFetchIntervalMs: 120_000,
      referenceExtractionIntervalMs: 120_000,
    });
    expect(deps.spies.githubScanner.stop).not.toHaveBeenCalled();
    expect(deps.spies.githubScanner.start).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  test('interval change while polling disabled does not reconfigure', async () => {
    const deps = createDeps(
      { githubPollingEnabled: false, githubPollingIntervalSec: 60 },
      { githubPollingEnabled: false, githubPollingIntervalSec: 120 },
    );

    await applySettingsSideEffects(deps);

    expect(deps.spies.githubScanner.reconfigure).not.toHaveBeenCalled();
    expect(deps.spies.githubScanner.stop).not.toHaveBeenCalled();
    expect(deps.spies.githubScanner.start).not.toHaveBeenCalled();
  });

  test('watchdog.reconfigure throw is captured into returned warnings (no rethrow)', async () => {
    const deps = createDeps(
      { watchdogStaleThresholdSec: 30 },
      { watchdogStaleThresholdSec: 45 },
    );
    deps.spies.watchdog.reconfigure.mockImplementation(() => {
      throw new Error('boom-stale');
    });

    let warnings: string[] = [];
    await expect(
      (async () => {
        warnings = await applySettingsSideEffects(deps);
      })(),
    ).resolves.toBeUndefined();

    expect(deps.spies.watchdog.reconfigure).toHaveBeenCalledOnce();
    expect(deps.spies.watchdog.reconfigure).toHaveBeenCalledWith({
      staleThresholdMs: 45_000,
      unconditionalStaleThresholdMs: 90_000,
    });
    expect(warnings).toEqual(['watchdog reconfigure failed: boom-stale']);
  });

  test('watchdog.reconfigure non-Error throw is stringified into warnings', async () => {
    const deps = createDeps(
      { watchdogStaleThresholdSec: 30 },
      { watchdogStaleThresholdSec: 60 },
    );
    deps.spies.watchdog.reconfigure.mockImplementation(() => {
      throw 'raw-string-fail';
    });

    const warnings = await applySettingsSideEffects(deps);

    expect(warnings).toEqual(['watchdog reconfigure failed: raw-string-fail']);
  });

  test('anomaly-threshold change forwards to monitor.setAnomalyConfig', async () => {
    const deps = createDeps(
      { repeatedErrorThreshold: 3 },
      { repeatedErrorThreshold: 7 },
    );

    const warnings = await applySettingsSideEffects(deps);

    expect(deps.spies.monitor.setAnomalyConfig).toHaveBeenCalledOnce();
    expect(deps.spies.monitor.setAnomalyConfig).toHaveBeenCalledWith({
      repeatedErrorThreshold: 7,
    });
    expect(warnings).toEqual([]);
  });

  test('unchanged settings skip all reconfigure/start/stop side effects', async () => {
    const deps = createDeps({}, {});

    const warnings = await applySettingsSideEffects(deps);

    expect(deps.spies.githubScanner.stop).not.toHaveBeenCalled();
    expect(deps.spies.githubScanner.start).not.toHaveBeenCalled();
    expect(deps.spies.githubScanner.reconfigure).not.toHaveBeenCalled();
    expect(deps.spies.watchdog.reconfigure).not.toHaveBeenCalled();
    expect(deps.spies.monitor.setAnomalyConfig).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });
});
