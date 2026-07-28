import type { AgentSelection } from './agent-types.js';
import type { PlaybookScope } from './playbook.js';

export interface SchedulePlaybook {
  path: string;
  parameters: Record<string, string>;
  /**
   * Pinned tier the playbook is resolved from. Optional/additive — absence
   * means the legacy project-tier-only behaviour. Mirrors the `core/schedule`
   * definition (both must carry the field or the types diverge).
   */
  scope?: PlaybookScope;
}

export type ScheduleStopReason = 'trigger_limit_reached';
export type ScheduleExecutionTrigger = 'cron' | 'manual';
export type ScheduleExecutionDecision = 'cron_due' | 'manual_run' | 'catch_up' | 'manual_catch_up' | 'stale_catch_up';
export type ScheduleExecutionOutcome =
  /**
   * @deprecated No longer produced (issue #1526 Phase A) — a capacity-queued
   * fire now records {@link queued_capacity} instead. Kept in the type only
   * so historical ledger rows persisted before this change still render.
   */
  | 'queued'
  /**
   * A schedule fire went through the normal task-submission path and landed
   * as a pending task because the node was at capacity (issue #1526 Phase A
   * / FM8), instead of being dropped as `skipped_capacity`.
   */
  | 'queued_capacity'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'deduplicated'
  | 'dispatch_failed'
  | 'skipped_active'
  /**
   * @deprecated No longer produced (issue #1526 Phase A) — a capacity fire
   * now records `queued_capacity` instead of being dropped.
   */
  | 'skipped_capacity'
  | 'skipped_draining'
  | 'skipped_manual'
  | 'skipped_stale'
  /**
   * Coalesced (issue #1526 Phase A): the previous fire's task is still
   * `pending`. Distinct from `skipped_active` (previous run actively
   * running) so at most one outstanding queued fire per schedule exists.
   */
  | 'skipped_coalesced'
  | 'unknown_after_restart';

export type ScheduleExecutionReasonCode =
  | 'none'
  | 'capacity'
  | 'draining'
  | 'previous_run_active'
  /** Reason code for `skipped_coalesced`. */
  | 'previous_run_pending'
  | 'manual_catch_up_required'
  | 'missing_cwd'
  | 'missing_playbook'
  | 'validation'
  | 'deduplicated'
  | 'launch_error'
  /** Fire rejected by the pending-queue depth limit (issue #1526 Phase C / C3) — mirrors `core/schedule`. */
  | 'pending_queue_full'
  | 'stale_catch_up'
  | 'reconciled_after_restart'
  | 'unknown_after_restart';

export interface ScheduleExecutionLedgerEntry {
  id: string;
  scheduleId: string;
  receiptId?: string;
  executionToken?: string;
  trigger: ScheduleExecutionTrigger;
  decision: ScheduleExecutionDecision;
  scheduledFor?: string;
  evaluatedAt: string;
  completedAt?: string;
  taskId?: string;
  blockingTaskId?: string;
  outcome: ScheduleExecutionOutcome;
  reasonCode?: ScheduleExecutionReasonCode;
  message?: string;
}

export interface ScheduleExecutionReceipt {
  id: string;
  scheduleId: string;
  executionToken: string;
  trigger: ScheduleExecutionTrigger;
  decision: ScheduleExecutionDecision;
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
  /** Optional per-schedule reasoning-effort pin (#1518). */
  effort?: string;
  /** Optional per-schedule model pin (#1518). */
  model?: string;
  lastRunAt?: string;
  lastRunTaskId?: string;
  lastRunStatus?: 'completed' | 'cancelled' | 'failed';
  lastScheduledFor?: string;
  lastCronEvaluatedAt?: string;
  latestExecution?: ScheduleLatestExecutionStatus;
  currentExecution?: ScheduleExecutionReceipt;
  executionLedger: ScheduleExecutionLedgerEntry[];
  createdAt: string;
  updatedAt: string;
}

/** Mirrors `core/schedule` — tri-state playbook resolution health (R9). */
export type PlaybookResolutionState = 'unknown' | 'resolvable' | 'unresolvable';

export interface ScheduleResponse extends Schedule {
  nextRunAt: string | null;
  cronDescription: string;
  /** Cached resolution health; absent on older servers (treat as `unknown`). */
  playbookResolution?: PlaybookResolutionState;
}

export interface ScheduleStatusSnapshot {
  timezone: string;
  runnerStartedAt?: string;
  lastTickCompletedAt?: string;
  catchUpMode: 'auto' | 'manual' | 'off';
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
