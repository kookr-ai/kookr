import { randomUUID } from 'node:crypto';
import type { TaskStore } from '../core/tasks.js';
import {
  type CreateScheduleInput,
  type Schedule,
  type ScheduleExecutionLedgerEntry,
  type ScheduleExecutionOutcome,
  type ScheduleExecutionReasonCode,
  type ScheduleListResponse,
  type ScheduleLatestExecutionStatus,
  type ScheduleStatusSnapshot,
  type UpdateScheduleDefinitionInput,
  isTriggerLimitExhausted,
  ScheduleStore,
  ScheduleValidationError,
} from '../core/schedule.js';
import { isValidCron } from '../core/cron.js';
import { ScheduleValidator } from './schedule-validator.js';

export interface ScheduleServiceDeps {
  store: ScheduleStore;
  validator: ScheduleValidator;
  broadcast?: (payload: ScheduleListResponse) => void;
}

const MAX_SCHEDULE_EXECUTION_LEDGER_ENTRIES = 50;

export class ScheduleService {
  private readonly store: ScheduleStore;
  private readonly validator: ScheduleValidator;
  private readonly broadcast?: (payload: ScheduleListResponse) => void;
  private runnerStartedAt?: string;
  private lastTickCompletedAt?: string;
  private lastError?: string;
  private catchUpEnabled = true;

  constructor(deps: ScheduleServiceDeps) {
    this.store = deps.store;
    this.validator = deps.validator;
    this.broadcast = deps.broadcast;
  }

  listResponse(): ScheduleListResponse {
    return {
      revision: this.store.getRevision(),
      schedules: this.store.listWithComputed(),
      status: this.getStatusSnapshot(),
    };
  }

