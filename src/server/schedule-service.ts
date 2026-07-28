import { randomUUID } from 'node:crypto';
import type { TaskStore } from '../core/tasks.js';
import {
  type CreateScheduleInput,
  type Schedule,
  type ScheduleExecutionDecision,
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
import type { TokenUsage } from '../core/usage-types.js';
import { ScheduleValidator, validateCron } from './schedule-validator.js';

/**
 * Cost/tokens + artifact links joined onto a ledger row from its task at
 * write time (issue #1582). Both fields are optional and only ever populated
 * from real task state — a task with no `tokenUsage` yields no `tokenUsage`
 * here (no fabricated zero) and a task with no recorded artifacts yields no
 * `artifacts`.
 */
export interface ScheduleLedgerEnrichment {
  tokenUsage?: TokenUsage;
  artifacts?: string[];
}

/** Minimal task shape the ledger join reads — decouples the service from the full task model. */
export interface LedgerEnrichmentTaskLike {
  tokenUsage?: TokenUsage;
  completionDigest?: { prUrls?: string[] };
}

/**
 * Derive a fire's ledger enrichment from its task (issue #1582). Pure: cost
 * comes from `task.tokenUsage` verbatim (absent when the task never measured
 * usage), artifact links come from the completion digest's PR URLs. Returns an
 * empty object for an absent task so callers can spread it unconditionally.
 */
export function deriveLedgerEnrichment(task: LedgerEnrichmentTaskLike | undefined): ScheduleLedgerEnrichment {
  if (!task) return {};
  const enrichment: ScheduleLedgerEnrichment = {};
  if (task.tokenUsage) enrichment.tokenUsage = task.tokenUsage;
  const artifacts = (task.completionDigest?.prUrls ?? []).filter((url) => typeof url === 'string' && url.length > 0);
  if (artifacts.length > 0) enrichment.artifacts = [...artifacts];
  return enrichment;
}

export interface ScheduleServiceDeps {
  store: ScheduleStore;
  validator: ScheduleValidator;
  broadcast?: (payload: ScheduleListResponse) => void;
  /**
   * Joins a fire's `taskId` to its cost/artifact enrichment at ledger-write
   * time (issue #1582). Optional: when absent, ledger rows write exactly as
   * before with no cost/artifacts. Kept as a narrow lookup rather than a full
   * `TaskStore` handle so the service stays decoupled and the join is trivially
   * stubbed in tests.
   */
  resolveLedgerEnrichment?: (taskId: string) => ScheduleLedgerEnrichment | undefined;
}

export class ScheduleService {
  private readonly store: ScheduleStore;
  private readonly validator: ScheduleValidator;
  private readonly broadcast?: (payload: ScheduleListResponse) => void;
  private readonly resolveLedgerEnrichment?: (taskId: string) => ScheduleLedgerEnrichment | undefined;
  private runnerStartedAt?: string;
  private lastTickCompletedAt?: string;
  private lastError?: string;
  private catchUpMode: 'auto' | 'manual' | 'off' = 'manual';
  private catchUpEnabled = false;

  constructor(deps: ScheduleServiceDeps) {
    this.store = deps.store;
    this.validator = deps.validator;
    this.broadcast = deps.broadcast;
    this.resolveLedgerEnrichment = deps.resolveLedgerEnrichment;
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
      catchUpMode: this.catchUpMode,
      catchUpEnabled: this.catchUpEnabled,
      schedulerHealthy,
      ...(loadError ? { loadError } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  recordRunnerStarted(catchUpMode: 'auto' | 'manual' | 'off'): void {
    this.runnerStartedAt = new Date().toISOString();
    this.catchUpMode = catchUpMode;
    this.catchUpEnabled = catchUpMode === 'auto';
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
    decision: ScheduleExecutionDecision = trigger === 'manual' ? 'manual_run' : 'cron_due',
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
        decision,
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

  async recordCatchUpSkipped(scheduleId: string, scheduledFor: string, message: string): Promise<void> {
    const schedule = this.requireSchedule(scheduleId);
    const evaluatedAt = new Date().toISOString();
    this.store.replace({
      ...schedule,
      lastScheduledFor: evaluatedAt,
      lastCronEvaluatedAt: evaluatedAt,
      latestExecution: {
        executionToken: ledgerKeyFor(schedule.id, 'cron', scheduledFor),
        scheduledFor,
        evaluatedAt,
        trigger: 'cron',
        outcome: 'skipped_stale',
        reasonCode: 'stale_catch_up',
        message,
      },
      executionLedger: upsertLedgerEntry(schedule.executionLedger, {
        id: ledgerKeyFor(schedule.id, 'cron', scheduledFor),
        scheduleId: schedule.id,
        trigger: 'cron',
        decision: 'stale_catch_up',
        scheduledFor,
        evaluatedAt,
        completedAt: evaluatedAt,
        outcome: 'skipped_stale',
        reasonCode: 'stale_catch_up',
        message,
      }),
    });
    await this.store.persist();
    this.broadcastSchedules();
  }

  async recordCatchUpDeferred(scheduleId: string, scheduledFor: string, message: string): Promise<void> {
    const schedule = this.requireSchedule(scheduleId);
    const evaluatedAt = new Date().toISOString();
    this.store.replace({
      ...schedule,
      lastScheduledFor: evaluatedAt,
      lastCronEvaluatedAt: evaluatedAt,
      latestExecution: {
        executionToken: ledgerKeyFor(schedule.id, 'cron', scheduledFor),
        scheduledFor,
        evaluatedAt,
        trigger: 'cron',
        outcome: 'skipped_manual',
        reasonCode: 'manual_catch_up_required',
        message,
      },
      executionLedger: upsertLedgerEntry(schedule.executionLedger, {
        id: ledgerKeyFor(schedule.id, 'cron', scheduledFor),
        scheduleId: schedule.id,
        trigger: 'cron',
        decision: 'manual_catch_up',
        scheduledFor,
        evaluatedAt,
        completedAt: evaluatedAt,
        outcome: 'skipped_manual',
        reasonCode: 'manual_catch_up_required',
        message,
      }),
    });
    await this.store.persist();
    this.broadcastSchedules();
  }

  async suppressCatchUp(scheduleId: string): Promise<void> {
    const schedule = this.requireSchedule(scheduleId);
    const evaluatedAt = new Date().toISOString();
    this.store.replace({
      ...schedule,
      lastScheduledFor: evaluatedAt,
      lastCronEvaluatedAt: evaluatedAt,
      updatedAt: evaluatedAt,
    });
    await this.store.persist();
    this.broadcastSchedules();
  }

  /**
   * `queued` reports whether the launcher pended the task instead of
   * launching it immediately — for the schedule runner's launcher (which
   * routes through the normal task-submission path, issue #1526 Phase A /
   * FM8), that only ever happens because the node was at capacity, so it is
   * recorded as `queued_capacity` (reasonCode `capacity`) rather than the
   * legacy generic `queued`.
   */
  async markExecutionAccepted(scheduleId: string, receiptId: string, taskId: string, queued: boolean): Promise<void> {
    const schedule = this.requireSchedule(scheduleId);
    const receipt = this.requireReceipt(schedule, receiptId);
    const triggeredAt = new Date().toISOString();
    const outcome = queued ? 'queued_capacity' : 'running';
    const reasonCode = queued ? 'capacity' : 'none';
    const latestExecution: ScheduleLatestExecutionStatus = {
      receiptId,
      executionToken: receipt.executionToken,
      ...(receipt.scheduledFor ? { scheduledFor: receipt.scheduledFor } : {}),
      evaluatedAt: receipt.evaluatedAt,
      triggeredAt,
      trigger: receipt.trigger,
      taskId,
      outcome,
      reasonCode,
    };
    this.store.replace({
      ...schedule,
      lastRunAt: triggeredAt,
      lastRunTaskId: taskId,
      ...consumeCronTrigger(schedule, receipt.trigger, true, triggeredAt),
      latestExecution,
      executionLedger: upsertLedgerEntry(schedule.executionLedger, ledgerEntryFromReceipt(
        schedule,
        receipt,
        latestExecution.outcome,
        reasonCode,
        {
          completedAt: triggeredAt,
          taskId,
        },
      )),
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
    outcome: Exclude<ScheduleExecutionOutcome, 'completed' | 'cancelled' | 'running' | 'queued' | 'queued_capacity'>,
    reasonCode: ScheduleExecutionReasonCode,
    message?: string,
    details: { blockingTaskId?: string } = {},
  ): Promise<void> {
    const schedule = this.requireSchedule(scheduleId);
    const receipt = this.requireReceipt(schedule, receiptId);
    const evaluatedAt = new Date().toISOString();
    // issue #1526 Phase A: a skip receipt never carries its own taskId
    // (reserveExecution creates it before any launch attempt), so writing
    // `latestExecution.taskId` from `receipt.taskId` alone WIPES the blocking
    // pointer on every skip. fire() reads `schedule.latestExecution?.taskId`
    // as `blockingTaskId` on the NEXT tick — wiping it here means a second
    // skipped_coalesced/skipped_active in a row loses track of the still-
    // pending/active task and the following fire launches a duplicate
    // instead of skipping again. It also breaks recordTaskTerminalOutcome's
    // schedule lookup (`candidate.latestExecution?.taskId === taskId`), which
    // can no longer find this schedule once the pointer is gone. Falling back
    // to `details.blockingTaskId` (the task this skip was actually blocked
    // by) preserves the pointer across any number of consecutive skips.
    const preservedTaskId = receipt.taskId ?? details.blockingTaskId;
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
        ...(preservedTaskId ? { taskId: preservedTaskId } : {}),
        outcome,
        reasonCode,
        ...(message ? { message } : {}),
      },
      executionLedger: upsertLedgerEntry(schedule.executionLedger, ledgerEntryFromReceipt(
        schedule,
        receipt,
        outcome,
        reasonCode,
        {
          completedAt: evaluatedAt,
          ...(preservedTaskId ? { taskId: preservedTaskId } : {}),
          ...(details.blockingTaskId ? { blockingTaskId: details.blockingTaskId } : {}),
          ...(message ? { message } : {}),
        },
      )),
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

    // Join cost/artifacts onto the row at write time (issue #1582). A null
    // resolver or a task with no measured usage leaves the fields absent.
    const enrichment = this.resolveLedgerEnrichment?.(taskId) ?? {};

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
      executionLedger: updateLedgerEntryForTask(schedule.executionLedger, taskId, {
        outcome: status,
        reasonCode: 'none',
        completedAt: new Date().toISOString(),
        ...(enrichment.tokenUsage ? { tokenUsage: enrichment.tokenUsage } : {}),
        ...(enrichment.artifacts ? { artifacts: enrichment.artifacts } : {}),
      }),
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
    for (const listed of this.store.list()) {
      let schedule = listed;
      if (schedule.currentExecution && (schedule.currentExecution.status === 'reserved' || schedule.currentExecution.status === 'accepted')) {
        const latest = schedule.latestExecution;
        // A 'reserved' receipt never carries its own taskId (only
        // markExecutionAccepted sets one) — the launch died with the previous
        // process before being accepted (issue #1526 Phase C / #1528). Do NOT
        // let a PREVIOUS run's `latestExecution.taskId` mask that: falling
        // back to it here used to leave the wedged receipt 'reserved'
        // forever whenever the schedule had any prior accepted run. Only an
        // 'accepted' receipt may borrow the latest pointer, since for it
        // that pointer really is this execution's task.
        const taskId = schedule.currentExecution.status === 'accepted'
          ? schedule.currentExecution.taskId ?? latest?.taskId
          : schedule.currentExecution.taskId;
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
            executionLedger: upsertLedgerEntry(schedule.executionLedger, ledgerEntryFromReceipt(
              schedule,
              schedule.currentExecution,
              'unknown_after_restart',
              'unknown_after_restart',
              {
                completedAt: new Date().toISOString(),
                message: 'Execution could not be reconciled after restart',
              },
            )),
            currentExecution: {
              ...schedule.currentExecution,
              status: 'unknown_after_restart',
            },
          });
          changed = true;
          // Fall through to the latestExecution reconciliation below with a
          // REFRESHED read: a stale reference here would let the second
          // replace clobber the ledger entry the replace above just wrote
          // (issue #1526 Phase C — a crash between reserveExecution and the
          // outcome can leave BOTH a dead 'reserved' receipt and a
          // 'running' latestExecution needing task-based reconciliation).
          const refreshed = this.store.get(schedule.id);
          if (!refreshed) continue;
          schedule = refreshed;
        }
      }

      const latest = schedule.latestExecution;
      if (!latest) continue;
      // 'queued' is legacy (issue #1526 Phase A retired it in favor of
      // 'queued_capacity') — both mean "mid-flight when the server
      // restarted" and need the same post-restart reconciliation.
      if (latest.outcome !== 'running' && latest.outcome !== 'queued' && latest.outcome !== 'queued_capacity') continue;
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
          executionLedger: updateLedgerEntryForTask(schedule.executionLedger, latest.taskId, {
            outcome: 'unknown_after_restart',
            reasonCode: 'unknown_after_restart',
            message: 'Task state could not be reconciled after restart',
            completedAt: new Date().toISOString(),
          }),
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
        // Enrich the reconciled-completion row too (issue #1582) — the task is
        // already in hand here, so join its cost/artifacts directly.
        const enrichment = deriveLedgerEnrichment(task);
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
          executionLedger: updateLedgerEntryForTask(schedule.executionLedger, task.id, {
            outcome: scheduleOutcome,
            reasonCode: 'reconciled_after_restart',
            completedAt: task.updatedAt.toISOString(),
            ...(enrichment.tokenUsage ? { tokenUsage: enrichment.tokenUsage } : {}),
            ...(enrichment.artifacts ? { artifacts: enrichment.artifacts } : {}),
          }),
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
    const cronError = validateCron(cron);
    if (cronError) {
      throw new ScheduleValidationError('Invalid cron expression', { cron: cronError });
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

function ledgerEntryFromReceipt(
  schedule: Schedule,
  receipt: NonNullable<Schedule['currentExecution']>,
  outcome: ScheduleExecutionOutcome,
  reasonCode: ScheduleExecutionReasonCode,
  details: {
    completedAt: string;
    taskId?: string;
    blockingTaskId?: string;
    message?: string;
  },
): ScheduleExecutionLedgerEntry {
  return {
    id: ledgerKeyFor(schedule.id, receipt.trigger, receipt.scheduledFor ?? receipt.id),
    scheduleId: schedule.id,
    receiptId: receipt.id,
    executionToken: receipt.executionToken,
    trigger: receipt.trigger,
    decision: receipt.decision,
    ...(receipt.scheduledFor ? { scheduledFor: receipt.scheduledFor } : {}),
    evaluatedAt: receipt.evaluatedAt,
    completedAt: details.completedAt,
    outcome,
    reasonCode,
    ...(details.taskId ? { taskId: details.taskId } : {}),
    ...(details.blockingTaskId ? { blockingTaskId: details.blockingTaskId } : {}),
    ...(details.message ? { message: details.message } : {}),
  };
}

function updateLedgerEntryForTask(
  ledger: ScheduleExecutionLedgerEntry[],
  taskId: string,
  patch: Pick<ScheduleExecutionLedgerEntry, 'outcome' | 'reasonCode' | 'completedAt'> & Partial<Pick<ScheduleExecutionLedgerEntry, 'message' | 'tokenUsage' | 'artifacts'>>,
): ScheduleExecutionLedgerEntry[] {
  let updated = false;
  const next = ledger.map((entry) => {
    if (entry.taskId !== taskId) return entry;
    updated = true;
    return { ...entry, ...patch };
  });
  return updated ? next : ledger;
}

function upsertLedgerEntry(
  ledger: ScheduleExecutionLedgerEntry[],
  entry: ScheduleExecutionLedgerEntry,
): ScheduleExecutionLedgerEntry[] {
  const index = ledger.findIndex((candidate) => candidate.id === entry.id);
  if (index === -1) return [...ledger, entry];
  return [
    ...ledger.slice(0, index),
    { ...ledger[index], ...entry },
    ...ledger.slice(index + 1),
  ];
}

function ledgerKeyFor(scheduleId: string, trigger: 'cron' | 'manual', key: string): string {
  return `${scheduleId}:${trigger}:${key}`;
}
