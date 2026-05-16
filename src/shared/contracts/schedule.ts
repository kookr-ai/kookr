import type { AgentSelection } from './agent-types.js';

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
  lastRunAt?: string;
  lastRunTaskId?: string;
  lastRunStatus?: 'completed' | 'cancelled' | 'failed';
  lastScheduledFor?: string;
  lastCronEvaluatedAt?: string;
  latestExecution?: ScheduleLatestExecutionStatus;
  currentExecution?: ScheduleExecutionReceipt;
  createdAt: string;
  updatedAt: string;
}

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
