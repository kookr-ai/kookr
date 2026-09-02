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

/**
 * Normalized launch-source bucket for the scoreboard's provenance mix (issue
 * #2801). Derived from each task's immutable {@link TaskProvenance} (issue
 * #1583), collapsed to the origins an operator reasons about:
 *
 *  - `manual`    — a plain API/UI/CLI/websocket/remote creation.
 *  - `scheduled` — fired by the schedule runner (from `schedule` provenance).
 *  - `parent`    — spawned by another task (a child spawn).
 *  - `unknown`   — legacy tasks persisted before provenance existed, or any
 *                  creation path that recorded no launch signal.
 *
 * These are descriptive origin labels only; they imply no quality ranking
 * between launch sources.
 */
export type OutcomeLedgerLaunchSource = 'manual' | 'scheduled' | 'parent' | 'unknown';

/** Every launch-source bucket in a stable display order (issue #2801). */
export const OUTCOME_LEDGER_LAUNCH_SOURCES: readonly OutcomeLedgerLaunchSource[] = [
  'manual',
  'scheduled',
  'parent',
  'unknown',
] as const;

/**
 * Task launch-source mix over the scoreboard window (issue #2801). Answers
 * whether scheduled automation is producing a meaningful share of the observed
 * work without cross-referencing separate surfaces. `total` equals
 * {@link OutcomeLedgerSummary.taskCount}; `counts` always carries every bucket
 * (zeroes included) so the projection is exhaustive, and `shares` is null when
 * there are no tasks to avoid a divide-by-zero share.
 */
export interface OutcomeLedgerLaunchSourceMix {
  total: number;
  counts: Record<OutcomeLedgerLaunchSource, number>;
  shares: Record<OutcomeLedgerLaunchSource, number> | null;
}

export interface OutcomeLedgerWindow {
  value: TimeWindow;
  start: string | null;
  end: string;
}

/**
 * One headline metric's current-vs-previous-window comparison (issue #2784).
 *
 * `current` mirrors the same metric on this response (a rate in `0..1`, or null
 * when the metric is unknown this window). `previous` is that metric recomputed
 * over the immediately preceding equal-duration window. `delta` is
 * `current - previous`, and is null whenever either side is unknown so a missing
 * value renders as "unavailable" rather than being silently read as a zero
 * change. It describes movement only and implies nothing about its cause.
 */
export interface OutcomeLedgerMetricDelta {
  current: number | null;
  previous: number | null;
  delta: number | null;
}

/**
 * Comparison of this window's headline rates against the immediately preceding
 * equal-duration window (issue #2784).
 *
 * When `available`, `previousWindow` bounds the baseline range and each metric
 * carries a {@link OutcomeLedgerMetricDelta}. The comparison is unavailable —
 * with no delta implied — in two cases:
 *  - `all_time_window`: the all-time window has no bounded preceding period.
 *  - `no_previous_data`: the preceding window contains no tasks, so any delta
 *    would be a comparison against nothing rather than a real zero change.
 */
export type OutcomeLedgerComparison =
  | {
      available: true;
      previousWindow: OutcomeLedgerWindow;
      previousTaskCount: number;
      completionRate: OutcomeLedgerMetricDelta;
      verificationCoverage: OutcomeLedgerMetricDelta;
      thumbsUpRate: OutcomeLedgerMetricDelta;
      costCoverage: OutcomeLedgerMetricDelta;
    }
  | {
      available: false;
      reason: 'all_time_window' | 'no_previous_data';
    };

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
  /** Normalized launch origin for this task (issue #2801). */
  launchSource: OutcomeLedgerLaunchSource;
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
  /** Task launch-source mix over the window (issue #2801). */
  launchSourceMix: OutcomeLedgerLaunchSourceMix;
  /**
   * Direction of this window's headline rates versus the immediately preceding
   * equal-duration window (issue #2784). Unavailable for the all-time window
   * and when the preceding window has no tasks.
   */
  comparison: OutcomeLedgerComparison;
  quality: OutcomeLedgerQualitySummary;
  byAgent: OutcomeLedgerByAgentRow[];
  findings: OutcomeLedgerFinding[];
  tasks: OutcomeLedgerTaskRow[];
  notes: string[];
}
