import { afterEach, describe, expect, test, vi } from 'vitest';
import type { MaintenancePruneResult } from '../core/maintenance-prune.js';
import {
  DEFAULT_EMERGENCY_PRUNE_THROTTLE_MS,
  EmergencyMaintenancePruneController,
  resolveEmergencyPruneThrottleMs,
} from './maintenance-prune-schedule.js';
import {
  DataDirectoryDiskAdmissionTracker,
  type DiskAdmissionConfig,
} from './task-admission.js';

const fakeResult = (over: Partial<MaintenancePruneResult> = {}): MaintenancePruneResult => ({
  dataDir: '/tmp/data',
  dryRun: false,
  maxAgeDays: 30,
  planned: [],
  removed: [],
  reclaimedBytes: 0,
  preserved: [],
  warnings: [],
  ...over,
});

const diskCfg = (over: Partial<DiskAdmissionConfig> = {}): DiskAdmissionConfig => ({
  freePercentThreshold: 5,
  freeBytesThreshold: 0,
  sustainSamples: 2,
  retryAfterSeconds: 2,
  ...over,
});

describe('resolveEmergencyPruneThrottleMs', () => {
  test('defaults to 1 hour when unset', () => {
    expect(resolveEmergencyPruneThrottleMs({})).toBe(DEFAULT_EMERGENCY_PRUNE_THROTTLE_MS);
  });

  test('parses explicit non-negative ms (0 disables throttle)', () => {
    expect(resolveEmergencyPruneThrottleMs({ KOOKR_EMERGENCY_PRUNE_THROTTLE_MS: '0' })).toBe(0);
    expect(resolveEmergencyPruneThrottleMs({ KOOKR_EMERGENCY_PRUNE_THROTTLE_MS: '5000' })).toBe(5000);
  });

  test('invalid / negative falls back to default', () => {
    expect(resolveEmergencyPruneThrottleMs({ KOOKR_EMERGENCY_PRUNE_THROTTLE_MS: '-1' }))
      .toBe(DEFAULT_EMERGENCY_PRUNE_THROTTLE_MS);
    expect(resolveEmergencyPruneThrottleMs({ KOOKR_EMERGENCY_PRUNE_THROTTLE_MS: 'NaN' }))
      .toBe(DEFAULT_EMERGENCY_PRUNE_THROTTLE_MS);
    expect(resolveEmergencyPruneThrottleMs({ KOOKR_EMERGENCY_PRUNE_THROTTLE_MS: '' }))
      .toBe(DEFAULT_EMERGENCY_PRUNE_THROTTLE_MS);
  });
});

