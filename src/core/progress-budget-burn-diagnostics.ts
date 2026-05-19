import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import type { AgentEvent, TokenUsage } from './types.js';
import type { Task } from './tasks.js';

export const PROGRESS_BUDGET_BURN_DIAGNOSTIC_SCHEMA_VERSION = 'progress-budget-burn-diagnostic.v1';

export type ProgressBudgetBurnVerdict = 'candidate' | 'healthy';

export type ProgressBudgetBurnEvidenceLabel =
  | 'cost_delta_positive'
  | 'token_delta_positive'
  | 'task_status_unchanged'
  | 'task_status_changed'
  | 'no_new_agent_events'
  | 'only_non_progress_events'
  | 'meaningful_event_progress'
  | 'repeated_error_state'
  | 'permission_blocked_state'
  | 'completed_turn_state';

export interface ProgressBudgetBurnDiagnosticRecord {
  schemaVersion: typeof PROGRESS_BUDGET_BURN_DIAGNOSTIC_SCHEMA_VERSION;
  mode: 'diagnostics_only';
  activeQueueInsertionEnabled: false;
  detector: 'progress_aware_budget_burn';
  timestamp: string;
  taskId: string;
  agentId: string;
  taskStatus: Task['status'];
  verdict: ProgressBudgetBurnVerdict;
  confidence: 'high' | 'medium' | 'low' | null;
  reason: string;
  totals: {
    costUsd: number;
    tokens: number;
  };
  deltas: {
    costUsd: number;
    tokens: number;
    eventCount: number;
  };
  evidenceLabels: ProgressBudgetBurnEvidenceLabel[];
}

export interface ProgressBudgetBurnDiagnosticConfig {
  minCostDeltaUsd: number;
  minTokenDelta: number;
  repeatedErrorThreshold: number;
}

export const DEFAULT_PROGRESS_BUDGET_BURN_DIAGNOSTIC_CONFIG: ProgressBudgetBurnDiagnosticConfig = {
  minCostDeltaUsd: 0.05,
  minTokenDelta: 10_000,
  repeatedErrorThreshold: 3,
};

export interface ProgressBudgetBurnDiagnosticInput {
  task: Task;
  agentId: string;
  usage: TokenUsage;
  events: AgentEvent[];
  now?: Date;
}

interface PreviousSample {
  taskStatus: Task['status'];
  costUsd: number;
  tokens: number;
  eventCount: number;
}

interface ProgressBudgetBurnDiagnosticSink {
  append(record: ProgressBudgetBurnDiagnosticRecord): void;
}

export class ProgressBudgetBurnDiagnostics {
  private readonly config: ProgressBudgetBurnDiagnosticConfig;
  private readonly previous = new Map<string, PreviousSample>();

  constructor(
    config: Partial<ProgressBudgetBurnDiagnosticConfig> = {},
    private readonly sink?: ProgressBudgetBurnDiagnosticSink,
  ) {
    this.config = {
      ...DEFAULT_PROGRESS_BUDGET_BURN_DIAGNOSTIC_CONFIG,
      ...config,
    };
  }

  /**
   * Record an advisory progress-aware budget-burn sample.
   *
   * This is intentionally diagnostics-only: it never returns an Anomaly and the
   * caller must not route records into the attention queue.
   */
  sample(input: ProgressBudgetBurnDiagnosticInput): ProgressBudgetBurnDiagnosticRecord | null {
    const current = sampleState(input.task, input.usage, input.events);
    const previous = this.previous.get(input.task.id);
    this.previous.set(input.task.id, current);

    if (!previous) return null;

    const record = evaluateProgressBudgetBurn(input, previous, this.config);
    if (record) this.sink?.append(record);
    return record;
  }
}

export class JsonlProgressBudgetBurnDiagnosticSink implements ProgressBudgetBurnDiagnosticSink {
  constructor(private readonly logFilePath = join(homedir(), '.kookr', 'budget-burn-diagnostics.jsonl')) {}

  append(record: ProgressBudgetBurnDiagnosticRecord): void {
    const line = `${JSON.stringify(record)}\n`;
    mkdir(dirname(this.logFilePath), { recursive: true })
      .then(() => appendFile(this.logFilePath, line, 'utf-8'))
      .catch(() => { /* diagnostics-only path; never affect supervision */ });
  }
}

