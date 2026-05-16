import { randomUUID } from 'node:crypto';
import { open, readFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentSelection } from './agent-types.js';
import { DEFAULT_AGENT_TYPE, normalizeAgentSelection } from './agent-types.js';
import { isValidCron, nextRun, describeCron } from './cron.js';

export interface SchedulePlaybook {
  path: string;
  parameters: Record<string, string>;
}

export type ScheduleStopReason = 'trigger_limit_reached';
export type ScheduleExecutionTrigger = 'cron' | 'manual';
export type ScheduleExecutionOutcome =
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'deduplicated'
  | 'dispatch_failed'
  | 'skipped_active'
  | 'skipped_capacity'
  | 'unknown_after_restart';

export type ScheduleExecutionReasonCode =
  | 'none'
  | 'capacity'
  | 'previous_run_active'
  | 'missing_cwd'
  | 'missing_playbook'
  | 'validation'
  | 'deduplicated'
  | 'launch_error'
  | 'reconciled_after_restart'
  | 'unknown_after_restart';

export interface ScheduleExecutionReceipt {
  id: string;
  scheduleId: string;
  executionToken: string;
  trigger: ScheduleExecutionTrigger;
  scheduledFor?: string;
  evaluatedAt: string;
  taskId?: string;
  status: 'reserved' | 'accepted' | 'terminal' | 'unknown_after_restart';
}

export interface ScheduleLatestExecutionStatus {
  receiptId?: string;
  executionToken: string;
  scheduledFor?: string;
  evaluatedAt: string;
  triggeredAt?: string;
  trigger: ScheduleExecutionTrigger;
  taskId?: string;
  outcome: ScheduleExecutionOutcome;
  reasonCode?: ScheduleExecutionReasonCode;
  message?: string;
}

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  maxTriggers?: number;
  remainingTriggers?: number;
  stopReason?: ScheduleStopReason;
  exhaustedAt?: string;
  playbook: SchedulePlaybook;
  cwd: string;
  /** Agent for each scheduled run; `round-robin` alternates per run. */
  agentType: AgentSelection;
  /** Legacy dispatch fields kept for migration compatibility. */
  lastRunAt?: string;
  lastRunTaskId?: string;
  lastRunStatus?: 'completed' | 'cancelled' | 'failed';
  /** Cron watermark — used for cadence computation, not UI status. */
  lastScheduledFor?: string;
  lastCronEvaluatedAt?: string;
  latestExecution?: ScheduleLatestExecutionStatus;
  currentExecution?: ScheduleExecutionReceipt;
  createdAt: string;
  updatedAt: string;
}

/** Schedule enriched with computed fields for API responses. */
export interface ScheduleResponse extends Schedule {
  nextRunAt: string | null;
  cronDescription: string;
}

export interface ScheduleStatusSnapshot {
  timezone: string;
  runnerStartedAt?: string;
  lastTickCompletedAt?: string;
  catchUpEnabled: boolean;
  schedulerHealthy: boolean;
  loadError?: string;
  lastError?: string;
}

export interface ScheduleListResponse {
  revision: number;
  schedules: ScheduleResponse[];
  status: ScheduleStatusSnapshot;
}

export interface CreateScheduleInput {
  name: string;
  cron: string;
  maxTriggers?: number;
  playbook: SchedulePlaybook;
  cwd: string;
  agentType?: AgentSelection;
  enabled?: boolean;
}

export interface UpdateScheduleDefinitionInput {
  name?: string;
  cron?: string;
  maxTriggers?: number | null;
  playbook?: SchedulePlaybook;
  cwd?: string;
  agentType?: AgentSelection;
}

export class ScheduleValidationError extends Error {
  fieldErrors?: Record<string, string>;

  constructor(message: string, fieldErrors?: Record<string, string>) {
    super(message);
    this.name = 'ScheduleValidationError';
    this.fieldErrors = fieldErrors;
  }
}