  getStatusSnapshot(): ScheduleStatusSnapshot {
    const loadError = this.store.getLoadError();
    const lastTickCompletedAt = this.lastTickCompletedAt;
    const schedulerHealthy = !loadError && !this.lastError;
    return {
      timezone: currentTimezone(),
      ...(this.runnerStartedAt ? { runnerStartedAt: this.runnerStartedAt } : {}),
      ...(lastTickCompletedAt ? { lastTickCompletedAt } : {}),
      catchUpEnabled: this.catchUpEnabled,
      schedulerHealthy,
      ...(loadError ? { loadError } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  recordRunnerStarted(catchUpEnabled: boolean): void {
    this.runnerStartedAt = new Date().toISOString();
    this.catchUpEnabled = catchUpEnabled;
    this.lastError = undefined;
    this.broadcastSchedules();
  }

  recordTickCompleted(): void {
    this.lastTickCompletedAt = new Date().toISOString();
    this.lastError = undefined;
    this.broadcastSchedules();
  }

  recordRunnerError(message: string): void {
    this.lastError = message;
    this.broadcastSchedules();
  }

  async createDefinition(input: CreateScheduleInput) {
    await this.validator.validateCreate(input);
    const schedule = this.store.create(input);
    await this.store.persist();
    this.broadcastSchedules();
    return this.store.getWithComputed(schedule.id)!;
  }

  async updateDefinition(id: string, patch: UpdateScheduleDefinitionInput) {
    const existing = this.store.get(id);
    if (!existing) throw new ScheduleValidationError(`Schedule not found: ${id}`);
    await this.validator.validateDefinitionUpdate(existing, patch);
    this.store.updateDefinition(id, patch);
    await this.store.persist();
    this.broadcastSchedules();
    return this.store.getWithComputed(id)!;
  }

  async setEnabled(id: string, enabled: boolean) {
    const schedule = this.requireSchedule(id);
    if (enabled && isTriggerLimitExhausted(schedule)) {
      throw new ScheduleValidationError('Schedule trigger limit has been exhausted', { maxTriggers: 'Increase or clear the trigger limit before resuming' });
    }
    this.store.setEnabled(id, enabled);
    await this.store.persist();
    this.broadcastSchedules();
    return this.store.getWithComputed(id)!;
  }

  async delete(id: string): Promise<void> {
    if (!this.store.delete(id)) {
      throw new ScheduleValidationError('Schedule not found');
    }
    await this.store.persist();
    this.broadcastSchedules();
  }

  async reserveExecution(
    schedule: Schedule,
    trigger: 'cron' | 'manual',
    scheduledFor?: string,
    options: { catchUp?: boolean } = {},
  ) {
    const receiptId = randomUUID();
    const executionToken = randomUUID();
    const evaluatedAt = new Date().toISOString();
    const updated: Schedule = {
      ...schedule,
      ...(trigger === 'cron' && scheduledFor ? { lastScheduledFor: scheduledFor } : {}),
      ...(trigger === 'cron' ? { lastCronEvaluatedAt: evaluatedAt } : {}),
      currentExecution: {
        id: receiptId,
        scheduleId: schedule.id,
        executionToken,
        trigger,
        ...(scheduledFor ? { scheduledFor } : {}),
        evaluatedAt,
        status: 'reserved',
        ...(options.catchUp ? { catchUp: true } : {}),
      },
      executionLedger: upsertExecutionLedger(schedule, {
        id: receiptId,
        scheduleId: schedule.id,
        receiptId,
        executionToken,
        trigger,
        ...(scheduledFor ? { scheduledFor } : {}),
        evaluatedAt,
        outcome: 'reserved',
        ...(options.catchUp ? { catchUp: true } : {}),
      }),
      updatedAt: evaluatedAt,
    };
    this.store.replace(updated);
    await this.store.persist();
    return updated.currentExecution!;
  }

  async markCronLimitExhausted(scheduleId: string): Promise<void> {
    const schedule = this.requireSchedule(scheduleId);
    if (!isTriggerLimitExhausted(schedule)) return;
    if (!schedule.enabled && schedule.stopReason === 'trigger_limit_reached') return;

    this.store.replace({
      ...schedule,
      enabled: false,
      stopReason: 'trigger_limit_reached',
      exhaustedAt: schedule.exhaustedAt ?? new Date().toISOString(),
    });
    await this.store.persist();
    this.broadcastSchedules();
  }

  async recordStaleCatchUpSkipped(scheduleId: string, scheduledFor: string): Promise<void> {
    const schedule = this.requireSchedule(scheduleId);
    const evaluatedAt = new Date().toISOString();
    const message = 'Missed run is older than the catch-up window';
    const latestExecution: ScheduleLatestExecutionStatus = {
      executionToken: `stale-catchup:${scheduledFor}`,
      scheduledFor,
      evaluatedAt,
      trigger: 'cron',
      outcome: 'skipped_stale_catchup',
      reasonCode: 'stale_catchup',
      message,
      catchUp: true,
    };

    this.store.replace({
      ...schedule,
      lastRunAt: evaluatedAt,
      lastRunStatus: 'failed',
      lastScheduledFor: scheduledFor,
      lastCronEvaluatedAt: evaluatedAt,
      latestExecution,
      executionLedger: upsertExecutionLedger(schedule, {
        id: `stale-catchup:${scheduleId}:${scheduledFor}`,
        scheduleId,
        executionToken: latestExecution.executionToken,
        scheduledFor,
        evaluatedAt,
        trigger: 'cron',
        outcome: 'skipped_stale_catchup',
        reasonCode: 'stale_catchup',
        message,
        catchUp: true,
      }),
    });
    await this.store.persist();
    this.broadcastSchedules();
  }

  async markExecutionAccepted(scheduleId: string, receiptId: string, taskId: string, queued: boolean): Promise<void> {
    const schedule = this.requireSchedule(scheduleId);
    const receipt = this.requireReceipt(schedule, receiptId);
    const triggeredAt = new Date().toISOString();
    const latestExecution: ScheduleLatestExecutionStatus = {
      receiptId,
      executionToken: receipt.executionToken,
      ...(receipt.scheduledFor ? { scheduledFor: receipt.scheduledFor } : {}),
      evaluatedAt: receipt.evaluatedAt,
      triggeredAt,
      trigger: receipt.trigger,
      taskId,
      outcome: queued ? 'queued' : 'running',
      reasonCode: 'none',
      ...(receipt.catchUp ? { catchUp: true } : {}),
    };
    this.store.replace({
      ...schedule,
      lastRunAt: triggeredAt,
      lastRunTaskId: taskId,
      ...consumeCronTrigger(schedule, receipt.trigger, true, triggeredAt),
      latestExecution,
      currentExecution: {
        ...receipt,
        taskId,
        status: 'accepted',
      },
      executionLedger: upsertExecutionLedger(schedule, {
        id: receipt.id,
        scheduleId,
        receiptId,
        executionToken: receipt.executionToken,
        ...(receipt.scheduledFor ? { scheduledFor: receipt.scheduledFor } : {}),
        evaluatedAt: receipt.evaluatedAt,
        triggeredAt,
        trigger: receipt.trigger,
        taskId,
        outcome: queued ? 'queued' : 'running',
        reasonCode: 'none',
        ...(receipt.catchUp ? { catchUp: true } : {}),
      }),
    });
    await this.store.persist();
    this.broadcastSchedules();
  }

  async markExecutionOutcome(
    scheduleId: string,
    receiptId: string,
    outcome: Exclude<ScheduleExecutionOutcome, 'completed' | 'cancelled' | 'running' | 'queued'>,
    reasonCode: ScheduleExecutionReasonCode,
    message?: string,
    metadata: { blockingTaskId?: string } = {},
  ): Promise<void> {
    const schedule = this.requireSchedule(scheduleId);
    const receipt = this.requireReceipt(schedule, receiptId);
    const evaluatedAt = new Date().toISOString();
    this.store.replace({
      ...schedule,
      lastRunAt: receipt.evaluatedAt,
      lastRunTaskId: receipt.taskId,
      lastRunStatus: 'failed',
      ...consumeCronTrigger(schedule, receipt.trigger, outcome === 'dispatch_failed', evaluatedAt),
      latestExecution: {
        receiptId,
        executionToken: receipt.executionToken,
        ...(receipt.scheduledFor ? { scheduledFor: receipt.scheduledFor } : {}),
        evaluatedAt: receipt.evaluatedAt,
        trigger: receipt.trigger,
        ...(receipt.taskId ? { taskId: receipt.taskId } : {}),
        outcome,
        reasonCode,
        ...(message ? { message } : {}),
        ...(receipt.catchUp ? { catchUp: true } : {}),
      },
      currentExecution: {
        ...receipt,
        status: outcome === 'unknown_after_restart' ? 'unknown_after_restart' : 'terminal',
      },
      executionLedger: upsertExecutionLedger(schedule, {
        id: receipt.id,
        scheduleId,
        receiptId,
        executionToken: receipt.executionToken,
        ...(receipt.scheduledFor ? { scheduledFor: receipt.scheduledFor } : {}),
        evaluatedAt: receipt.evaluatedAt,
        trigger: receipt.trigger,
        ...(receipt.taskId ? { taskId: receipt.taskId } : {}),
        outcome,
        reasonCode,
        ...(message ? { message } : {}),
        ...(metadata.blockingTaskId ? { blockingTaskId: metadata.blockingTaskId } : {}),
        ...(receipt.catchUp ? { catchUp: true } : {}),
      }),
    });
    await this.store.persist();
    this.broadcastSchedules();
  }

  async recordTaskTerminalOutcome(taskId: string, status: 'completed' | 'cancelled'): Promise<void> {
    const schedule = this.store.list().find((candidate) =>
      candidate.latestExecution?.taskId === taskId
      || candidate.executionLedger?.some((entry) => entry.taskId === taskId)
    );
    if (!schedule) return;

    const latestForTask = schedule.latestExecution?.taskId === taskId ? schedule.latestExecution : undefined;
    const ledgerEntry = schedule.executionLedger?.find((entry) => entry.taskId === taskId);
    if (!latestForTask && !ledgerEntry) return;

    const currentReceipt = schedule.currentExecution;
    const completedAt = new Date().toISOString();
    const entryForTask = latestForTask ?? ledgerEntry!;
    const latestExecution = latestForTask
      ? {
          ...latestForTask,
          outcome: status,
          reasonCode: 'none' as const,
        }
      : schedule.latestExecution;

    this.store.replace({
      ...schedule,
      lastRunAt: completedAt,
      lastRunTaskId: taskId,
      lastRunStatus: status,
      ...(latestExecution ? { latestExecution } : {}),
      ...(currentReceipt?.taskId === taskId ? {
        currentExecution: {
          ...currentReceipt,
          status: 'terminal',
        },
      } : {}),
      executionLedger: upsertExecutionLedger(schedule, {
        id: currentReceipt?.taskId === taskId
          ? currentReceipt.id
          : (entryForTask.receiptId ?? entryForTask.executionToken ?? ledgerEntry?.id ?? taskId),
        scheduleId: schedule.id,
        ...(entryForTask.receiptId ? { receiptId: entryForTask.receiptId } : {}),
        ...(entryForTask.executionToken ? { executionToken: entryForTask.executionToken } : {}),
        ...(entryForTask.scheduledFor ? { scheduledFor: entryForTask.scheduledFor } : {}),
        evaluatedAt: entryForTask.evaluatedAt,
        completedAt,
        trigger: entryForTask.trigger,
        taskId,
        outcome: status,
        reasonCode: 'none',
        ...(entryForTask.catchUp ? { catchUp: true } : {}),
      }),
    });
    await this.store.persist();
    this.broadcastSchedules();
  }

  async reconcileOnStartup(taskStore: TaskStore): Promise<void> {
    let changed = false;
    for (const schedule of this.store.list()) {
      if (schedule.currentExecution && (schedule.currentExecution.status === 'reserved' || schedule.currentExecution.status === 'accepted')) {
        const latest = schedule.latestExecution;
        const taskId = schedule.currentExecution.taskId ?? latest?.taskId;
        if (!taskId) {
          this.store.replace({
            ...schedule,
            latestExecution: latest ?? {
              receiptId: schedule.currentExecution.id,
              executionToken: schedule.currentExecution.executionToken,
              ...(schedule.currentExecution.scheduledFor ? { scheduledFor: schedule.currentExecution.scheduledFor } : {}),
              evaluatedAt: schedule.currentExecution.evaluatedAt,
              trigger: schedule.currentExecution.trigger,
              outcome: 'unknown_after_restart',
              reasonCode: 'unknown_after_restart',
              message: 'Execution could not be reconciled after restart',
            },
            currentExecution: {
              ...schedule.currentExecution,
              status: 'unknown_after_restart',
            },
            executionLedger: upsertExecutionLedger(schedule, {
              id: schedule.currentExecution.id,
              scheduleId: schedule.id,
              receiptId: schedule.currentExecution.id,
              executionToken: schedule.currentExecution.executionToken,
              ...(schedule.currentExecution.scheduledFor ? { scheduledFor: schedule.currentExecution.scheduledFor } : {}),
              evaluatedAt: schedule.currentExecution.evaluatedAt,
              trigger: schedule.currentExecution.trigger,
              outcome: 'unknown_after_restart',
              reasonCode: 'unknown_after_restart',
              message: 'Execution could not be reconciled after restart',
              ...(schedule.currentExecution.catchUp ? { catchUp: true } : {}),
            }),
          });
          changed = true;
          continue;
        }
      }

      const latest = schedule.latestExecution;
      if (!latest) continue;
      if (latest.outcome !== 'running' && latest.outcome !== 'queued') continue;
      if (!latest.taskId) continue;

      const task = taskStore.getTask(latest.taskId);
      if (!task) {
        this.store.replace({
          ...schedule,
          latestExecution: {
            ...latest,
            outcome: 'unknown_after_restart',
            reasonCode: 'unknown_after_restart',
            message: 'Task state could not be reconciled after restart',
          },
          ...(schedule.currentExecution ? {
            currentExecution: {
              ...schedule.currentExecution,
              status: 'unknown_after_restart',
            },
          } : {}),
          executionLedger: upsertExecutionLedger(schedule, {
            id: schedule.currentExecution?.id ?? latest.receiptId ?? latest.executionToken,
            scheduleId: schedule.id,
            ...(latest.receiptId ? { receiptId: latest.receiptId } : {}),
            executionToken: latest.executionToken,
            ...(latest.scheduledFor ? { scheduledFor: latest.scheduledFor } : {}),
            evaluatedAt: latest.evaluatedAt,
            trigger: latest.trigger,
            ...(latest.taskId ? { taskId: latest.taskId } : {}),
            outcome: 'unknown_after_restart',
            reasonCode: 'unknown_after_restart',
            message: 'Task state could not be reconciled after restart',
            ...(latest.catchUp ? { catchUp: true } : {}),
          }),
        });
        changed = true;
        continue;
      }

      if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'terminated') {
        // A 'terminated' task (all sessions died without user ack — see
        // rfc-task-loss-prevention D1) is still a finished run from the
        // schedule's perspective. Map it to the 'completed' outcome so the
        // schedule unblocks for the next cron firing.
        const scheduleOutcome = task.status === 'terminated' ? 'completed' : task.status;
        this.store.replace({
          ...schedule,
          lastRunAt: task.updatedAt.toISOString(),
          lastRunTaskId: task.id,
          lastRunStatus: scheduleOutcome,
          latestExecution: {
            ...latest,
            outcome: scheduleOutcome,
            reasonCode: 'reconciled_after_restart',
          },
          ...(schedule.currentExecution ? {
            currentExecution: {
              ...schedule.currentExecution,
              status: 'terminal',
            },
          } : {}),
          executionLedger: upsertExecutionLedger(schedule, {
            id: schedule.currentExecution?.id ?? latest.receiptId ?? latest.executionToken,
            scheduleId: schedule.id,
            ...(latest.receiptId ? { receiptId: latest.receiptId } : {}),
            executionToken: latest.executionToken,
            ...(latest.scheduledFor ? { scheduledFor: latest.scheduledFor } : {}),
            evaluatedAt: latest.evaluatedAt,
            completedAt: task.updatedAt.toISOString(),
            trigger: latest.trigger,
            taskId: task.id,
            outcome: scheduleOutcome,
            reasonCode: 'reconciled_after_restart',
            ...(latest.catchUp ? { catchUp: true } : {}),
          }),
        });
        changed = true;
      }
    }

    if (changed) {
      await this.store.persist();
      this.broadcastSchedules();
    }
  }

  async previewCron(cron: string) {
    if (!cron.trim()) {
      throw new ScheduleValidationError('Invalid cron expression', { cron: 'Required' });
    }
    if (!isValidCron(cron)) {
      throw new ScheduleValidationError('Invalid cron expression', { cron: 'Invalid cron expression' });
    }
    const { describeCron, nextRun } = await import('../core/cron.js');
    const nextRuns: string[] = [];
    let after = new Date();
    for (let i = 0; i < 3; i++) {
      const next = nextRun(cron, after);
      if (!next) break;
      nextRuns.push(next.toISOString());
      after = next;
    }
    return {
      cronDescription: describeCron(cron),
      nextRuns,
      timezone: currentTimezone(),
    };
  }

  private requireSchedule(id: string): Schedule {
    const schedule = this.store.get(id);
    if (!schedule) throw new ScheduleValidationError(`Schedule not found: ${id}`);
    return schedule;
  }

  private requireReceipt(schedule: Schedule, receiptId: string) {
    if (!schedule.currentExecution || schedule.currentExecution.id !== receiptId) {
      throw new ScheduleValidationError(`Execution receipt not found: ${receiptId}`);
    }
    return schedule.currentExecution;
  }

  private broadcastSchedules(): void {
    this.broadcast?.(this.listResponse());
  }
}

function currentTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function upsertExecutionLedger(
  schedule: Pick<Schedule, 'executionLedger'>,
  entry: ScheduleExecutionLedgerEntry,
): ScheduleExecutionLedgerEntry[] {
  const existing = schedule.executionLedger ?? [];
  const index = existing.findIndex((candidate) => sameLedgerEntry(candidate, entry));
  if (index === -1) {
    return [...existing, entry].slice(-MAX_SCHEDULE_EXECUTION_LEDGER_ENTRIES);
  }

  return existing.map((candidate, candidateIndex) => (
    candidateIndex === index
      ? { ...candidate, ...entry, id: candidate.id }
      : candidate
  )).slice(-MAX_SCHEDULE_EXECUTION_LEDGER_ENTRIES);
}

function sameLedgerEntry(a: ScheduleExecutionLedgerEntry, b: ScheduleExecutionLedgerEntry): boolean {
  if (a.receiptId && b.receiptId) return a.receiptId === b.receiptId;
  if (a.scheduledFor && b.scheduledFor) {
    return a.scheduleId === b.scheduleId
      && a.trigger === b.trigger
      && a.scheduledFor === b.scheduledFor
      && a.outcome === b.outcome;
  }
  return a.id === b.id;
}

function consumeCronTrigger(
  schedule: Schedule,
  trigger: 'cron' | 'manual',
  shouldConsume: boolean,
  now: string,
): Partial<Pick<Schedule, 'remainingTriggers' | 'enabled' | 'stopReason' | 'exhaustedAt'>> {
  if (!shouldConsume || trigger !== 'cron' || schedule.maxTriggers === undefined) {
    return {};
  }

  const remainingBefore = schedule.remainingTriggers ?? schedule.maxTriggers;
  const remainingTriggers = Math.max(remainingBefore - 1, 0);
  return {
    remainingTriggers,
    ...(remainingTriggers === 0 ? {
      enabled: false,
      stopReason: 'trigger_limit_reached' as const,
      exhaustedAt: schedule.exhaustedAt ?? now,
    } : {
      stopReason: undefined,
      exhaustedAt: undefined,
    }),
  };
}
