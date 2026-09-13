import * as fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { MaintenancePruneResult } from '../core/maintenance-prune.js';
import { TaskStore } from '../core/tasks.js';
import {
  composeMaintenancePruneHealth,
  EmergencyMaintenancePruneController,
  MaintenancePruneHealth,
  type MaintenancePruneScheduleConfig,
  runScheduledMaintenancePrune,
} from './maintenance-prune-schedule.js';
import { pruneAgedTaskRecords } from './use-cases/prune-aged-task-records.js';

vi.mock('node:fs/promises', { spy: true });

const NOW = '2026-09-13T00:00:00.000Z';
const diskResult: MaintenancePruneResult = {
  dataDir: '/tmp/data',
  dryRun: false,
  maxAgeDays: 30,
  planned: [],
  removed: [],
  reclaimedBytes: 4096,
  preserved: [],
  warnings: [],
};
const emptyLeg = { lastRunAt: null, lastOutcome: null, lastError: null, failuresTotal: 0 };

function config(health: MaintenancePruneHealth): MaintenancePruneScheduleConfig {
  return { dataDir: '/tmp/data', intervalHours: 24, health, run: async () => diskResult };
}

function pruneResult(outcome: 'pruned' | 'snapshot_failed' | 'archive_failed') {
  return { outcome, prunedTaskIds: [], remainingTasks: 1, maxAgeDays: 7 };
}