export function isValidMaxTriggers(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function isTriggerLimitExhausted(schedule: Pick<Schedule, 'maxTriggers' | 'remainingTriggers'>): boolean {
  if (schedule.maxTriggers === undefined) return false;
  return (schedule.remainingTriggers ?? schedule.maxTriggers) <= 0;
}

export class ScheduleStore {
  private schedules = new Map<string, Schedule>();
  private filePath: string;
  private persistChain: Promise<void> = Promise.resolve();
  private revision = 0;
  private loadError?: string;

  constructor(kookrDir: string) {
    this.filePath = join(kookrDir, 'schedules.json');
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, 'utf-8');
      const data = JSON.parse(content);
      if (Array.isArray(data)) {
        for (const raw of data) {
          const schedule = normalizeSchedule(raw);
          if (schedule) {
            this.schedules.set(schedule.id, schedule);
          }
        }
      } else {
        this.loadError = `Unexpected schedule file format: ${this.filePath}`;
      }
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
        this.loadError = undefined;
        return;
      }
      this.loadError = err instanceof Error
        ? `Failed to load schedules: ${err.message}`
        : `Failed to load schedules: ${String(err)}`;
      this.schedules.clear();
    } finally {
      this.bumpRevision();
    }
  }

  getLoadError(): string | undefined {
    return this.loadError;
  }

  list(): Schedule[] {
    return Array.from(this.schedules.values());
  }

  listWithComputed(): ScheduleResponse[] {
    return this.list().map(enrichSchedule);
  }

  get(id: string): Schedule | undefined {
    return this.schedules.get(id);
  }

  getWithComputed(id: string): ScheduleResponse | undefined {
    const s = this.schedules.get(id);
    return s ? enrichSchedule(s) : undefined;
  }

  getRevision(): number {
    return this.revision;
  }

  create(input: CreateScheduleInput): Schedule {
    if (!input.name?.trim()) throw new ScheduleValidationError('name is required', { name: 'Required' });
    if (!isValidCron(input.cron)) throw new ScheduleValidationError('Invalid cron expression', { cron: 'Invalid cron expression' });
    if (input.maxTriggers !== undefined && !isValidMaxTriggers(input.maxTriggers)) {
      throw new ScheduleValidationError('Invalid trigger limit', { maxTriggers: 'Must be a positive integer' });
    }
    if (!input.playbook?.path) throw new ScheduleValidationError('playbook.path is required', { playbook: 'Required' });
    if (!input.cwd?.trim()) throw new ScheduleValidationError('cwd is required', { cwd: 'Required' });

    const now = new Date().toISOString();
    const schedule: Schedule = {
      id: randomUUID(),
      name: input.name.trim(),
      enabled: input.enabled ?? true,
      cron: input.cron.trim(),
      ...(input.maxTriggers !== undefined ? {
        maxTriggers: input.maxTriggers,
        remainingTriggers: input.maxTriggers,
      } : {}),
      playbook: {
        path: input.playbook.path,
        parameters: { ...(input.playbook.parameters ?? {}) },
      },
      cwd: input.cwd,
      agentType: input.agentType ?? DEFAULT_AGENT_TYPE,
      createdAt: now,
      updatedAt: now,
    };

    this.schedules.set(schedule.id, schedule);
    this.bumpRevision();
    return schedule;
  }

  updateDefinition(id: string, patch: UpdateScheduleDefinitionInput): Schedule {
    const existing = this.schedules.get(id);
    if (!existing) throw new ScheduleValidationError(`Schedule not found: ${id}`);

    if (patch.cron !== undefined && !isValidCron(patch.cron)) {
      throw new ScheduleValidationError('Invalid cron expression', { cron: 'Invalid cron expression' });
    }
    if (patch.maxTriggers !== undefined && patch.maxTriggers !== null && !isValidMaxTriggers(patch.maxTriggers)) {
      throw new ScheduleValidationError('Invalid trigger limit', { maxTriggers: 'Must be a positive integer' });
    }

    const { maxTriggers, ...rest } = patch;
    const nextTriggerState = computeUpdatedTriggerState(existing, maxTriggers, new Date().toISOString());
    const updated: Schedule = {
      ...existing,
      ...rest,
      ...nextTriggerState,
      ...(patch.playbook ? {
        playbook: {
          path: patch.playbook.path,
          parameters: { ...(patch.playbook.parameters ?? {}) },
        },
      } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.schedules.set(id, updated);
    this.bumpRevision();
    return updated;
  }

  setEnabled(id: string, enabled: boolean): Schedule {
    const existing = this.schedules.get(id);
    if (!existing) throw new ScheduleValidationError(`Schedule not found: ${id}`);
    const updated = {
      ...existing,
      enabled,
      updatedAt: new Date().toISOString(),
    };
    this.schedules.set(id, updated);
    this.bumpRevision();
    return updated;
  }

  delete(id: string): boolean {
    const deleted = this.schedules.delete(id);
    if (deleted) {
      this.bumpRevision();
    }
    return deleted;
  }

  replace(schedule: Schedule): void {
    this.schedules.set(schedule.id, {
      ...schedule,
      updatedAt: new Date().toISOString(),
    });
    this.bumpRevision();
  }

  async persist(): Promise<void> {
    this.persistChain = this.persistChain.then(async () => {
      const data = JSON.stringify(this.list(), null, 2);
      const tmpPath = join(dirname(this.filePath), `.schedules-${randomUUID()}.tmp`);
      await mkdir(dirname(this.filePath), { recursive: true });
      const fh = await open(tmpPath, 'w');
      try {
        await fh.writeFile(data, 'utf-8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmpPath, this.filePath);
    });
    return this.persistChain;
  }

  private bumpRevision(): void {
    this.revision += 1;
  }
}

function normalizeSchedule(raw: unknown): Schedule | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<Schedule>;
  if (!candidate.id || !candidate.cron || !candidate.playbook?.path || !candidate.cwd) {
    return null;
  }

  const normalized: Schedule = {
    id: String(candidate.id),
    name: typeof candidate.name === 'string' ? candidate.name : 'Unnamed schedule',
    enabled: candidate.enabled ?? true,
    cron: String(candidate.cron),
    ...normalizeTriggerState(candidate),
    playbook: {
      path: String(candidate.playbook.path),
      parameters: { ...(candidate.playbook.parameters ?? {}) },
    },
    cwd: String(candidate.cwd),
    agentType: normalizeAgentSelection(candidate.agentType),
    createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString(),
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date().toISOString(),
    ...(typeof candidate.lastRunAt === 'string' ? { lastRunAt: candidate.lastRunAt } : {}),
    ...(typeof candidate.lastRunTaskId === 'string' ? { lastRunTaskId: candidate.lastRunTaskId } : {}),
    ...(candidate.lastRunStatus ? { lastRunStatus: candidate.lastRunStatus } : {}),
    ...(typeof candidate.lastScheduledFor === 'string' ? { lastScheduledFor: candidate.lastScheduledFor } : {}),
    ...(typeof candidate.lastCronEvaluatedAt === 'string' ? { lastCronEvaluatedAt: candidate.lastCronEvaluatedAt } : {}),
    ...(candidate.latestExecution ? { latestExecution: normalizeLatestExecution(candidate.latestExecution) } : {}),
    ...(candidate.currentExecution ? { currentExecution: normalizeCurrentExecution(candidate.currentExecution) } : {}),
  };

  return normalized;
}

function normalizeLatestExecution(raw: unknown): ScheduleLatestExecutionStatus | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Partial<ScheduleLatestExecutionStatus>;
  if (!candidate.executionToken || !candidate.evaluatedAt || !candidate.trigger || !candidate.outcome) {
    return undefined;
  }
  return {
    executionToken: candidate.executionToken,
    evaluatedAt: candidate.evaluatedAt,
    trigger: candidate.trigger,
    outcome: candidate.outcome,
    ...(candidate.receiptId ? { receiptId: candidate.receiptId } : {}),
    ...(candidate.scheduledFor ? { scheduledFor: candidate.scheduledFor } : {}),
    ...(candidate.triggeredAt ? { triggeredAt: candidate.triggeredAt } : {}),
    ...(candidate.taskId ? { taskId: candidate.taskId } : {}),
    ...(candidate.reasonCode ? { reasonCode: candidate.reasonCode } : {}),
    ...(candidate.message ? { message: candidate.message } : {}),
  };
}

function normalizeCurrentExecution(raw: unknown): ScheduleExecutionReceipt | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Partial<ScheduleExecutionReceipt>;
  if (!candidate.id || !candidate.executionToken || !candidate.scheduleId || !candidate.trigger || !candidate.evaluatedAt || !candidate.status) {
    return undefined;
  }
  return {
    id: candidate.id,
    executionToken: candidate.executionToken,
    scheduleId: candidate.scheduleId,
    trigger: candidate.trigger,
    evaluatedAt: candidate.evaluatedAt,
    status: candidate.status,
    ...(candidate.scheduledFor ? { scheduledFor: candidate.scheduledFor } : {}),
    ...(candidate.taskId ? { taskId: candidate.taskId } : {}),
  };
}

