import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { TaskStore } from '../../core/tasks.js';
import { AdapterRegistry } from '../../adapters/agent-adapter.js';
import { SERVER_RESTARTING_MARKER_FILE } from '../server-restart-marker.js';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import type { LaunchServiceDeps } from '../launch-service.js';
import { createScheduleRuntime, unwindCatchUpDuplicate } from './create-schedule-runtime.js';

describe('createScheduleRuntime', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  test('loads schedule state and wires schedule broadcasts through the server broadcaster', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-schedule-'));
    const messages: ServerMessage[] = [];

    const runtime = await createScheduleRuntime({
      kookrDir: tempDir,
      taskStore: new TaskStore(),
      launchServiceDeps: {} as LaunchServiceDeps,
      getMaxActiveTasks: () => 5,
      broadcastToAll: (msg) => messages.push(msg),
    });

    expect(runtime.scheduleStore.list()).toEqual([]);
    runtime.scheduleService.recordRunnerStarted('auto');

    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(expect.objectContaining({
      type: 'schedules',
      schedules: [],
      status: expect.objectContaining({
        catchUpMode: 'auto',
        catchUpEnabled: true,
        schedulerHealthy: true,
        runnerStartedAt: expect.any(String),
      }),
    }));
  });

  test('forwards schedule source, target, parameters, and model tier through the loop composition root', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-schedule-tier-'));
    const taskStore = new TaskStore();
    const launchLoopedPlaybookFn = vi.fn().mockResolvedValue({
      task: taskStore.createTask('looped small task', tempDir),
      queued: false,
    });
    const adapterRegistry = new AdapterRegistry();
    adapterRegistry.register({ agentType: 'claude-code' } as any);
    const runtime = await createScheduleRuntime({
      kookrDir: tempDir,
      taskStore,
      launchServiceDeps: { adapterRegistry } as LaunchServiceDeps,
      getMaxActiveTasks: () => 5,
      broadcastToAll: () => {},
      ralphLoopService: {} as any,
      launchLoopedPlaybookFn,
    });
    const schedule = runtime.scheduleStore.create({
      name: 'Portable small loop',
      cron: '* * * * *',
      playbook: {
        path: 'workflow.md',
        parameters: { repo: 'owner/repo' },
        scope: 'project',
        sourceCwd: join(tempDir, 'catalog'),
      },
      cwd: join(tempDir, 'target'),
      loop: {},
      modelTier: 'small',
    });

    await runtime.scheduleRunner.runNow(schedule.id);

    expect(launchLoopedPlaybookFn).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        scheduleId: schedule.id,
        modelTier: 'small',
        playbookSourceCwd: join(tempDir, 'catalog'),
        taskTargetCwd: join(tempDir, 'target'),
        taskTargetCwdExplicit: true,
        parameterValues: { repo: 'owner/repo' },
        scope: 'project',
      }),
    );
  });

  // issue #2512: a scheduled fire interrupted by a server restart (its accepted
  // task terminated `unknown` by reconcile at boot) must not fail-close the
  // schedule. Exercised end-to-end through the real runtime, since reconcileOnStartup
  // runs during createScheduleRuntime — the exact boot path the 2026-08-14 outage took.
  test('reconcileOnStartup does not count a restart-interrupted mid-flight fire', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-schedule-2512-'));
    const taskStore = new TaskStore();

    // Build the pre-restart schedule state on disk: a fire accepted (outcome
    // `running`) pointing at a task the restart later killed (`unknown`).
    const seedRuntime = await createScheduleRuntime({
      kookrDir: tempDir,
      taskStore,
      launchServiceDeps: {} as LaunchServiceDeps,
      getMaxActiveTasks: () => 5,
      getScheduleFailureAlertThreshold: () => 3,
      broadcastToAll: () => {},
    });
    const schedule = seedRuntime.scheduleStore.create({
      name: 'Kookr Queue Feeder',
      cron: '* * * * *',
      playbook: { path: 'queue-feeder.md', parameters: {} },
      cwd: '/tmp',
    });
    const task = taskStore.createTask('Run scheduled work', '/tmp');
    taskStore.startTask(task.id);
    const receipt = await seedRuntime.scheduleService.reserveExecution(
      seedRuntime.scheduleStore.get(schedule.id)!,
      'cron',
      '2026-08-14T10:00:00.000Z',
    );
    await seedRuntime.scheduleService.markExecutionAccepted(schedule.id, receipt.id, task.id, false);
    // The redeploy kills the task's sessions; reconcile terminates it `unknown`.
    taskStore.terminateTask(task.id, { reason: 'unknown' });
    // prod-restart.sh wrote the graceful-redeploy marker before draining, so the
    // boot reconcile can attribute the `unknown` death to the restart (#2512).
    writeFileSync(
      join(tempDir, SERVER_RESTARTING_MARKER_FILE),
      JSON.stringify({ schemaVersion: 'server-restarting.v1', reason: 'server_restarting', at: new Date().toISOString() }),
    );

    // Boot the replacement process: reconcileOnStartup runs inside the factory.
    const runtime = await createScheduleRuntime({
      kookrDir: tempDir,
      taskStore,
      launchServiceDeps: {} as LaunchServiceDeps,
      getMaxActiveTasks: () => 5,
      getScheduleFailureAlertThreshold: () => 3,
      broadcastToAll: () => {},
    });

    const after = runtime.scheduleStore.get(schedule.id)!;
    expect(after.consecutiveFailures ?? 0).toBe(0);
    expect(after.enabled).toBe(true);
    expect(after.latestExecution?.outcome).toBe('cancelled');
    expect(after.latestExecution?.reasonCode).toBe('reconciled_after_restart');
  });

  // issue #1914: the catch-up lease-CAS unwind hook wired into the runner.
  describe('unwindCatchUpDuplicate', () => {
    test('terminates an inProgress duplicate as a non-recoverable supervisor kill', () => {
      const store = new TaskStore();
      const task = store.createTask({ prompt: 'catch-up', cwd: '/cwd', launchSource: 'schedule' });
      store.startTask(task.id);

      unwindCatchUpDuplicate(store, task.id, 'relaunch lease taken mid-fire by other-actuator');

      const after = store.getTask(task.id)!;
      expect(after.status).toBe('terminated');
      // `supervisor` is non-recoverable (crash-recovery skips it), so the
      // duplicate is not relaunched after the lease holder already owns the work.
      expect(after.terminationReason).toBe('supervisor');
      expect(after.terminationDetail).toBe(
        'catch-up duplicate unwound — relaunch lease taken mid-fire by other-actuator',
      );
    });

    test('cancels a pending (queued) duplicate rather than throwing on an invalid terminate transition', () => {
      const store = new TaskStore();
      const task = store.createTask({ prompt: 'catch-up', cwd: '/cwd', launchSource: 'schedule' });
      store.pendTask(task.id);
      expect(store.getTask(task.id)!.status).toBe('pending');

      // `pending → terminated` is not a valid transition; the hook must cancel
      // instead of letting terminateTask throw and abort the catch-up loop.
      expect(() =>
        unwindCatchUpDuplicate(store, task.id, 'relaunch lease taken mid-fire by other-actuator'),
      ).not.toThrow();
      expect(store.getTask(task.id)!.status).toBe('cancelled');
    });

    test('terminates an open (not-yet-started) duplicate', () => {
      const store = new TaskStore();
      const task = store.createTask({ prompt: 'catch-up', cwd: '/cwd', launchSource: 'schedule' });
      expect(store.getTask(task.id)!.status).toBe('open');

      unwindCatchUpDuplicate(store, task.id, 'relaunch lease entered backoff mid-fire');

      expect(store.getTask(task.id)!.status).toBe('terminated');
    });

    test('is a no-op for an unknown task id', () => {
      const store = new TaskStore();
      expect(() => unwindCatchUpDuplicate(store, 'nope', 'detail')).not.toThrow();
    });

    test('swallows a throwing terminal transition so the catch-up loop is never aborted', () => {
      // Best-effort contract: if the task went terminal between the status read
      // and the write (here simulated by a throwing store), the hook logs rather
      // than propagating — a throw would abort the once-per-boot catch-up loop.
      const throwingStore = {
        getTask: () => ({ id: 't1', status: 'inProgress' }) as any,
        cancelTask: () => {
          throw new Error('should not be reached for inProgress');
        },
        terminateTask: () => {
          throw new Error('raced to terminal');
        },
      };
      expect(() => unwindCatchUpDuplicate(throwingStore, 't1', 'detail')).not.toThrow();
    });
  });
});
