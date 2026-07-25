import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScheduleStore } from '../core/schedule.js';
import { TaskStore } from '../core/tasks.js';
import { ScheduleService } from './schedule-service.js';
import { ScheduleValidator } from './schedule-validator.js';

function withService(testFn: (service: ScheduleService, store: ScheduleStore, dir: string) => void | Promise<void>): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-service-test-'));
  const store = new ScheduleStore(dir);
  const service = new ScheduleService({ store, validator: new ScheduleValidator() });
  const result = testFn(service, store, dir);
  if (result && typeof result === 'object' && 'then' in result) {
    return result.finally(() => rmSync(dir, { recursive: true, force: true }));
  }
  rmSync(dir, { recursive: true, force: true });
}

function writePlaybook(cwd: string): void {
  mkdirSync(join(cwd, '.kookr', 'playbooks'), { recursive: true });
  writeFileSync(join(cwd, '.kookr', 'playbooks', 'daily.md'), `---
name: Daily
parameters: []
---
Do the work.
`);
}

describe('ScheduleService validation', () => {
  it('rejects cron expressions that fire more often than every five minutes on create', async () => {
    await withService(async (service, store, dir) => {
      writePlaybook(dir);

      await expect(service.createDefinition({
        name: 'Too fast',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: dir,
      })).rejects.toMatchObject({
        fieldErrors: {
          cron: 'Cron expression must not fire more often than every 5 minutes',
        },
      });

      expect(store.list()).toHaveLength(0);
    });
  });

  it('accepts the five-minute cron boundary on create', async () => {
    await withService(async (service, store, dir) => {
      writePlaybook(dir);

      await service.createDefinition({
        name: 'Every five',
        cron: '*/5 * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: dir,
      });

      expect(store.list()).toHaveLength(1);
    });
  });

  it('rejects impractical cron expressions on definition update', async () => {
    await withService(async (service, store, dir) => {
      writePlaybook(dir);
      const schedule = store.create({
        name: 'Hourly',
        cron: '0 * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: dir,
      });

      await expect(service.updateDefinition(schedule.id, { cron: '*/4 * * * *' })).rejects.toMatchObject({
        fieldErrors: {
          cron: 'Cron expression must not fire more often than every 5 minutes',
        },
      });

      expect(store.get(schedule.id)!.cron).toBe('0 * * * *');
    });
  });
});