function normalizeTriggerState(candidate: Partial<Schedule>): Pick<Schedule, 'maxTriggers' | 'remainingTriggers' | 'stopReason' | 'exhaustedAt'> {
  const maxTriggers = isValidMaxTriggers(candidate.maxTriggers) ? candidate.maxTriggers : undefined;
  if (maxTriggers === undefined) {
    return {
      maxTriggers: undefined,
      remainingTriggers: undefined,
      stopReason: undefined,
      exhaustedAt: undefined,
    };
  }

  const remainingTriggers = isValidRemainingTriggers(candidate.remainingTriggers)
    ? Math.min(candidate.remainingTriggers, maxTriggers)
    : maxTriggers;
  return {
    maxTriggers,
    remainingTriggers,
    stopReason: candidate.stopReason === 'trigger_limit_reached' ? candidate.stopReason : undefined,
    exhaustedAt: typeof candidate.exhaustedAt === 'string' ? candidate.exhaustedAt : undefined,
  };
}

function isValidRemainingTriggers(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function computeUpdatedTriggerState(
  existing: Schedule,
  nextMaxTriggers: number | null | undefined,
  now: string,
): Pick<Schedule, 'maxTriggers' | 'remainingTriggers' | 'stopReason' | 'exhaustedAt'> & Partial<Pick<Schedule, 'enabled'>> {
  if (nextMaxTriggers === undefined) {
    return {
      maxTriggers: existing.maxTriggers,
      remainingTriggers: existing.remainingTriggers,
      stopReason: existing.stopReason,
      exhaustedAt: existing.exhaustedAt,
    };
  }

  if (nextMaxTriggers === null) {
    return {
      maxTriggers: undefined,
      remainingTriggers: undefined,
      stopReason: undefined,
      exhaustedAt: undefined,
    };
  }

  const consumed = existing.maxTriggers === undefined
    ? 0
    : Math.max(existing.maxTriggers - (existing.remainingTriggers ?? existing.maxTriggers), 0);
  const remainingTriggers = Math.max(nextMaxTriggers - consumed, 0);
  return {
    maxTriggers: nextMaxTriggers,
    remainingTriggers,
    stopReason: remainingTriggers === 0 ? 'trigger_limit_reached' : undefined,
    exhaustedAt: remainingTriggers === 0 ? (existing.exhaustedAt ?? now) : undefined,
    ...(remainingTriggers === 0 ? { enabled: false } : {}),
  };
}

/** Enrich a schedule with computed nextRunAt and cronDescription. */
function enrichSchedule(s: Schedule): ScheduleResponse {
  const after = s.lastScheduledFor ? new Date(s.lastScheduledFor) : new Date(s.createdAt);
  const next = s.enabled && !isTriggerLimitExhausted(s) ? nextRun(s.cron, after) : null;
  const effectiveNext = next && next.getTime() <= Date.now()
    ? nextRun(s.cron, new Date())
    : next;
  return {
    ...s,
    nextRunAt: effectiveNext?.toISOString() ?? null,
    cronDescription: describeCron(s.cron),
  };
}
