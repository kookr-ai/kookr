import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type KookrSettings } from '../core/settings-store.js';
import type { GitHubScannerService } from '../core/github-scanner-service.js';
import type { Watchdog } from '../core/watchdog.js';
import type { Monitor } from '../core/monitor.js';
import { orchestratorShouldSpawn, resolveOrchestrationPausePath } from '../core/orchestration-pause.js';
import { applySettingsSideEffects } from './settings-side-effects.js';
import { readPauseRecordSync } from './orchestration-pause-service.js';

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

function createDeps(
  prev: Partial<KookrSettings> = {},
  next: Partial<KookrSettings> = {},
  extra: { kookrDir?: string } = {},
) {
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
    ...(extra.kookrDir ? { kookrDir: extra.kookrDir } : {}),
  };
}

function writePauseRecord(kookrDir: string, mechanism: string): string {
  const path = resolveOrchestrationPausePath(kookrDir);
  mkdirSync(join(kookrDir, 'playbook-state', 'orchestrator'), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 2,
      paused: true,
      source: 'human',
      reason: 'weekly quota window',
      pausedAt: '2026-08-22T00:00:00.000Z',
      pausedBy: 'jean',
      mechanism,
    }, null, 2)}\n`,
    'utf8',
  );
  return path;
}

describe('applySettingsSideEffects', () => {
  beforeEach(() => {
    mockSaveSettings.mockClear();
    mockSaveSettings.mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockReset().mockImplementation(() => {});
    vi.spyOn(console, 'error').mockReset().mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockReset().mockImplementation(() => {});
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

  // --- Phase-C capacity knobs (issue #1862): log old→new, no reconfigure ---
  // These knobs are live-getter only; operability requires a console line so
  // capacity flips are recoverable from logs during spawn-429 / hung-capacity
  // postmortems. Distinct from #1397 which covered reconfigure branches.

  test.each([
    {
      key: 'launchTimeoutSeconds' as const,
      prev: 180,
      next: 240,
      log: '[settings] launchTimeoutSeconds → 240s (was 180s)',
    },
    {
      key: 'deadManScheduleMinutes' as const,
      prev: 120,
      next: 60,
      log: '[settings] deadManScheduleMinutes → 60min (was 120min)',
    },
    {
      key: 'maxPendingTasks' as const,
      prev: 24,
      next: 48,
      log: '[settings] maxPendingTasks → 48 (was 24)',
    },
    {
      key: 'pendingTaskTtlMinutes' as const,
      prev: 240,
      next: 90,
      log: '[settings] pendingTaskTtlMinutes → 90min (was 240min)',
    },
    {
      key: 'spawnBurstLimit' as const,
      prev: 30,
      next: 10,
      log: '[settings] spawnBurstLimit → 10 (was 30)',
    },
    {
      key: 'spawnBurstWindowMinutes' as const,
      prev: 10,
      next: 30,
      log: '[settings] spawnBurstWindowMinutes → 30min (was 10min)',
    },
  ])(
    'Phase-C knob $key change logs old→new without reconfigure (#1862)',
    async ({ key, prev, next, log }) => {
      const deps = createDeps({ [key]: prev }, { [key]: next });

      const warnings = await applySettingsSideEffects(deps);

      expect(console.log).toHaveBeenCalledWith(log);
      // Live-getter knobs must never touch GH poll / watchdog / anomaly paths.
      expect(deps.spies.githubScanner.stop).not.toHaveBeenCalled();
      expect(deps.spies.githubScanner.start).not.toHaveBeenCalled();
      expect(deps.spies.githubScanner.reconfigure).not.toHaveBeenCalled();
      expect(deps.spies.watchdog.reconfigure).not.toHaveBeenCalled();
      expect(deps.spies.monitor.setAnomalyConfig).not.toHaveBeenCalled();
      expect(warnings).toEqual([]);
    },
  );

  describe('kill-switch-off clears kill-switch-created pause (issue #2743)', () => {
    let kookrDir: string;

    beforeEach(() => {
      kookrDir = mkdtempSync(join(tmpdir(), 'kookr-killswitch-pause-'));
    });
    afterEach(() => {
      rmSync(kookrDir, { recursive: true, force: true });
    });

    test('human kill-switch pause is cleared when the switch turns off', async () => {
      const path = writePauseRecord(kookrDir, 'automationKillSwitch');
      const deps = createDeps(
        { automationKillSwitch: true, safeModeSince: '2026-08-22T00:00:00.000Z' },
        { automationKillSwitch: false, safeModeSince: null },
        { kookrDir },
      );

      await applySettingsSideEffects(deps);

      expect(existsSync(path)).toBe(true);
      expect(readPauseRecordSync(kookrDir)).toBeNull();
      expect(orchestratorShouldSpawn({
        safeModeEngaged: false,
        record: readPauseRecordSync(kookrDir),
      })).toBe(true);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('cleared kill-switch-created orchestration pause record'),
      );
    });

    test('a pause whose mechanism is not the kill switch is left in place', async () => {
      const path = writePauseRecord(kookrDir, 'external-hold');
      const deps = createDeps(
        { automationKillSwitch: true, safeModeSince: '2026-08-22T00:00:00.000Z' },
        { automationKillSwitch: false, safeModeSince: null },
        { kookrDir },
      );

      await applySettingsSideEffects(deps);

      expect(existsSync(path)).toBe(true);
      expect(readPauseRecordSync(kookrDir)?.mechanism).toBe('external-hold');
      expect(readPauseRecordSync(kookrDir)?.paused).toBe(true);
      expect(console.warn).toHaveBeenCalledWith(
        '[settings] automation kill-switch DISENGAGED — autonomous actuation restored',
      );
    });

    test('engaging the kill switch does not clear a pause record', async () => {
      const path = writePauseRecord(kookrDir, 'automationKillSwitch');
      const deps = createDeps(
        { automationKillSwitch: false, safeModeSince: null },
        { automationKillSwitch: true, safeModeSince: '2026-08-22T00:00:00.000Z' },
        { kookrDir },
      );

      await applySettingsSideEffects(deps);

      expect(existsSync(path)).toBe(true);
    });

    test('unrelated settings change does not clear a pause record', async () => {
      const path = writePauseRecord(kookrDir, 'automationKillSwitch');
      const deps = createDeps(
        { automationKillSwitch: true, maxActiveTasks: 4 },
        { automationKillSwitch: true, maxActiveTasks: 8 },
        { kookrDir },
      );

      await applySettingsSideEffects(deps);

      expect(existsSync(path)).toBe(true);
    });
  });

  test('unchanged Phase-C capacity knobs do not log (#1862)', async () => {
    const deps = createDeps(
      {
        launchTimeoutSeconds: 180,
        deadManScheduleMinutes: 120,
        maxPendingTasks: 24,
        pendingTaskTtlMinutes: 240,
        spawnBurstLimit: 30,
        spawnBurstWindowMinutes: 10,
      },
      {
        launchTimeoutSeconds: 180,
        deadManScheduleMinutes: 120,
        maxPendingTasks: 24,
        pendingTaskTtlMinutes: 240,
        spawnBurstLimit: 30,
        spawnBurstWindowMinutes: 10,
      },
    );

    await applySettingsSideEffects(deps);

    const logged = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
    for (const knob of [
      'launchTimeoutSeconds',
      'deadManScheduleMinutes',
      'maxPendingTasks',
      'pendingTaskTtlMinutes',
      'spawnBurstLimit',
      'spawnBurstWindowMinutes',
    ]) {
      expect(logged.some((line) => line.includes(knob))).toBe(false);
    }
  });
});