describe('ScheduleService status', () => {
  it('reports healthy after runner start before the first completed tick', () => {
    withService((service) => {
      service.recordRunnerStarted('auto');

      const snapshot = service.getStatusSnapshot();
      expect(snapshot).toEqual(expect.objectContaining({
        runnerStartedAt: expect.any(String),
        schedulerHealthy: true,
        catchUpMode: 'auto',
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
      service.recordRunnerStarted('auto');
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

  it('updates the execution ledger when a scheduled task reaches a terminal state', async () => {
    await withService(async (service, store) => {
      const schedule = store.create({
        name: 'Terminal',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      const receipt = await service.reserveExecution(schedule, 'cron', '2026-01-01T09:00:00.000Z');
      await service.markExecutionAccepted(schedule.id, receipt.id, 'task-1', false);

      await service.recordTaskTerminalOutcome('task-1', 'completed');

      expect(store.get(schedule.id)!.executionLedger).toEqual([
        expect.objectContaining({
          taskId: 'task-1',
          outcome: 'completed',
          reasonCode: 'none',
          completedAt: expect.any(String),
        }),
      ]);
    });
  });

  it('records queued_capacity/capacity for a capacity-queued execution (issue #1526 Phase A)', async () => {
    await withService(async (service, store) => {
      const schedule = store.create({
        name: 'Capacity',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      const receipt = await service.reserveExecution(schedule, 'cron', '2026-01-01T09:00:00.000Z');
      await service.markExecutionAccepted(schedule.id, receipt.id, 'task-1', true);

      const updated = store.get(schedule.id)!;
      expect(updated.latestExecution).toEqual(expect.objectContaining({
        taskId: 'task-1',
        outcome: 'queued_capacity',
        reasonCode: 'capacity',
      }));
      expect(updated.executionLedger).toEqual([
        expect.objectContaining({
          taskId: 'task-1',
          outcome: 'queued_capacity',
          reasonCode: 'capacity',
        }),
      ]);
    });
  });

  it('records deferred catch-up without leaving the stale due slot replayable', async () => {
    await withService(async (service, store) => {
      const schedule = store.create({
        name: 'Deferred',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      const dueAt = new Date(Date.now() - 2 * 60_000).toISOString();

      await service.recordCatchUpDeferred(schedule.id, dueAt, 'Run manually');

      const updated = store.getWithComputed(schedule.id)!;
      expect(updated.latestExecution).toEqual(expect.objectContaining({
        scheduledFor: dueAt,
        outcome: 'skipped_manual',
        reasonCode: 'manual_catch_up_required',
      }));
      expect(updated.executionLedger).toEqual([
        expect.objectContaining({
          decision: 'manual_catch_up',
          outcome: 'skipped_manual',
          reasonCode: 'manual_catch_up_required',
          scheduledFor: dueAt,
        }),
      ]);
      expect(new Date(updated.lastScheduledFor!).getTime()).toBeGreaterThan(new Date(dueAt).getTime());
      expect(new Date(updated.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    });
  });

  it('updates the execution ledger when startup reconciliation finds a completed task', async () => {
    await withService(async (service, store) => {
      const taskStore = new TaskStore();
      const task = taskStore.createTask('Run scheduled work', '/tmp');
      taskStore.startTask(task.id);
      const completedTask = taskStore.completeTask(task.id);
      const schedule = store.create({
        name: 'Reconcile',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      const receipt = await service.reserveExecution(schedule, 'cron', '2026-01-01T09:00:00.000Z');
      await service.markExecutionAccepted(schedule.id, receipt.id, task.id, false);

      await service.reconcileOnStartup(taskStore);

      expect(store.get(schedule.id)!.executionLedger).toEqual([
        expect.objectContaining({
          taskId: completedTask.id,
          outcome: 'completed',
          reasonCode: 'reconciled_after_restart',
          completedAt: completedTask.updatedAt.toISOString(),
        }),
      ]);
    });
  });

  it('startup reconciliation also picks up a queued_capacity execution (issue #1526 Phase A)', async () => {
    await withService(async (service, store) => {
      const taskStore = new TaskStore();
      const task = taskStore.createTask('Run scheduled work', '/tmp');
      taskStore.startTask(task.id);
      const completedTask = taskStore.completeTask(task.id);
      const schedule = store.create({
        name: 'ReconcileQueued',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      const receipt = await service.reserveExecution(schedule, 'cron', '2026-01-01T09:00:00.000Z');
      // queued=true — the fire was still pending (capacity-queued) at the time of restart.
      await service.markExecutionAccepted(schedule.id, receipt.id, task.id, true);

      await service.reconcileOnStartup(taskStore);

      expect(store.get(schedule.id)!.executionLedger).toEqual([
        expect.objectContaining({
          taskId: completedTask.id,
          outcome: 'completed',
          reasonCode: 'reconciled_after_restart',
        }),
      ]);
    });
  });

  it('startup reconciliation also picks up the LEGACY literal outcome "queued" from on-disk state (issue #1526 Phase A)', async () => {
    // This is the exact case the live drain will hit: on-disk schedule state
    // persisted BEFORE this change can have latestExecution.outcome === 'queued'
    // (no code path produces it anymore, but old rows on disk still have it).
    // Bypasses markExecutionAccepted entirely — seeds the store directly, the
    // way a pre-deploy tasks.json/schedules.json would already look.
    await withService(async (service, store) => {
      const taskStore = new TaskStore();
      const task = taskStore.createTask('Run scheduled work', '/tmp');
      taskStore.startTask(task.id);
      const completedTask = taskStore.completeTask(task.id);

      const schedule = store.create({
        name: 'LegacyQueued',
        cron: '* * * * *',
        playbook: { path: 'daily.md', parameters: {} },
        cwd: '/tmp',
      });
      const evaluatedAt = '2026-01-01T09:00:00.000Z';
      store.replace({
        ...schedule,
        latestExecution: {
          executionToken: 'legacy-token',
          evaluatedAt,
          triggeredAt: evaluatedAt,
          trigger: 'cron',
          taskId: task.id,
          outcome: 'queued',
          reasonCode: 'none',
        },
        executionLedger: [{
          id: 'legacy-ledger-entry',
          scheduleId: schedule.id,
          trigger: 'cron',
          decision: 'cron_due',
          evaluatedAt,
          taskId: task.id,
          outcome: 'queued',
          reasonCode: 'none',
        }],
      });

      await service.reconcileOnStartup(taskStore);

      expect(store.get(schedule.id)!.latestExecution).toEqual(expect.objectContaining({
        taskId: completedTask.id,
        outcome: 'completed',
        reasonCode: 'reconciled_after_restart',
      }));
      expect(store.get(schedule.id)!.executionLedger).toEqual([
        expect.objectContaining({
          taskId: completedTask.id,
          outcome: 'completed',
          reasonCode: 'reconciled_after_restart',
        }),
      ]);
    });
  });
});