export function evaluateProgressBudgetBurn(
  input: ProgressBudgetBurnDiagnosticInput,
  previous: PreviousSample,
  config: ProgressBudgetBurnDiagnosticConfig = DEFAULT_PROGRESS_BUDGET_BURN_DIAGNOSTIC_CONFIG,
): ProgressBudgetBurnDiagnosticRecord | null {
  const current = sampleState(input.task, input.usage, input.events);
  const costDeltaUsd = current.costUsd - previous.costUsd;
  const tokenDelta = current.tokens - previous.tokens;
  const eventCountDelta = Math.max(0, current.eventCount - previous.eventCount);
  const burnObserved = costDeltaUsd >= config.minCostDeltaUsd || tokenDelta >= config.minTokenDelta;

  if (!burnObserved) return null;

  const evidenceLabels = buildEvidenceLabels(input.events, previous, current, config);
  const noMeaningfulProgress = evidenceLabels.includes('task_status_unchanged')
    && (
      evidenceLabels.includes('no_new_agent_events')
      || evidenceLabels.includes('only_non_progress_events')
      || evidenceLabels.includes('repeated_error_state')
      || evidenceLabels.includes('permission_blocked_state')
    )
    && !evidenceLabels.includes('completed_turn_state');
  const verdict: ProgressBudgetBurnVerdict = noMeaningfulProgress ? 'candidate' : 'healthy';

  return {
    schemaVersion: PROGRESS_BUDGET_BURN_DIAGNOSTIC_SCHEMA_VERSION,
    mode: 'diagnostics_only',
    activeQueueInsertionEnabled: false,
    detector: 'progress_aware_budget_burn',
    timestamp: (input.now ?? new Date()).toISOString(),
    taskId: input.task.id,
    agentId: input.agentId,
    taskStatus: input.task.status,
    verdict,
    confidence: verdict === 'candidate' ? confidenceFor(evidenceLabels) : null,
    reason: reasonFor(verdict, evidenceLabels),
    totals: {
      costUsd: current.costUsd,
      tokens: current.tokens,
    },
    deltas: {
      costUsd: roundUsdDelta(costDeltaUsd),
      tokens: tokenDelta,
      eventCount: eventCountDelta,
    },
    evidenceLabels,
  };
}

function sampleState(task: Task, usage: TokenUsage, events: AgentEvent[]): PreviousSample {
  return {
    taskStatus: task.status,
    costUsd: usage.costUsd,
    tokens: usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
    eventCount: eventCount(events),
  };
}

function eventCount(events: AgentEvent[]): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const seq = events[i].eventSeq;
    if (typeof seq === 'number') return seq;
  }
  return events.length;
}

function buildEvidenceLabels(
  events: AgentEvent[],
  previous: PreviousSample,
  current: PreviousSample,
  config: ProgressBudgetBurnDiagnosticConfig,
): ProgressBudgetBurnEvidenceLabel[] {
  const labels = new Set<ProgressBudgetBurnEvidenceLabel>();
  const hasSequencedEvents = events.some((event) => typeof event.eventSeq === 'number');
  const newEvents = current.eventCount > previous.eventCount
    ? (
      hasSequencedEvents
        ? events.filter((event) => (event.eventSeq ?? 0) > previous.eventCount)
        : events.slice(previous.eventCount)
    )
    : [];

  labels.add(current.costUsd > previous.costUsd ? 'cost_delta_positive' : 'token_delta_positive');
  if (current.costUsd > previous.costUsd && current.tokens > previous.tokens) labels.add('token_delta_positive');
  labels.add(current.taskStatus === previous.taskStatus ? 'task_status_unchanged' : 'task_status_changed');

  if (newEvents.length === 0) {
    labels.add('no_new_agent_events');
  } else if (newEvents.every(isNonProgressEvent)) {
    labels.add('only_non_progress_events');
  } else {
    labels.add('meaningful_event_progress');
  }

  if (hasRepeatedErrorState(events, config.repeatedErrorThreshold)) labels.add('repeated_error_state');
  if (events.at(-1)?.type === 'permission_request') labels.add('permission_blocked_state');
  if (events.at(-1)?.type === 'stop' || events.at(-1)?.type === 'session_end') {
    labels.add('completed_turn_state');
  }

  return [...labels];
}

function isNonProgressEvent(event: AgentEvent): boolean {
  return event.type === 'error'
    || event.type === 'tool_error'
    || event.type === 'permission_request'
    || event.type === 'notification'
    || event.type === 'subagent_stop';
}

function hasRepeatedErrorState(events: AgentEvent[], threshold: number): boolean {
  const counts = new Map<string, number>();
  for (const event of events) {
    const message = errorMessage(event);
    if (!message) continue;
    const next = (counts.get(message) ?? 0) + 1;
    if (next >= threshold) return true;
    counts.set(message, next);
  }
  return false;
}

function errorMessage(event: AgentEvent): string | null {
  if (event.type === 'error') return event.message;
  if (event.type === 'tool_error') return event.error;
  return null;
}

function confidenceFor(labels: ProgressBudgetBurnEvidenceLabel[]): 'high' | 'medium' | 'low' {
  if (labels.includes('no_new_agent_events') || labels.includes('permission_blocked_state')) return 'high';
  if (labels.includes('repeated_error_state') || labels.includes('only_non_progress_events')) return 'medium';
  return 'low';
}

function reasonFor(
  verdict: ProgressBudgetBurnVerdict,
  labels: ProgressBudgetBurnEvidenceLabel[],
): string {
  if (verdict === 'candidate') {
    if (labels.includes('no_new_agent_events')) {
      return 'Cost or tokens increased while task status and agent events stayed unchanged.';
    }
    if (labels.includes('repeated_error_state')) {
      return 'Cost or tokens increased while the recent event window shows repeated errors.';
    }
    if (labels.includes('permission_blocked_state')) {
      return 'Cost or tokens increased while the latest event is still a permission request.';
    }
    return 'Cost or tokens increased without a meaningful progress signal.';
  }
  return 'Cost or tokens increased, but a progress signal was observed.';
}

function roundUsdDelta(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
