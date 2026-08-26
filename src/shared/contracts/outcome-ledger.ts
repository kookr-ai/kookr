import type { AgentType } from './agent-types.js';
import type { TaskStatus } from './task-status.js';
import type { TimeWindow } from './cost-comparison.js';

export type OutcomeLedgerReadiness = 'ready' | 'caution' | 'blocked';

/**
 * Population the Outcome Scoreboard aggregates over (issue #2850). Identity and
 * scope kind are kept in separate discriminated fields so `Unassigned` never
 * needs a magic project ID and an assigned scope never collides with a real
 * project whose ID happens to spell a reserved word.
 *
 * - `all`        — every task in the window (the backward-compatible default).
 * - `assigned`   — only tasks whose `projectId` exactly equals `projectId`.
 * - `unassigned` — only tasks with no `projectId`.
 */
export type OutcomeLedgerProjectScope =
  | { kind: 'all' }
  | { kind: 'assigned'; projectId: string }
  | { kind: 'unassigned' };

export type OutcomeLedgerQualityFlag =
  | 'active_task'
  | 'invalid_timestamps'
  | 'missing_cost'
  | 'zero_cost'
  | 'missing_completion_digest'
  | 'missing_verification'
  | 'no_session'
  | 'missing_intervention_data';

export type OutcomeLedgerFindingKind =
  | 'data_quality'
  | 'duration_extreme'
  | 'cost_extreme'
  | 'intervention_extreme'
  | 'token_extreme';

export type OutcomeLedgerFindingSeverity = 'info' | 'review' | 'critical';

export interface OutcomeLedgerWindow {
  value: TimeWindow;
  start: string | null;
  end: string;
}

export interface OutcomeLedgerSummary {
  taskCount: number;
  terminalTaskCount: number;
  completedTaskCount: number;
  cancelledTaskCount: number;
  terminatedTaskCount: number;
  activeTaskCount: number;
  completionRate: number | null;
  prTaskCount: number;
  verifiedTaskCount: number;
  thumbsUp: number;
  thumbsDown: number;
  feedbackCoverage: number | null;
  thumbsUpRate: number | null;
  totalKnownCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface OutcomeLedgerQualitySummary {
  costKnownTasks: number;
  zeroCostTasks: number;
  missingCostTasks: number;
  costCoverage: number | null;
  durationKnownTasks: number;
  durationCoverage: number | null;
  digestKnownCompletedTasks: number;
  digestCoverage: number | null;
  verificationKnownCompletedTasks: number;
  verificationCoverage: number | null;
  interventionKnownTasks: number;
  interventionCoverage: number | null;
  invalidTimestampTasks: number;
  noSessionTasks: number;
}

export interface OutcomeLedgerByAgentRow {
  agentType: AgentType;
  taskCount: number;
  completedTaskCount: number;
  terminalTaskCount: number;
  completionRate: number | null;
  totalKnownCostUsd: number;
  costCoverage: number | null;
  medianDurationMs: number | null;
  p95DurationMs: number | null;
  thumbsUpRate: number | null;
}

export interface OutcomeLedgerTaskRow {
  taskId: string;
  label: string;
  agentType: AgentType;
  status: TaskStatus;
  projectId: string | null;
  playbookId: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  knownCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  interventionCount: number | null;
  hasCompletionDigest: boolean;
  hasVerificationEvidence: boolean;
  prCount: number;
  feedback: 'up' | 'down' | null;
  flags: OutcomeLedgerQualityFlag[];
}

export interface OutcomeLedgerFinding {
  kind: OutcomeLedgerFindingKind;
  severity: OutcomeLedgerFindingSeverity;
  taskId: string;
  label: string;
  metric: string;
  value: number | string | null;
  message: string;
}

export interface OutcomeLedgerResponse {
  schemaVersion: 'outcome-ledger.v1';
  generatedAt: string;
  window: OutcomeLedgerWindow;
  /** Project population this response was aggregated over (issue #2850). */
  scope: OutcomeLedgerProjectScope;
  readiness: OutcomeLedgerReadiness;
  summary: OutcomeLedgerSummary;
  quality: OutcomeLedgerQualitySummary;
  byAgent: OutcomeLedgerByAgentRow[];
  findings: OutcomeLedgerFinding[];
  tasks: OutcomeLedgerTaskRow[];
  notes: string[];
}
