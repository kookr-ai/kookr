import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScheduleStore } from '../core/schedule.js';
import type { Schedule } from '../core/schedule.js';
import { TaskStore } from '../core/tasks.js';
import type { Task } from '../core/task-read-model.js';
import { deriveScheduleTerminalReason, ScheduleService } from './schedule-service.js';
import { ScheduleValidator } from './schedule-validator.js';

/**
 * Issue #2877: the task→schedule terminal transition must carry the task's
 * structured terminal reason (#2847) onto the schedule execution receipt, so a
 * classified provider outage or watchdog timeout is no longer an opaque
 * `cancelled reason=none` schedule row. These are additive-observability tests;
 * the failure-counting behavior they lean on (#2521) is unchanged.
 */

interface Harness {
  service: ScheduleService;
  store: ScheduleStore;
  taskStore: TaskStore;
  dir: string;
  cleanup: () => void;
}

function harness(threshold = 3): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-terminal-provenance-'));
  const store = new ScheduleStore(dir);
  const taskStore = new TaskStore();
  const service = new ScheduleService({
    store,
    validator: new ScheduleValidator(),
    getFailureAlertThreshold: () => threshold,
    // Wire the classification join exactly as bootstrap does.
    resolveTerminalReason: (taskId) => deriveScheduleTerminalReason(taskStore.getTask(taskId)),
  });
  return { service, store, taskStore, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function createSchedule(store: ScheduleStore, name: string): Schedule {
  return store.create({
    name,
    cron: '* * * * *',
    playbook: { path: 'daily.md', parameters: {} },
    cwd: '/tmp',
  });
}

describe('deriveScheduleTerminalReason (pure classification join)', () => {
  it('classifies a watchdog timeout with the watchdog source', () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'x', cwd: '/tmp', agentType: 'grok-build' });
    taskStore.startTask(task.id);
    taskStore.terminateTask(task.id, { reason: 'timeout' });

    const reason = deriveScheduleTerminalReason(taskStore.getTask(task.id));
    expect(reason).toMatchObject({ reasonCode: 'timeout', source: 'watchdog' });
    expect(typeof reason?.at).toBe('string');
    // A timeout is not a provider failure, so no provider/agent type is attached.
    expect(reason?.provider).toBeUndefined();
  });

  it('classifies a provider failure with the resolved provider and no raw error', () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'secret prompt', cwd: '/tmp', agentType: 'grok-build' });
    taskStore.startTask(task.id);
    taskStore.terminateTask(task.id, { reason: 'provider_transient', detail: '529 Overloaded from provider' });

    const reason = deriveScheduleTerminalReason(taskStore.getTask(task.id));
    expect(reason).toMatchObject({ reasonCode: 'provider_failure', provider: 'grok-build' });
    // Bounded typed fields only: never the prompt or the raw provider error.
    expect(JSON.stringify(reason)).not.toContain('secret prompt');
    expect(JSON.stringify(reason)).not.toContain('529 Overloaded');
    expect(Object.keys(reason ?? {}).sort()).toEqual(['at', 'provider', 'reasonCode', 'source']);
  });

  it('classifies a restart-recovery termination explicitly', () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'x', cwd: '/tmp', agentType: 'claude-code' });
    taskStore.startTask(task.id);
    taskStore.terminateTask(task.id, { reason: 'server-restart' });

    const reason = deriveScheduleTerminalReason(taskStore.getTask(task.id));
    expect(reason).toMatchObject({ reasonCode: 'server_restart', source: 'restart_recovery' });
  });

  it('classifies a terminal task that predates the receipt field as unknown_legacy', () => {
    // Simulate a legacy row: a terminal task with no stored terminal receipt.
    const legacyTask = {
      status: 'terminated',
      terminalReceipt: undefined,
      finishedAt: undefined,
      terminatedAt: new Date('2026-08-28T09:00:00.000Z'),
      updatedAt: new Date('2026-08-28T09:00:00.000Z'),
    } as unknown as Task;

    const reason = deriveScheduleTerminalReason(legacyTask);
    expect(reason).toMatchObject({
      reasonCode: 'unknown_legacy',
      source: 'unknown_legacy',
      at: '2026-08-28T09:00:00.000Z',
    });
  });

  it('returns undefined for a non-terminal task (nothing to classify)', () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask({ prompt: 'x', cwd: '/tmp' });
    taskStore.startTask(task.id);
    expect(deriveScheduleTerminalReason(taskStore.getTask(task.id))).toBeUndefined();
  });

  it('omits provider on a provider_failure whose task carries no agent type', () => {
    // The provider attach is gated on `task.agentType`; a provider failure
    // without a resolved agent must not fabricate a provider bucket.
    const providerFailNoAgent = {
      status: 'terminated',
      agentType: undefined,
      terminalReceipt: {
        status: 'terminated',
        reason: 'provider_failure',
        source: 'task_self',
        at: '2026-08-28T09:00:00.000Z',
        workDisposition: 'abandoned',
      },
      updatedAt: new Date('2026-08-28T09:00:00.000Z'),
    } as unknown as Task;

    const reason = deriveScheduleTerminalReason(providerFailNoAgent);
    expect(reason).toMatchObject({ reasonCode: 'provider_failure', source: 'task_self' });
    expect(reason?.provider).toBeUndefined();
  });
});