describe('record-maintenance health', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  test.each(['snapshot_failed', 'archive_failed'] as const)(
    '%s retains the task and reports the failure separately from disk reclaim',
    async (outcome) => {
      const health = new MaintenancePruneHealth(24, () => NOW);
      const store = new TaskStore();
      const task = store.createTask({ prompt: 'aged task', cwd: '/repo' });
      store.addSession(task.id, {
        tmuxSession: 'aged-session', agentType: 'claude-code', cwd: '/repo',
        createdAt: new Date('2026-08-01'),
      });
      store.completeTask(task.id);
      const agedTask = store.getTaskForMutation(task.id)!;
      agedTask.finishedAt = new Date('2026-08-01');
      agedTask.updatedAt = agedTask.finishedAt;
      const archiveTerminalTasks = vi.fn(async () => {
        if (outcome === 'archive_failed') throw new Error('archive unavailable');
      });
      const compactTaskArchive = vi.fn(async () => {});
      const onTaskRecordsPruned = vi.fn();

      const result = await runScheduledMaintenancePrune({
        ...config(health),
        pruneTaskRecords: () => pruneAgedTaskRecords({
          taskStore: store,
          monitor: { unregisterAgent: vi.fn() },
          now: () => Date.parse(NOW),
          takePredeleteSnapshot: async () => {
            if (outcome === 'snapshot_failed') throw new Error('snapshot unavailable');
          },
          archiveTerminalTasks,
        }, { maxAgeDays: 7 }),
        onTaskRecordsPruned,
        compactTaskArchive,
      });

      expect(result).toBe(diskResult);
      expect(store.getTask(task.id)).toBeDefined();
      expect(onTaskRecordsPruned).not.toHaveBeenCalled();
      expect(archiveTerminalTasks).toHaveBeenCalledTimes(outcome === 'snapshot_failed' ? 0 : 1);
      expect(compactTaskArchive).toHaveBeenCalledTimes(1);
      expect(health.getSnapshot()).toMatchObject({
        lastRunAt: NOW,
        lastReclaimedBytes: 4096,
        lastRemovedCount: 0,
        lastError: null,
        taskRecordPrune: { lastRunAt: NOW, lastOutcome: outcome, lastError: expect.any(String), failuresTotal: 1 },
        archiveCompaction: { lastRunAt: NOW, lastOutcome: 'completed', lastError: null, failuresTotal: 0 },
      });
    },
  );

  test('success clears only that leg and retains cumulative failures, including a zero-record success', async () => {
    let now = NOW;
    const health = new MaintenancePruneHealth(24, () => now);
    const pruneTaskRecords = vi.fn<NonNullable<MaintenancePruneScheduleConfig['pruneTaskRecords']>>()
      .mockResolvedValueOnce(pruneResult('archive_failed'))
      .mockResolvedValueOnce(pruneResult('snapshot_failed'))
      .mockResolvedValue(pruneResult('pruned'));
    const compactTaskArchive = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('second failure'))
      .mockResolvedValue(undefined);
    const sweep = { ...config(health), pruneTaskRecords, compactTaskArchive };

    await runScheduledMaintenancePrune(sweep);
    expect(health.getSnapshot().taskRecordPrune?.failuresTotal).toBe(1);
    expect(health.getSnapshot().archiveCompaction?.failuresTotal).toBe(1);
    now = '2026-09-14T00:00:00.000Z';
    await runScheduledMaintenancePrune(sweep);
    expect(health.getSnapshot().taskRecordPrune).toMatchObject({ lastOutcome: 'snapshot_failed', failuresTotal: 2 });
    expect(health.getSnapshot().archiveCompaction).toEqual({
      lastRunAt: now, lastOutcome: 'completed', lastError: null, failuresTotal: 1,
    });
    await runScheduledMaintenancePrune(sweep);
    expect(health.getSnapshot().taskRecordPrune).toEqual({
      lastRunAt: now, lastOutcome: 'pruned', lastError: null, failuresTotal: 2,
    });
    expect(health.getSnapshot().archiveCompaction).toMatchObject({ lastOutcome: 'failed', failuresTotal: 2 });
    await runScheduledMaintenancePrune(sweep);
    expect(health.getSnapshot().archiveCompaction).toEqual({
      lastRunAt: now, lastOutcome: 'completed', lastError: null, failuresTotal: 2,
    });
  });

  test.each([new Error('sensitive-value'.repeat(10_000)), 'sensitive-value'.repeat(10_000)])(
    'thrown record and compaction errors produce bounded, secret-free health (%#)',
    async (error) => {
      const health = new MaintenancePruneHealth(24, () => NOW);
      await runScheduledMaintenancePrune({
        ...config(health),
        pruneTaskRecords: async () => { throw error; },
        compactTaskArchive: async () => { throw error; },
      });
      expect(health.getSnapshot()).toMatchObject({
        lastError: null,
        lastReclaimedBytes: 4096,
        taskRecordPrune: { lastOutcome: 'failed', lastError: 'Task-record prune failed', failuresTotal: 1 },
        archiveCompaction: { lastOutcome: 'failed', lastError: 'Terminal-task archive compaction failed', failuresTotal: 1 },
      });
      const wire = JSON.stringify(health.getSnapshot());
      expect(wire).not.toContain('sensitive-value');
      expect(wire.length).toBeLessThan(1024);
    },
  );

  test('record legs run even after disk failure and preserve the last successful disk counters', async () => {
    const health = new MaintenancePruneHealth(24, () => NOW);
    await runScheduledMaintenancePrune(config(health));
    const result = await runScheduledMaintenancePrune({
      ...config(health),
      run: async () => { throw new Error('disk failure'); },
      pruneTaskRecords: async () => pruneResult('archive_failed'),
      compactTaskArchive: async () => { throw new Error('compaction failure'); },
    });
    expect(result).toBeNull();
    expect(health.getSnapshot()).toMatchObject({
      lastError: 'disk failure',
      lastReclaimedBytes: 4096,
      lastRemovedCount: 0,
      taskRecordPrune: { lastOutcome: 'archive_failed', failuresTotal: 1 },
      archiveCompaction: { lastOutcome: 'failed', failuresTotal: 1 },
    });
  });

  test('unwired legs stay unattempted and cannot clear a previously recorded failure', async () => {
    const health = new MaintenancePruneHealth(0, () => NOW);
    await runScheduledMaintenancePrune(config(health));
    expect(health.getSnapshot()).toMatchObject({ enabled: false, taskRecordPrune: emptyLeg, archiveCompaction: emptyLeg });
    await runScheduledMaintenancePrune({
      ...config(health),
      pruneTaskRecords: async () => pruneResult('archive_failed'),
    });
    const failed = health.getSnapshot();
    await runScheduledMaintenancePrune(config(health));
    expect(health.getSnapshot()).toEqual(failed);
  });

  test('emergency failures and recoveries cannot overwrite scheduled record outcomes', async () => {
    const health = new MaintenancePruneHealth(24, () => NOW);
    const schedule = {
      ...config(health),
      pruneTaskRecords: async () => pruneResult('snapshot_failed'),
      compactTaskArchive: async () => {},
    };
    await runScheduledMaintenancePrune(schedule);
    const scheduledSnapshot = health.getSnapshot();
    const pruneTaskRecords = vi.fn<NonNullable<MaintenancePruneScheduleConfig['pruneTaskRecords']>>()
      .mockResolvedValueOnce(pruneResult('archive_failed'))
      .mockRejectedValueOnce(new Error('private task details'))
      .mockResolvedValue(pruneResult('pruned'));
    const compactTaskArchive = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('private archive path'))
      .mockResolvedValue(undefined);
    const controller = new EmergencyMaintenancePruneController({
      pruneConfig: { ...schedule, pruneTaskRecords, compactTaskArchive },
      throttleMs: 0,
      now: () => Date.parse(NOW),
    });

    expect(await controller.maybeRunOnDiskCriticalEdge()).toBe('ran');
    const emergencyFailed = controller.getHealthSnapshot();
    expect(composeMaintenancePruneHealth(health.getSnapshot(), emergencyFailed)).toMatchObject({
      lastReclaimedBytes: 4096,
      lastEmergencyReclaimedBytes: 4096,
      lastEmergencyPruneError: null,
      taskRecordPrune: { lastOutcome: 'snapshot_failed', failuresTotal: 1 },
      archiveCompaction: { lastOutcome: 'completed', failuresTotal: 0 },
      emergencyTaskRecordPrune: { lastRunAt: NOW, lastOutcome: 'archive_failed', failuresTotal: 1 },
      emergencyArchiveCompaction: { lastRunAt: NOW, lastOutcome: 'failed', failuresTotal: 1 },
    });
    expect(health.getSnapshot()).toEqual(scheduledSnapshot);
    await runScheduledMaintenancePrune({ ...schedule, pruneTaskRecords: async () => pruneResult('pruned') });
    expect(controller.getHealthSnapshot()).toEqual(emergencyFailed);
    await controller.maybeRunOnDiskCriticalEdge();
    expect(controller.getHealthSnapshot().emergencyTaskRecordPrune).toMatchObject({ lastOutcome: 'failed', failuresTotal: 2 });
    const recoveredSchedule = health.getSnapshot();
    await controller.maybeRunOnDiskCriticalEdge();
    expect(controller.getHealthSnapshot()).toMatchObject({
      emergencyTaskRecordPrune: { lastOutcome: 'pruned', lastError: null, failuresTotal: 2 },
      emergencyArchiveCompaction: { lastOutcome: 'completed', lastError: null, failuresTotal: 1 },
    });
    expect(health.getSnapshot()).toEqual(recoveredSchedule);
  });

  test('health reads use cached copies without invoking maintenance, clocks, or filesystem reads', async () => {
    const nowIso = vi.fn(() => NOW);
    const health = new MaintenancePruneHealth(24, nowIso);
    const run = vi.fn(async () => diskResult);
    const pruneTaskRecords = vi.fn(async () => pruneResult('archive_failed'));
    const compactTaskArchive = vi.fn(async () => {});
    const controller = new EmergencyMaintenancePruneController({
      pruneConfig: { ...config(health), run, pruneTaskRecords, compactTaskArchive },
    });
    await runScheduledMaintenancePrune({ ...config(health), run, pruneTaskRecords, compactTaskArchive });
    const before = health.getSnapshot();
    const clockCalls = nowIso.mock.calls.length;
    const reads = [vi.mocked(fs.readFile), vi.mocked(fs.readdir), vi.mocked(fs.stat), vi.mocked(fs.open)];
    for (const read of reads) read.mockClear();

    const snapshot = composeMaintenancePruneHealth(health.getSnapshot(), controller.getHealthSnapshot());
    snapshot.taskRecordPrune!.lastError = 'consumer mutation';
    snapshot.emergencyArchiveCompaction!.failuresTotal = 99;
    for (let i = 0; i < 3; i++) {
      expect(health.getSnapshot()).toEqual(before);
      expect(controller.getHealthSnapshot().emergencyArchiveCompaction).toEqual(emptyLeg);
    }
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    expect(nowIso).toHaveBeenCalledTimes(clockCalls);
    expect(run).toHaveBeenCalledTimes(1);
    expect(pruneTaskRecords).toHaveBeenCalledTimes(1);
    expect(compactTaskArchive).toHaveBeenCalledTimes(1);
  });
});