describe('EmergencyMaintenancePruneController (issue #2344)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('disk-critical edge fires prune once; second tick within throttle does not', async () => {
    const run = vi.fn(async () => fakeResult({ reclaimedBytes: 8192 }));
    let nowMs = 1_000_000;
    const controller = new EmergencyMaintenancePruneController({
      pruneConfig: {
        dataDir: '/tmp/data',
        intervalHours: 0, // scheduled prune remains off
        run,
      },
      throttleMs: 60 * 60 * 1000,
      now: () => nowMs,
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Simulate the production wiring: observe until the sustain edge, then
    // call maybeRun only on false→true transitions.
    const tracker = new DataDirectoryDiskAdmissionTracker();
    const config = diskCfg({ sustainSamples: 2 });
    const samples = [
      { diskFreePercent: 1, sampledAt: 't1' },
      { diskFreePercent: 1, sampledAt: 't2' }, // edge: becomes critical
      { diskFreePercent: 1, sampledAt: 't3' }, // still critical, no new edge
      { diskFreePercent: 1, sampledAt: 't4' },
    ];
    let edges = 0;
    for (const sample of samples) {
      const wasCritical = tracker.isCritical();
      tracker.observe(sample, config);
      if (!wasCritical && tracker.isCritical()) {
        edges += 1;
        await controller.maybeRunOnDiskCriticalEdge();
      }
    }

    expect(edges).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(controller.getHealthSnapshot()).toEqual({
      emergencyPruneTriggeredTotal: 1,
      lastEmergencyPruneAt: new Date(1_000_000).toISOString(),
      lastEmergencyReclaimedBytes: 8192,
      throttleMs: 60 * 60 * 1000,
    });
    expect(logSpy.mock.calls.flat().join('\n')).toMatch(/emergency sweep triggered/);

    // A second explicit edge call within the throttle window is dropped.
    const second = await controller.maybeRunOnDiskCriticalEdge();
    expect(second).toBe('throttled');
    expect(run).toHaveBeenCalledTimes(1);
    expect(controller.getHealthSnapshot().emergencyPruneTriggeredTotal).toBe(1);
  });

  test('after throttle expires a new edge may run again', async () => {
    const run = vi.fn(async () => fakeResult({ reclaimedBytes: 100 }));
    let nowMs = 0;
    const controller = new EmergencyMaintenancePruneController({
      pruneConfig: { dataDir: '/tmp/data', intervalHours: 0, run },
      throttleMs: 1_000,
      now: () => nowMs,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await controller.maybeRunOnDiskCriticalEdge()).toBe('ran');
    nowMs = 999;
    expect(await controller.maybeRunOnDiskCriticalEdge()).toBe('throttled');
    nowMs = 1_000;
    expect(await controller.maybeRunOnDiskCriticalEdge()).toBe('ran');
    expect(run).toHaveBeenCalledTimes(2);
    expect(controller.getHealthSnapshot().emergencyPruneTriggeredTotal).toBe(2);
  });

  test('in-flight gate prevents concurrent re-entry', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = vi.fn(async () => {
      await gate;
      return fakeResult({ reclaimedBytes: 1 });
    });
    const controller = new EmergencyMaintenancePruneController({
      pruneConfig: { dataDir: '/tmp/data', intervalHours: 0, run },
      throttleMs: 0,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const first = controller.maybeRunOnDiskCriticalEdge();
    const concurrent = await controller.maybeRunOnDiskCriticalEdge();
    expect(concurrent).toBe('in_flight');
    release();
    expect(await first).toBe('ran');
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('forwards task-record prune via the shared scheduled runner', async () => {
    const run = vi.fn(async () => fakeResult());
    const pruneTaskRecords = vi.fn(async () => ({
      outcome: 'pruned' as const,
      prunedTaskIds: ['t-old'],
      remainingTasks: 3,
      maxAgeDays: 7,
    }));
    const controller = new EmergencyMaintenancePruneController({
      pruneConfig: {
        dataDir: '/tmp/data',
        intervalHours: 0,
        run,
        pruneTaskRecords,
      },
      throttleMs: 0,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await controller.maybeRunOnDiskCriticalEdge();
    expect(run).toHaveBeenCalledTimes(1);
    expect(pruneTaskRecords).toHaveBeenCalledTimes(1);
  });

  test('failed disk sweep still counts as a triggered attempt and leaves reclaimed null', async () => {
    const run = vi.fn(async () => {
      throw new Error('disk exploded');
    });
    const controller = new EmergencyMaintenancePruneController({
      pruneConfig: { dataDir: '/tmp/data', intervalHours: 0, run },
      throttleMs: 0,
      now: () => 42_000,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await controller.maybeRunOnDiskCriticalEdge()).toBe('failed');
    expect(controller.getHealthSnapshot()).toEqual({
      emergencyPruneTriggeredTotal: 1,
      lastEmergencyPruneAt: new Date(42_000).toISOString(),
      lastEmergencyReclaimedBytes: null,
      throttleMs: 0,
    });
  });

  test('failed attempt after a success clears lastEmergencyReclaimedBytes (no stale reclaim figure)', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(fakeResult({ reclaimedBytes: 8192 }))
      .mockRejectedValueOnce(new Error('disk exploded'));
    let nowMs = 0;
    const controller = new EmergencyMaintenancePruneController({
      pruneConfig: { dataDir: '/tmp/data', intervalHours: 0, run },
      throttleMs: 0,
      now: () => nowMs,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await controller.maybeRunOnDiskCriticalEdge()).toBe('ran');
    expect(controller.getHealthSnapshot().lastEmergencyReclaimedBytes).toBe(8192);
    nowMs = 10;
    expect(await controller.maybeRunOnDiskCriticalEdge()).toBe('failed');
    expect(controller.getHealthSnapshot()).toMatchObject({
      emergencyPruneTriggeredTotal: 2,
      lastEmergencyReclaimedBytes: null,
    });
  });

  test('health starts at zero / null before any edge', () => {
    const controller = new EmergencyMaintenancePruneController({
      pruneConfig: { dataDir: '/tmp/data', intervalHours: 0, run: async () => fakeResult() },
      throttleMs: 3_600_000,
    });
    expect(controller.getHealthSnapshot()).toEqual({
      emergencyPruneTriggeredTotal: 0,
      lastEmergencyPruneAt: null,
      lastEmergencyReclaimedBytes: null,
      throttleMs: 3_600_000,
    });
  });
});