describe('recordTaskTerminalOutcome carries the classification onto the schedule receipt', () => {
  it('stamps a timeout classification on latestExecution and the ledger row', async () => {
    const { service, store, taskStore, cleanup } = harness();
    try {
      const schedule = createSchedule(store, 'TimeoutJob');
      const task = taskStore.createTask({ prompt: 'x', cwd: '/tmp', agentType: 'grok-build' });
      taskStore.startTask(task.id);
      const receipt = await service.reserveExecution(schedule, 'cron', '2026-08-28T09:00:00.000Z');
      await service.markExecutionAccepted(schedule.id, receipt.id, task.id, false);

      taskStore.terminateTask(task.id, { reason: 'timeout' });
      await service.recordTaskTerminalOutcome(task.id, 'cancelled', 'timeout');

      const s = store.get(schedule.id)!;
      const expectedAt = taskStore.getTask(task.id)!.terminalReceipt!.at;
      expect(s.latestExecution?.terminalReason).toEqual({
        reasonCode: 'timeout',
        source: 'watchdog',
        at: expectedAt,
      });
      const row = s.executionLedger.find((e) => e.taskId === task.id)!;
      expect(row.terminalReason).toEqual({ reasonCode: 'timeout', source: 'watchdog', at: expectedAt });
      // Existing outcome/reasonCode contract is unchanged.
      expect(s.latestExecution?.outcome).toBe('cancelled');
      expect(s.latestExecution?.reasonCode).toBe('none');
    } finally {
      cleanup();
    }
  });

  it('stamps a provider_failure classification with the resolved provider', async () => {
    const { service, store, taskStore, cleanup } = harness();
    try {
      const schedule = createSchedule(store, 'ProviderJob');
      const task = taskStore.createTask({ prompt: 'x', cwd: '/tmp', agentType: 'grok-build' });
      taskStore.startTask(task.id);
      const receipt = await service.reserveExecution(schedule, 'cron', '2026-08-28T09:00:00.000Z');
      await service.markExecutionAccepted(schedule.id, receipt.id, task.id, false);

      taskStore.terminateTask(task.id, { reason: 'provider_transient' });
      await service.recordTaskTerminalOutcome(task.id, 'cancelled', 'provider_transient');

      const s = store.get(schedule.id)!;
      expect(s.latestExecution?.terminalReason).toMatchObject({
        reasonCode: 'provider_failure',
        provider: 'grok-build',
      });
    } finally {
      cleanup();
    }
  });

  it('stamps the classification on the closed mid-flight row via the overlap-skip pointer path (#2458)', async () => {
    const { service, store, taskStore, cleanup } = harness();
    try {
      const schedule = createSchedule(store, 'OverlapTimeoutJob');
      const task = taskStore.createTask({ prompt: 'x', cwd: '/tmp', agentType: 'grok-build' });
      taskStore.startTask(task.id);

      // First fire accepted and running.
      const accepted = await service.reserveExecution(schedule, 'cron', '2026-08-28T09:00:00.000Z');
      await service.markExecutionAccepted(schedule.id, accepted.id, task.id, false);

      // Second fire overlap-skips while the first is still active — latestExecution
      // now points at the first fire's task as a blocking pointer.
      const skip = await service.reserveExecution(store.get(schedule.id)!, 'cron', '2026-08-28T09:05:00.000Z');
      await service.markExecutionOutcome(
        schedule.id,
        skip.id,
        'skipped_active',
        'previous_run_active',
        'Previous run still active',
        { blockingTaskId: task.id },
      );
      expect(store.get(schedule.id)!.latestExecution?.taskId).toBe(task.id);

      // The first fire's task now times out. The skip-pointer branch must close
      // the ORIGINAL mid-flight row with the classification, and leave the skip row.
      taskStore.terminateTask(task.id, { reason: 'timeout' });
      await service.recordTaskTerminalOutcome(task.id, 'cancelled', 'timeout');

      const after = store.get(schedule.id)!;
      // The skip row is untouched — still a skip, no terminal classification.
      const skipRow = after.executionLedger.find((e) => e.outcome === 'skipped_active')!;
      expect(skipRow.terminalReason).toBeUndefined();
      // The original fire's row is closed to cancelled and carries the timeout class.
      const closedRow = after.executionLedger.find((e) => e.outcome === 'cancelled')!;
      expect(closedRow.terminalReason).toMatchObject({ reasonCode: 'timeout', source: 'watchdog' });
      // The overlap skip did not fail-close the schedule (behavior unchanged).
      expect(after.consecutiveFailures ?? 0).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('survives a persistence round-trip (reload from disk)', async () => {
    const { service, store, taskStore, dir, cleanup } = harness();
    try {
      const schedule = createSchedule(store, 'PersistJob');
      const task = taskStore.createTask({ prompt: 'x', cwd: '/tmp', agentType: 'grok-build' });
      taskStore.startTask(task.id);
      const receipt = await service.reserveExecution(schedule, 'cron', '2026-08-28T09:00:00.000Z');
      await service.markExecutionAccepted(schedule.id, receipt.id, task.id, false);
      taskStore.terminateTask(task.id, { reason: 'timeout' });
      await service.recordTaskTerminalOutcome(task.id, 'cancelled', 'timeout');

      // Reload from the same directory — normalization must preserve the field.
      const reloaded = new ScheduleStore(dir);
      await reloaded.load();
      const s = reloaded.get(schedule.id)!;
      expect(s.latestExecution?.terminalReason).toMatchObject({ reasonCode: 'timeout', source: 'watchdog' });
      const row = s.executionLedger.find((e) => e.taskId === task.id)!;
      expect(row.terminalReason).toMatchObject({ reasonCode: 'timeout', source: 'watchdog' });
    } finally {
      cleanup();
    }
  });

  it('drops a malformed persisted terminalReason on load rather than half-trusting it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'schedule-terminal-provenance-malformed-'));
    try {
      const seed = new ScheduleStore(dir);
      const schedule = createSchedule(seed, 'MalformedJob');
      const evaluatedAt = '2026-08-28T09:00:00.000Z';
      // Write a schedule whose ledger + latestExecution carry a malformed
      // terminalReason (missing `source`, non-string `reasonCode`). The
      // normalizer must drop it, not pass the garbage through.
      seed.replace({
        ...schedule,
        latestExecution: {
          executionToken: 'tok',
          evaluatedAt,
          trigger: 'cron',
          taskId: 'task-x',
          outcome: 'cancelled',
          reasonCode: 'none',
          terminalReason: { reasonCode: 123, at: evaluatedAt } as never,
        },
        executionLedger: [{
          id: 'ledger-x',
          scheduleId: schedule.id,
          trigger: 'cron',
          decision: 'cron_due',
          evaluatedAt,
          taskId: 'task-x',
          outcome: 'cancelled',
          reasonCode: 'none',
          terminalReason: { source: 'watchdog' } as never,
        }],
      });
      await seed.persist();

      const reloaded = new ScheduleStore(dir);
      await reloaded.load();
      const s = reloaded.get(schedule.id)!;
      expect(s.latestExecution?.terminalReason).toBeUndefined();
      expect(s.executionLedger[0].terminalReason).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('reconcileOnStartup carries the classification onto the reconciled row', () => {
  it('classifies a mid-flight task that terminated during a restart', async () => {
    const { service, store, taskStore, cleanup } = harness();
    try {
      const schedule = createSchedule(store, 'ReconcileJob');
      const task = taskStore.createTask({ prompt: 'x', cwd: '/tmp', agentType: 'claude-code' });
      taskStore.startTask(task.id);
      const receipt = await service.reserveExecution(schedule, 'cron', '2026-08-28T09:00:00.000Z');
      await service.markExecutionAccepted(schedule.id, receipt.id, task.id, false);

      // The task died as the process restarted.
      taskStore.terminateTask(task.id, { reason: 'server-restart' });
      await service.reconcileOnStartup(taskStore);

      const s = store.get(schedule.id)!;
      expect(s.latestExecution?.terminalReason).toMatchObject({
        reasonCode: 'server_restart',
        source: 'restart_recovery',
      });
      const row = s.executionLedger.find((e) => e.taskId === task.id)!;
      expect(row.terminalReason).toMatchObject({ reasonCode: 'server_restart', source: 'restart_recovery' });
    } finally {
      cleanup();
    }
  });
});

describe('schedulesPausedByFailure surfaces the last classified reason', () => {
  it('exposes the last classified failure reason and timestamp on the paused row', async () => {
    const { service, store, taskStore, cleanup } = harness(2);
    try {
      const schedule = createSchedule(store, 'PausedJob');

      // Drive two genuine timeout failures to cross the fail-closed threshold (2).
      for (const at of ['2026-08-28T09:00:00.000Z', '2026-08-28T09:05:00.000Z']) {
        const task = taskStore.createTask({ prompt: 'x', cwd: '/tmp', agentType: 'grok-build' });
        taskStore.startTask(task.id);
        const receipt = await service.reserveExecution(store.get(schedule.id)!, 'cron', at);
        await service.markExecutionAccepted(schedule.id, receipt.id, task.id, false);
        taskStore.terminateTask(task.id, { reason: 'timeout' });
        await service.recordTaskTerminalOutcome(task.id, 'cancelled', 'timeout');
      }

      const paused = store.get(schedule.id)!;
      // Threshold behavior itself is unchanged (issue #2877 keeps counting as-is).
      expect(paused.consecutiveFailures).toBe(2);
      expect(paused.enabled).toBe(false);
      expect(paused.stopReason).toBe('consecutive_failures');

      const snapshot = service.getStatusSnapshot();
      const row = snapshot.schedulesPausedByFailure?.find((r) => r.id === schedule.id);
      expect(row).toBeDefined();
      expect(row?.lastTerminalReason).toMatchObject({ reasonCode: 'timeout', source: 'watchdog' });
      expect(typeof row?.lastTerminalReason?.at).toBe('string');
    } finally {
      cleanup();
    }
  });
});

describe('aggregateTerminalReasons diagnostic rollup', () => {
  it('aggregates non-success fires by reason and excludes a completed fire', async () => {
    const { service, store, taskStore, cleanup } = harness();
    try {
      const schedule = createSchedule(store, 'RollupJob');

      // A provider failure — counted in the rollup.
      const failTask = taskStore.createTask({ prompt: 'x', cwd: '/tmp', agentType: 'grok-build' });
      taskStore.startTask(failTask.id);
      const r1 = await service.reserveExecution(store.get(schedule.id)!, 'cron', '2026-08-28T09:00:00.000Z');
      await service.markExecutionAccepted(schedule.id, r1.id, failTask.id, false);
      taskStore.terminateTask(failTask.id, { reason: 'provider_transient' });
      await service.recordTaskTerminalOutcome(failTask.id, 'cancelled', 'provider_transient');

      // A clean completion — stamped on its ledger row for provenance, but NOT
      // counted in the failure rollup.
      const okTask = taskStore.createTask({ prompt: 'x', cwd: '/tmp', agentType: 'grok-build' });
      taskStore.startTask(okTask.id);
      const r2 = await service.reserveExecution(store.get(schedule.id)!, 'cron', '2026-08-28T09:05:00.000Z');
      await service.markExecutionAccepted(schedule.id, r2.id, okTask.id, false);
      taskStore.completeTask(okTask.id);
      await service.recordTaskTerminalOutcome(okTask.id, 'completed');

      // The completion is still classified on its own ledger row (point provenance).
      const okRow = store.get(schedule.id)!.executionLedger.find((e) => e.taskId === okTask.id)!;
      expect(okRow.terminalReason?.reasonCode).toBe('completed_normal');

      const nowMs = Date.now();
      const agg = service.aggregateTerminalReasons({ nowMs, windowMs: 24 * 60 * 60 * 1000 });
      expect(agg.total).toBe(1);
      expect(agg.byReason.provider_failure.count).toBe(1);
      expect(agg.byProvider['grok-build'].count).toBe(1);
      expect(agg.byReason.completed_normal).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});
