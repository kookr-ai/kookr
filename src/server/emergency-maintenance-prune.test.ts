import { afterEach, describe, expect, test, vi } from 'vitest';
import type { MaintenancePruneResult } from '../core/maintenance-prune.js';
import {
  composeMaintenancePruneHealth,
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
      emergencyTaskRecordPrune: { lastRunAt: null, lastOutcome: null, lastError: null, failuresTotal: 0 },
      emergencyArchiveCompaction: { lastRunAt: null, lastOutcome: null, lastError: null, failuresTotal: 0 },
      emergencyPruneTriggeredTotal: 1,
      lastEmergencyPruneAt: new Date(1_000_000).toISOString(),
      lastEmergencyReclaimedBytes: 8192,
      lastEmergencyPruneError: null,
      consecutiveEmergencyPrunesReclaimedZeroWhileCritical: 0,
      emergencyPruneReclaimedZeroWhileCritical: false,
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

  test('sustained inode exhaustion fires the same emergency prune edge', async () => {
    const run = vi.fn(async () => fakeResult({ reclaimedBytes: 4096 }));
    const controller = new EmergencyMaintenancePruneController({
      pruneConfig: { dataDir: '/tmp/data', intervalHours: 0, run },
      throttleMs: 60_000,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const tracker = new DataDirectoryDiskAdmissionTracker();
    const config = diskCfg({
      freePercentThreshold: 0,
      freeBytesThreshold: 0,
      sustainSamples: 2,
    });

    for (const sampledAt of ['inode-1', 'inode-2', 'inode-3']) {
      const wasCritical = tracker.isCritical();
      tracker.observe({
        diskFreePercent: 50,
        diskFreeBytes: 50_000_000_000,
        diskFreeInodes: 0,
        diskTotalInodes: 100_000,
        sampledAt,
      }, config);
      if (!wasCritical && tracker.isCritical()) {
        await controller.maybeRunOnDiskCriticalEdge();
      }
    }

    expect(run).toHaveBeenCalledTimes(1);
    expect(controller.getHealthSnapshot()).toMatchObject({
      emergencyPruneTriggeredTotal: 1,
      lastEmergencyReclaimedBytes: 4096,
    });
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
      emergencyTaskRecordPrune: { lastRunAt: null, lastOutcome: null, lastError: null, failuresTotal: 0 },
      emergencyArchiveCompaction: { lastRunAt: null, lastOutcome: null, lastError: null, failuresTotal: 0 },
      emergencyPruneTriggeredTotal: 1,
      lastEmergencyPruneAt: new Date(42_000).toISOString(),
      lastEmergencyReclaimedBytes: null,
      lastEmergencyPruneError: 'disk exploded',
      consecutiveEmergencyPrunesReclaimedZeroWhileCritical: 0,
      emergencyPruneReclaimedZeroWhileCritical: false,
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
      emergencyTaskRecordPrune: { lastRunAt: null, lastOutcome: null, lastError: null, failuresTotal: 0 },
      emergencyArchiveCompaction: { lastRunAt: null, lastOutcome: null, lastError: null, failuresTotal: 0 },
      emergencyPruneTriggeredTotal: 0,
      lastEmergencyPruneAt: null,
      lastEmergencyReclaimedBytes: null,
      lastEmergencyPruneError: null,
      consecutiveEmergencyPrunesReclaimedZeroWhileCritical: 0,
      emergencyPruneReclaimedZeroWhileCritical: false,
      throttleMs: 3_600_000,
    });
  });

  test('failed emergency sweep surfaces its error; a subsequent success clears it (issue #3078)', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('ENOSPC: no space left on device'))
      .mockResolvedValueOnce(fakeResult({ reclaimedBytes: 512 }));
    let nowMs = 0;
    const controller = new EmergencyMaintenancePruneController({
      pruneConfig: { dataDir: '/tmp/data', intervalHours: 0, run },
      throttleMs: 0,
      now: () => nowMs,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // A failing sweep populates lastEmergencyPruneError with the real message.
    expect(await controller.maybeRunOnDiskCriticalEdge()).toBe('failed');
    expect(controller.getHealthSnapshot()).toEqual({
      emergencyTaskRecordPrune: { lastRunAt: null, lastOutcome: null, lastError: null, failuresTotal: 0 },
      emergencyArchiveCompaction: { lastRunAt: null, lastOutcome: null, lastError: null, failuresTotal: 0 },
      emergencyPruneTriggeredTotal: 1,
      lastEmergencyPruneAt: new Date(0).toISOString(),
      lastEmergencyReclaimedBytes: null,
      lastEmergencyPruneError: 'ENOSPC: no space left on device',
      consecutiveEmergencyPrunesReclaimedZeroWhileCritical: 0,
      emergencyPruneReclaimedZeroWhileCritical: false,
      throttleMs: 0,
    });

    // The next successful sweep clears the error back to null.
    nowMs = 10;
    expect(await controller.maybeRunOnDiskCriticalEdge()).toBe('ran');
    expect(controller.getHealthSnapshot()).toEqual({
      emergencyTaskRecordPrune: { lastRunAt: null, lastOutcome: null, lastError: null, failuresTotal: 0 },
      emergencyArchiveCompaction: { lastRunAt: null, lastOutcome: null, lastError: null, failuresTotal: 0 },
      emergencyPruneTriggeredTotal: 2,
      lastEmergencyPruneAt: new Date(10).toISOString(),
      lastEmergencyReclaimedBytes: 512,
      lastEmergencyPruneError: null,
      consecutiveEmergencyPrunesReclaimedZeroWhileCritical: 0,
      emergencyPruneReclaimedZeroWhileCritical: false,
      throttleMs: 0,
    });
  });

  test('reclaimed-0-while-critical increments a consecutive counter and sets the boolean (issue #3110)', async () => {
    const run = vi.fn(async () => fakeResult({ reclaimedBytes: 0 }));
    let nowMs = 0;
    const controller = new EmergencyMaintenancePruneController({
      pruneConfig: { dataDir: '/tmp/data', intervalHours: 0, run },
      throttleMs: 0,
      now: () => nowMs,
      isDiskStillCritical: () => true,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // First ineffective sweep: succeeded, reclaimed 0, disk still critical.
    expect(await controller.maybeRunOnDiskCriticalEdge()).toBe('ran');
    expect(controller.getHealthSnapshot()).toMatchObject({
      emergencyPruneTriggeredTotal: 1,
      lastEmergencyReclaimedBytes: 0,
      consecutiveEmergencyPrunesReclaimedZeroWhileCritical: 1,
      emergencyPruneReclaimedZeroWhileCritical: true,
    });

    // A second ineffective sweep advances the streak.
    nowMs = 10;
    expect(await controller.maybeRunOnDiskCriticalEdge()).toBe('ran');
    expect(controller.getHealthSnapshot()).toMatchObject({
      consecutiveEmergencyPrunesReclaimedZeroWhileCritical: 2,
      emergencyPruneReclaimedZeroWhileCritical: true,
    });
    expect(warnSpy.mock.calls.flat().join('\n')).toMatch(/reclaimed 0 byte\(s\) while/);
  });

  test('an effective (>0) reclaim resets the reclaimed-0-while-critical streak (issue #3110)', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(fakeResult({ reclaimedBytes: 0 }))
      .mockResolvedValueOnce(fakeResult({ reclaimedBytes: 4096 }));
    let nowMs = 0;
    const controller = new EmergencyMaintenancePruneController({
      pruneConfig: { dataDir: '/tmp/data', intervalHours: 0, run },
      throttleMs: 0,
      now: () => nowMs,
      isDiskStillCritical: () => true,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await controller.maybeRunOnDiskCriticalEdge()).toBe('ran');
    expect(controller.getHealthSnapshot().consecutiveEmergencyPrunesReclaimedZeroWhileCritical).toBe(1);

    nowMs = 10;
    expect(await controller.maybeRunOnDiskCriticalEdge()).toBe('ran');
    expect(controller.getHealthSnapshot()).toMatchObject({
      consecutiveEmergencyPrunesReclaimedZeroWhileCritical: 0,
      emergencyPruneReclaimedZeroWhileCritical: false,
    });
  });

  test('a 0-byte sweep whose disk recovered mid-flight resets the streak, not increments it (issue #3110)', async () => {
    // Reachable case: a sweep fired on the critical edge, but by the time it
    // finishes a fresh resource sample has flipped the disk out of critical.
    // The 0-byte reclaim must then reset (benign), never count as ineffective.
    const run = vi.fn(async () => fakeResult({ reclaimedBytes: 0 }));
    let nowMs = 0;
    let stillCritical = true;
    const controller = new EmergencyMaintenancePruneController({
      pruneConfig: { dataDir: '/tmp/data', intervalHours: 0, run },
      throttleMs: 0,
      now: () => nowMs,
      isDiskStillCritical: () => stillCritical,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Ineffective while critical → streak 1.
    expect(await controller.maybeRunOnDiskCriticalEdge()).toBe('ran');
    expect(controller.getHealthSnapshot().consecutiveEmergencyPrunesReclaimedZeroWhileCritical).toBe(1);

    // Disk recovered before this sweep completed; a benign 0-byte sweep resets.
    stillCritical = false;
    nowMs = 10;
    expect(await controller.maybeRunOnDiskCriticalEdge()).toBe('ran');
    expect(controller.getHealthSnapshot()).toMatchObject({
      consecutiveEmergencyPrunesReclaimedZeroWhileCritical: 0,
      emergencyPruneReclaimedZeroWhileCritical: false,
    });
  });

  test('noteDiskLeftCritical clears the streak when the disk recovers between edges (issue #3110)', async () => {
    // Production path: the disk recovers with no sweep in flight. The true→false
    // admission edge (wired in index.ts) must clear the latched signal so the
    // boolean does not stay true while the disk is healthy.
    const run = vi.fn(async () => fakeResult({ reclaimedBytes: 0 }));
    const controller = new EmergencyMaintenancePruneController({
      pruneConfig: { dataDir: '/tmp/data', intervalHours: 0, run },
      throttleMs: 0,
      isDiskStillCritical: () => true,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await controller.maybeRunOnDiskCriticalEdge()).toBe('ran');
    expect(controller.getHealthSnapshot()).toMatchObject({
      consecutiveEmergencyPrunesReclaimedZeroWhileCritical: 1,
      emergencyPruneReclaimedZeroWhileCritical: true,
    });

    // Disk leaves critical (no sweep runs) → the edge reset clears the signal.
    controller.noteDiskLeftCritical();
    expect(controller.getHealthSnapshot()).toMatchObject({
      consecutiveEmergencyPrunesReclaimedZeroWhileCritical: 0,
      emergencyPruneReclaimedZeroWhileCritical: false,
    });
  });

  test('a failed sweep leaves an existing reclaimed-0-while-critical streak unchanged (issue #3110)', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(fakeResult({ reclaimedBytes: 0 }))
      .mockRejectedValueOnce(new Error('disk exploded'));
    let nowMs = 0;
    const controller = new EmergencyMaintenancePruneController({
      pruneConfig: { dataDir: '/tmp/data', intervalHours: 0, run },
      throttleMs: 0,
      now: () => nowMs,
      isDiskStillCritical: () => true,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Ineffective success → streak 1.
    expect(await controller.maybeRunOnDiskCriticalEdge()).toBe('ran');
    expect(controller.getHealthSnapshot().consecutiveEmergencyPrunesReclaimedZeroWhileCritical).toBe(1);

    // A subsequent *failed* sweep must not reset or increment the streak — the
    // counter is a success-path classifier; failures go to lastEmergencyPruneError.
    nowMs = 10;
    expect(await controller.maybeRunOnDiskCriticalEdge()).toBe('failed');
    expect(controller.getHealthSnapshot()).toMatchObject({
      consecutiveEmergencyPrunesReclaimedZeroWhileCritical: 1,
      emergencyPruneReclaimedZeroWhileCritical: true,
      lastEmergencyPruneError: 'disk exploded',
    });
  });

  test('without an isDiskStillCritical callback a 0-byte sweep never flags an ineffective reclaim (issue #3110)', async () => {
    const run = vi.fn(async () => fakeResult({ reclaimedBytes: 0 }));
    const controller = new EmergencyMaintenancePruneController({
      pruneConfig: { dataDir: '/tmp/data', intervalHours: 0, run },
      throttleMs: 0,
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await controller.maybeRunOnDiskCriticalEdge()).toBe('ran');
    expect(controller.getHealthSnapshot()).toMatchObject({
      consecutiveEmergencyPrunesReclaimedZeroWhileCritical: 0,
      emergencyPruneReclaimedZeroWhileCritical: false,
    });
  });
});

describe('composeMaintenancePruneHealth (issue #3078)', () => {
  const scheduleSnapshot = {
    enabled: false,
    intervalHours: 0,
    lastRunAt: null,
    lastReclaimedBytes: null,
    lastRemovedCount: null,
    lastError: null,
  };

  test('carries a non-null lastEmergencyPruneError from the emergency snapshot onto the wire shape', () => {
    const composed = composeMaintenancePruneHealth(scheduleSnapshot, {
      emergencyPruneTriggeredTotal: 3,
      lastEmergencyPruneAt: '2026-08-12T00:00:00.000Z',
      lastEmergencyReclaimedBytes: null,
      lastEmergencyPruneError: 'ENOSPC: no space left on device',
      consecutiveEmergencyPrunesReclaimedZeroWhileCritical: 0,
      emergencyPruneReclaimedZeroWhileCritical: false,
      throttleMs: 3_600_000,
    });
    expect(composed.lastEmergencyPruneError).toBe('ENOSPC: no space left on device');
    // The scheduled leg's own lastError is independent of the emergency error.
    expect(composed.lastError).toBeNull();
  });

  test('carries the reclaimed-0-while-critical counter and boolean onto the wire shape (issue #3110)', () => {
    const composed = composeMaintenancePruneHealth(scheduleSnapshot, {
      emergencyPruneTriggeredTotal: 4,
      lastEmergencyPruneAt: '2026-08-12T00:00:00.000Z',
      lastEmergencyReclaimedBytes: 0,
      lastEmergencyPruneError: null,
      consecutiveEmergencyPrunesReclaimedZeroWhileCritical: 3,
      emergencyPruneReclaimedZeroWhileCritical: true,
      throttleMs: 3_600_000,
    });
    expect(composed.consecutiveEmergencyPrunesReclaimedZeroWhileCritical).toBe(3);
    expect(composed.emergencyPruneReclaimedZeroWhileCritical).toBe(true);
  });

  test('forwards a cleared (null) emergency error', () => {
    const composed = composeMaintenancePruneHealth(scheduleSnapshot, {
      emergencyPruneTriggeredTotal: 1,
      lastEmergencyPruneAt: '2026-08-12T00:00:00.000Z',
      lastEmergencyReclaimedBytes: 512,
      lastEmergencyPruneError: null,
      consecutiveEmergencyPrunesReclaimedZeroWhileCritical: 0,
      emergencyPruneReclaimedZeroWhileCritical: false,
      throttleMs: 3_600_000,
    });
    expect(composed.lastEmergencyPruneError).toBeNull();
  });
});
