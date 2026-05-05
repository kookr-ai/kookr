import { randomUUID } from 'node:crypto';
import type { TaskStore } from '../core/tasks.js';
import {
  type CreateScheduleInput,
  type Schedule,
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
    const schedulerHealthy = !loadError && (!this.runnerStartedAt || !!lastTickCompletedAt || !this.catchUpEnabled);
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

  async reserveExecution(schedule: Schedule, trigger: 'cron' | 'manual', scheduledFor?: string) {
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
      },
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
      },
      currentExecution: {
        ...receipt,
        status: outcome === 'unknown_after_restart' ? 'unknown_after_restart' : 'terminal',
      },
    });
    await this.store.persist();
    this.broadcastSchedules();
  }

  async recordTaskTerminalOutcome(taskId: string, status: 'completed' | 'cancelled'): Promise<void> {
    const schedule = this.store.list().find((candidate) => candidate.latestExecution?.taskId === taskId);
    if (!schedule?.latestExecution || schedule.latestExecution.taskId !== taskId) return;

    const currentReceipt = schedule.currentExecution;
    if (currentReceipt?.taskId && currentReceipt.taskId !== taskId) return;

    this.store.replace({
      ...schedule,
      lastRunAt: new Date().toISOString(),
      lastRunTaskId: taskId,
      lastRunStatus: status,
      latestExecution: {
        ...schedule.latestExecution,
        outcome: status,
        reasonCode: 'none',
      },
      ...(currentReceipt ? {
        currentExecution: {
          ...currentReceipt,
          status: 'terminal',
        },
      } : {}),
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
