import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScheduleStore } from '../core/schedule.js';
import { ScheduleService } from './schedule-service.js';
import { ScheduleValidator } from './schedule-validator.js';

function withService(testFn: (service: ScheduleService) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-service-test-'));
  try {
    const store = new ScheduleStore(dir);
    const service = new ScheduleService({ store, validator: new ScheduleValidator() });
    testFn(service);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('ScheduleService status', () => {
  it('reports healthy after runner start before the first completed tick', () => {
    withService((service) => {
      service.recordRunnerStarted(true);

      const snapshot = service.getStatusSnapshot();
      expect(snapshot).toEqual(expect.objectContaining({
        runnerStartedAt: expect.any(String),
        schedulerHealthy: true,
        catchUpEnabled: true,
      }));
      expect(snapshot).not.toHaveProperty('lastTickCompletedAt');
    });
  });

  it('reports unhealthy while a schedule file load error is present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'schedule-service-test-'));
    try {
      writeFileSync(join(dir, 'schedules.json'), '{');
      const store = new ScheduleStore(dir);
      const service = new ScheduleService({ store, validator: new ScheduleValidator() });

      await store.load();

      expect(service.getStatusSnapshot()).toEqual(expect.objectContaining({
        schedulerHealthy: false,
        loadError: expect.stringContaining('Failed to load schedules'),
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports unhealthy while a runner error is present and clears it on a successful tick', () => {
    withService((service) => {
      service.recordRunnerStarted(true);
      service.recordRunnerError('[schedule] Tick error: boom');

      expect(service.getStatusSnapshot()).toEqual(expect.objectContaining({
        schedulerHealthy: false,
        lastError: '[schedule] Tick error: boom',
      }));

      service.recordTickCompleted();

      const snapshot = service.getStatusSnapshot();
      expect(snapshot).toEqual(expect.objectContaining({
        schedulerHealthy: true,
        lastTickCompletedAt: expect.any(String),
      }));
      expect(snapshot).not.toHaveProperty('lastError');
    });
  });

  it('deduplicates stale catch-up ledger entries by schedule and due timestamp', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'schedule-service-test-'));
    try {
      const store = new ScheduleStore(dir);
      const service = new ScheduleService({ store, validator: new ScheduleValidator() });
      const schedule = store.create({
        name: 'Stale catch-up',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: dir,
      });
      const scheduledFor = '2026-01-01T00:00:00.000Z';

      await service.recordStaleCatchUpSkipped(schedule.id, scheduledFor);
      await service.recordStaleCatchUpSkipped(schedule.id, scheduledFor);

      const updated = store.get(schedule.id)!;
      expect(updated.executionLedger).toHaveLength(1);
      expect(updated.executionLedger?.[0]).toEqual(expect.objectContaining({
        scheduleId: schedule.id,
        scheduledFor,
        outcome: 'skipped_stale_catchup',
        reasonCode: 'stale_catchup',
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains only the most recent schedule execution ledger entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'schedule-service-test-'));
    try {
      const store = new ScheduleStore(dir);
      const service = new ScheduleService({ store, validator: new ScheduleValidator() });
      const schedule = store.create({
        name: 'Bounded ledger',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: dir,
      });

      for (let i = 0; i < 51; i += 1) {
        await service.recordStaleCatchUpSkipped(
          schedule.id,
          `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`,
        );
      }

      const updated = store.get(schedule.id)!;
      expect(updated.executionLedger).toHaveLength(50);
      expect(updated.executionLedger?.[0].scheduledFor).toBe('2026-01-01T00:01:00.000Z');
      expect(updated.executionLedger?.at(-1)?.scheduledFor).toBe('2026-01-01T00:50:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('updates launched task ledger entries after later skipped executions overwrite latest status', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'schedule-service-test-'));
    try {
      const store = new ScheduleStore(dir);
      const service = new ScheduleService({ store, validator: new ScheduleValidator() });
      const schedule = store.create({
        name: 'Terminal ledger',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: dir,
      });

      const receipt = await service.reserveExecution(schedule, 'cron', '2026-01-01T00:00:00.000Z');
      await service.markExecutionAccepted(schedule.id, receipt.id, 'task-1', false);

      const skipReceipt = await service.reserveExecution(
        store.get(schedule.id)!,
        'cron',
        '2026-01-01T00:01:00.000Z',
      );
      await service.markExecutionOutcome(
        schedule.id,
        skipReceipt.id,
        'skipped_active',
        'previous_run_active',
        'Previous run still active',
        { blockingTaskId: 'task-1' },
      );

      await service.recordTaskTerminalOutcome('task-1', 'completed');

      const updated = store.get(schedule.id)!;
      expect(updated.latestExecution?.outcome).toBe('skipped_active');
      expect(updated.executionLedger?.find((entry) => entry.taskId === 'task-1')).toEqual(expect.objectContaining({
        outcome: 'completed',
        reasonCode: 'none',
        completedAt: expect.any(String),
      }));
      expect(updated.executionLedger?.at(-1)).toEqual(expect.objectContaining({
        outcome: 'skipped_active',
        blockingTaskId: 'task-1',
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
