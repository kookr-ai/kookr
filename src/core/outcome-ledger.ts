import type { AgentType } from './agent-types.js';
import type { InteractionEvent } from './interaction-log.js';
import { isTerminalStatus, type Task } from './tasks.js';
import type { TokenUsage } from './usage-types.js';
import type { TimeWindow } from '../shared/contracts/cost-comparison.js';
import type {
  OutcomeLedgerByAgentRow,
  OutcomeLedgerFinding,
  OutcomeLedgerProjectScope,
  OutcomeLedgerQualityFlag,
  OutcomeLedgerQualitySummary,
  OutcomeLedgerReadiness,
  OutcomeLedgerResponse,
  OutcomeLedgerSummary,
  OutcomeLedgerTaskRow,
} from '../shared/contracts/outcome-ledger.js';

export interface OutcomeLedgerInput {
  tasks: Task[];
  window: TimeWindow;
  windowStartMs: number;
  windowEndMs: number;
  /**
   * Project population to aggregate over (issue #2850). Absent is treated as
   * `{ kind: 'all' }`, preserving the pre-scope all-project behavior.
   */
  projectScope?: OutcomeLedgerProjectScope;
  liveUsage?: Map<string, TokenUsage>;
  liveTaskIds?: ReadonlySet<string>;
  interactionEvents?: InteractionEvent[];
  interactionTaskIds?: ReadonlySet<string>;
}

interface MutableAgentRow extends OutcomeLedgerByAgentRow {
  durations: number[];
  feedbackUp: number;
  feedbackDown: number;
}

interface NumericCandidate {
  task: OutcomeLedgerTaskRow;
  value: number;
}

const MAX_FINDINGS = 12;

export function buildOutcomeLedger(input: OutcomeLedgerInput): OutcomeLedgerResponse {
  const generatedAt = new Date(input.windowEndMs).toISOString();
  const windowStart = input.window === 'all' ? null : new Date(input.windowStartMs).toISOString();
  const scope = input.projectScope ?? { kind: 'all' };
  // Filter to the requested project population BEFORE any aggregation so that
  // summary, readiness, quality coverage, findings, per-agent rows, and task
  // rows all recompute over the same task set (issue #2850). An unknown project
  // ID simply matches nothing here and yields a valid empty scoreboard rather
  // than broadening the query.
  const taskRows = input.tasks
    .filter((task) => taskMatchesScope(task, scope))
    .filter((task) => isTaskInWindow(task, input.windowStartMs, input.windowEndMs))
    .map((task) => projectTask(task, input));

  const summary = summarize(taskRows);
  const quality = summarizeQuality(taskRows);
  const byAgent = summarizeByAgent(taskRows);
  const findings = buildFindings(taskRows);
  const readiness = computeReadiness(summary, quality, findings);

  return {
    schemaVersion: 'outcome-ledger.v1',
    generatedAt,
    window: {
      value: input.window,
      start: windowStart,
      end: generatedAt,
    },
    scope,
    readiness,
    summary,
    quality,
    byAgent,
    findings,
    tasks: sortTasks(taskRows),
    notes: buildNotes(summary, quality, findings, readiness),
  };
}

function isTaskInWindow(task: Task, startMs: number, endMs: number): boolean {
  const createdMs = toMs(task.createdAt);
  return createdMs >= startMs && createdMs <= endMs;
}

function taskMatchesScope(task: Task, scope: OutcomeLedgerProjectScope): boolean {
  switch (scope.kind) {
    case 'all':
      return true;
    case 'unassigned':
      // A task counts as unassigned when it carries no project identity at all;
      // `undefined` and `null` are treated alike.
      return (task.projectId ?? null) === null;
    case 'assigned':
      return task.projectId === scope.projectId;
  }
}

function projectTask(task: Task, input: OutcomeLedgerInput): OutcomeLedgerTaskRow {
  const startedMs = toMs(task.createdAt);
  const terminal = isTerminalStatus(task.status);
  const finishedMs = terminal
    ? toMs(task.finishedAt ?? task.terminatedAt ?? task.updatedAt)
    : null;
  const durationMs = finishedMs == null
    ? null
    : Number.isFinite(startedMs) && Number.isFinite(finishedMs) && finishedMs >= startedMs
      ? finishedMs - startedMs
      : null;
  const usage = resolveUsage(task, input.liveUsage);
  const interventions = countInterventions(task, input.interactionEvents, input.interactionTaskIds);
  const digest = task.completionDigest;
  const flags: OutcomeLedgerQualityFlag[] = [];
  const hasVerificationEvidence = Boolean(digest?.testSummary || (digest?.verificationCommands?.length ?? 0) > 0);

  if (!terminal) flags.push('active_task');
  if (!Number.isFinite(startedMs) || (finishedMs != null && (!Number.isFinite(finishedMs) || finishedMs < startedMs))) {
    flags.push('invalid_timestamps');
  }
  if (usage.costUsd == null) flags.push('missing_cost');
  else if (usage.costUsd === 0 && task.sessions.length > 0) flags.push('zero_cost');
  if (task.status === 'completed' && !digest) flags.push('missing_completion_digest');
  if (task.status === 'completed' && !hasVerificationEvidence) flags.push('missing_verification');
  if (task.sessions.length === 0) flags.push('no_session');
  if (interventions == null) flags.push('missing_intervention_data');

  return {
    taskId: task.id,
    label: labelTask(task, input.liveTaskIds),
    agentType: task.agentType,
    status: task.status,
    projectId: task.projectId ?? null,
    playbookId: task.playbookId ?? null,
    startedAt: new Date(Number.isFinite(startedMs) ? startedMs : input.windowEndMs).toISOString(),
    finishedAt: finishedMs == null || !Number.isFinite(finishedMs) ? null : new Date(finishedMs).toISOString(),
    durationMs,
    knownCostUsd: usage.costUsd,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    interventionCount: interventions,
    hasCompletionDigest: Boolean(digest),
    hasVerificationEvidence,
    prCount: digest?.prUrls?.length ?? 0,
    feedback: task.completionFeedback?.rating ?? null,
    flags,
  };
}

function resolveUsage(task: Task, liveUsage?: Map<string, TokenUsage>): {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
} {
  const live = liveUsage?.get(task.id);
  if (live) {
    return {
      inputTokens: live.inputTokens,
      outputTokens: live.outputTokens,
      costUsd: live.costUsd,
    };
  }
  if (task.tokenUsage) {
    return {
      inputTokens: task.tokenUsage.inputTokens,
      outputTokens: task.tokenUsage.outputTokens,
      costUsd: task.tokenUsage.costUsd,
    };
  }
  const digestUsage = task.completionDigest?.tokenUsage;
  if (digestUsage?.quality === 'available') {
    return {
      inputTokens: digestUsage.inputTokens,
      outputTokens: digestUsage.outputTokens,
      costUsd: digestUsage.costUsd,
    };
  }
  return { inputTokens: null, outputTokens: null, costUsd: null };
}

function countInterventions(
  task: Task,
  events: InteractionEvent[] | undefined,
  interactionTaskIds: ReadonlySet<string> | undefined,
): number | null {
  if (!events) return null;
  if (interactionTaskIds && !interactionTaskIds.has(task.id)) return null;
  const sessionIds = new Set(task.sessions.map((session) => session.tmuxSession));
  let count = 0;
  for (const event of events) {
    if ('taskId' in event && event.taskId === task.id) {
      count += isInterventionEvent(event) ? 1 : 0;
      continue;
    }
    if ('agentId' in event && typeof event.agentId === 'string' && sessionIds.has(event.agentId)) {
      count += isInterventionEvent(event) ? 1 : 0;
    }
  }
  return count;
}

function isInterventionEvent(event: InteractionEvent): boolean {
  return event.type === 'user_input'
    || event.type === 'finding_skipped'
    || event.type === 'finding_snoozed'
    || event.type === 'finding_feedback'
    || event.type === 'missed_finding'
    || event.type === 'task_feedback_submitted'
    || event.type === 'task_feedback_amended'
    || event.type === 'task_completed'
    || event.type === 'task_cancelled';
}

function summarize(rows: OutcomeLedgerTaskRow[]): OutcomeLedgerSummary {
  let completed = 0;
  let cancelled = 0;
  let terminated = 0;
  let active = 0;
  let terminal = 0;
  let prTaskCount = 0;
  let verifiedTaskCount = 0;
  let thumbsUp = 0;
  let thumbsDown = 0;
  let totalKnownCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (const row of rows) {
    if (isTerminalStatus(row.status)) terminal++;
    else active++;
    if (row.status === 'completed') completed++;
    else if (row.status === 'cancelled') cancelled++;
    else if (row.status === 'terminated') terminated++;
    if (row.prCount > 0) prTaskCount++;
    if (row.hasVerificationEvidence) verifiedTaskCount++;
    if (row.feedback === 'up') thumbsUp++;
    else if (row.feedback === 'down') thumbsDown++;
    if (row.knownCostUsd != null) totalKnownCostUsd += row.knownCostUsd;
    if (row.inputTokens != null) totalInputTokens += row.inputTokens;
    if (row.outputTokens != null) totalOutputTokens += row.outputTokens;
  }

  const feedbackDenominator = thumbsUp + thumbsDown;
  return {
    taskCount: rows.length,
    terminalTaskCount: terminal,
    completedTaskCount: completed,
    cancelledTaskCount: cancelled,
    terminatedTaskCount: terminated,
    activeTaskCount: active,
    completionRate: terminal > 0 ? completed / terminal : null,
    prTaskCount,
    verifiedTaskCount,
    thumbsUp,
    thumbsDown,
    feedbackCoverage: rows.length > 0 ? feedbackDenominator / rows.length : null,
    thumbsUpRate: feedbackDenominator > 0 ? thumbsUp / feedbackDenominator : null,
    totalKnownCostUsd,
    totalInputTokens,
    totalOutputTokens,
  };
}

function summarizeQuality(rows: OutcomeLedgerTaskRow[]): OutcomeLedgerQualitySummary {
  const completed = rows.filter((row) => row.status === 'completed');
  const terminal = rows.filter((row) => isTerminalStatus(row.status));
  const quality: OutcomeLedgerQualitySummary = {
    costKnownTasks: rows.filter((row) => row.knownCostUsd != null).length,
    zeroCostTasks: rows.filter((row) => row.flags.includes('zero_cost')).length,
    missingCostTasks: rows.filter((row) => row.flags.includes('missing_cost')).length,
    costCoverage: rows.length > 0 ? rows.filter((row) => row.knownCostUsd != null).length / rows.length : null,
    durationKnownTasks: terminal.filter((row) => row.durationMs != null).length,
    durationCoverage: terminal.length > 0 ? terminal.filter((row) => row.durationMs != null).length / terminal.length : null,
    digestKnownCompletedTasks: completed.filter((row) => row.hasCompletionDigest).length,
    digestCoverage: completed.length > 0 ? completed.filter((row) => row.hasCompletionDigest).length / completed.length : null,
    verificationKnownCompletedTasks: completed.filter((row) => row.hasVerificationEvidence).length,
    verificationCoverage: completed.length > 0 ? completed.filter((row) => row.hasVerificationEvidence).length / completed.length : null,
    interventionKnownTasks: rows.filter((row) => row.interventionCount != null).length,
    interventionCoverage: rows.length > 0 ? rows.filter((row) => row.interventionCount != null).length / rows.length : null,
    invalidTimestampTasks: rows.filter((row) => row.flags.includes('invalid_timestamps')).length,
    noSessionTasks: rows.filter((row) => row.flags.includes('no_session')).length,
  };
  return quality;
}

function summarizeByAgent(rows: OutcomeLedgerTaskRow[]): OutcomeLedgerByAgentRow[] {
  const byAgent = new Map<AgentType, MutableAgentRow>();
  for (const row of rows) {
    let acc = byAgent.get(row.agentType);
    if (!acc) {
      acc = {
        agentType: row.agentType,
        taskCount: 0,
        completedTaskCount: 0,
        terminalTaskCount: 0,
        completionRate: null,
        totalKnownCostUsd: 0,
        costCoverage: null,
        medianDurationMs: null,
        p95DurationMs: null,
        thumbsUpRate: null,
        durations: [],
        feedbackUp: 0,
        feedbackDown: 0,
      };
      byAgent.set(row.agentType, acc);
    }
    acc.taskCount++;
    if (row.status === 'completed') acc.completedTaskCount++;
    if (isTerminalStatus(row.status)) acc.terminalTaskCount++;
    if (row.knownCostUsd != null) acc.totalKnownCostUsd += row.knownCostUsd;
    if (row.durationMs != null) acc.durations.push(row.durationMs);
    if (row.feedback === 'up') acc.feedbackUp++;
    else if (row.feedback === 'down') acc.feedbackDown++;
  }

  return [...byAgent.values()].map((acc) => {
    const agentRows = rows.filter((row) => row.agentType === acc.agentType);
    const costKnown = agentRows.filter((row) => row.knownCostUsd != null).length;
    const feedbackDenom = acc.feedbackUp + acc.feedbackDown;
    const sortedDurations = acc.durations.slice().sort((a, b) => a - b);
    return {
      agentType: acc.agentType,
      taskCount: acc.taskCount,
      completedTaskCount: acc.completedTaskCount,
      terminalTaskCount: acc.terminalTaskCount,
      completionRate: acc.terminalTaskCount > 0 ? acc.completedTaskCount / acc.terminalTaskCount : null,
      totalKnownCostUsd: acc.totalKnownCostUsd,
      costCoverage: acc.taskCount > 0 ? costKnown / acc.taskCount : null,
      medianDurationMs: sortedDurations.length > 0 ? percentile(sortedDurations, 0.5) : null,
      p95DurationMs: sortedDurations.length > 0 ? percentile(sortedDurations, 0.95) : null,
      thumbsUpRate: feedbackDenom > 0 ? acc.feedbackUp / feedbackDenom : null,
    };
  }).sort((a, b) => b.taskCount - a.taskCount);
}

function buildFindings(rows: OutcomeLedgerTaskRow[]): OutcomeLedgerFinding[] {
  const findings: OutcomeLedgerFinding[] = [];
  for (const row of rows) {
    for (const flag of row.flags) {
      const finding = findingForFlag(row, flag);
      if (finding) findings.push(finding);
    }
  }
  findings.push(...extremeFindings('duration_extreme', 'durationMs', rows
    .filter((row): row is OutcomeLedgerTaskRow & { durationMs: number } => row.durationMs != null)
    .map((task) => ({ task, value: task.durationMs }))));
  findings.push(...extremeFindings('cost_extreme', 'knownCostUsd', rows
    .filter((row): row is OutcomeLedgerTaskRow & { knownCostUsd: number } => row.knownCostUsd != null)
    .map((task) => ({ task, value: task.knownCostUsd }))));
  findings.push(...extremeFindings('intervention_extreme', 'interventionCount', rows
    .filter((row): row is OutcomeLedgerTaskRow & { interventionCount: number } => row.interventionCount != null)
    .map((task) => ({ task, value: task.interventionCount }))));
  findings.push(...extremeFindings('token_extreme', 'totalTokens', rows
    .filter((row) => row.inputTokens != null || row.outputTokens != null)
    .map((task) => ({ task, value: (task.inputTokens ?? 0) + (task.outputTokens ?? 0) }))));

  return findings
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, MAX_FINDINGS);
}

function findingForFlag(row: OutcomeLedgerTaskRow, flag: OutcomeLedgerQualityFlag): OutcomeLedgerFinding | null {
  const base = {
    kind: 'data_quality' as const,
    taskId: row.taskId,
    label: row.label,
  };
  switch (flag) {
    case 'invalid_timestamps':
      return { ...base, severity: 'critical', metric: 'duration', value: row.durationMs, message: 'Task timestamps are invalid; duration-based conclusions are unsafe until this row is fixed.' };
    case 'missing_cost':
      return { ...base, severity: 'review', metric: 'cost', value: null, message: 'Cost is unknown, not zero. Exclude this task from spend conclusions until token accounting is understood.' };
    case 'zero_cost':
      return { ...base, severity: 'review', metric: 'cost', value: 0, message: 'A task with at least one session reports exactly $0 cost. Verify whether this is true zero work, cancelled work, or missing accounting.' };
    case 'missing_completion_digest':
      return { ...base, severity: 'review', metric: 'digest', value: 'missing', message: 'Completed task has no completion digest, so outcome evidence may be incomplete.' };
    case 'missing_verification':
      return { ...base, severity: 'review', metric: 'verification', value: 'missing', message: 'Completed task has no detected test or verification command evidence.' };
    case 'no_session':
      return { ...base, severity: 'info', metric: 'sessions', value: 0, message: 'Task has no sessions; include it in lifecycle counts but treat runtime/cost evidence cautiously.' };
    case 'missing_intervention_data':
      return null;
    case 'active_task':
      return null;
  }
  return assertNever(flag);
}

function extremeFindings(
  kind: Exclude<OutcomeLedgerFinding['kind'], 'data_quality'>,
  metric: string,
  candidates: NumericCandidate[],
): OutcomeLedgerFinding[] {
  if (candidates.length < 4) return [];
  const sortedValues = candidates.map((item) => item.value).sort((a, b) => a - b);
  const q1 = percentile(sortedValues, 0.25);
  const q3 = percentile(sortedValues, 0.75);
  const iqr = q3 - q1;
  const threshold = q3 + Math.max(iqr * 3, minimumExtremeGap(metric));
  const max = sortedValues[sortedValues.length - 1];
  const secondMax = sortedValues[sortedValues.length - 2] ?? 0;
  // IQR can miss obvious small-sample failures when one row pulls Q3 upward, so
  // also flag a max value that is far beyond the next-largest observed row.
  const gapThreshold = secondMax + Math.max(Math.abs(secondMax) * 4, minimumExtremeGap(metric));
  const maxIsGapExtreme = max > gapThreshold;
  if (max <= threshold && !maxIsGapExtreme) return [];
  const includeThreshold = maxIsGapExtreme ? Math.min(threshold, gapThreshold) : threshold;

  return candidates
    .filter((item) => item.value === max || item.value > includeThreshold)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3)
    .map((item) => ({
      kind,
      severity: 'review',
      taskId: item.task.taskId,
      label: item.task.label,
      metric,
      value: item.value,
      message: `${humanMetric(metric)} is far outside the observed distribution. Inspect this row before trusting aggregate ${humanMetric(metric).toLowerCase()} conclusions.`,
    }));
}

function minimumExtremeGap(metric: string): number {
  if (metric === 'durationMs') return 10 * 60 * 1000;
  if (metric === 'knownCostUsd') return 0.01;
  if (metric === 'interventionCount') return 3;
  if (metric === 'totalTokens') return 10_000;
  return 1;
}

function computeReadiness(
  summary: OutcomeLedgerSummary,
  quality: OutcomeLedgerQualitySummary,
  findings: OutcomeLedgerFinding[],
): OutcomeLedgerReadiness {
  if (summary.taskCount === 0) return 'blocked';
  if (findings.some((finding) => finding.severity === 'critical')) return 'blocked';
  if ((quality.costCoverage ?? 0) < 0.8 && summary.taskCount >= 3) return 'blocked';
  if (findings.some((finding) => finding.severity === 'review')) return 'caution';
  if ((quality.verificationCoverage ?? 1) < 0.6 && summary.completedTaskCount >= 3) return 'caution';
  return 'ready';
}

function buildNotes(
  summary: OutcomeLedgerSummary,
  quality: OutcomeLedgerQualitySummary,
  findings: OutcomeLedgerFinding[],
  readiness: OutcomeLedgerReadiness,
): string[] {
  const notes: string[] = [];
  if (readiness === 'blocked') {
    notes.push('Do not draw trend conclusions yet; data coverage or timestamp integrity is not strong enough.');
  } else if (readiness === 'caution') {
    notes.push('Treat trends as provisional until the review findings below are explained or fixed.');
  } else {
    notes.push('No critical data-quality blockers were found in this window.');
  }
  if (quality.missingCostTasks > 0) {
    notes.push(`${quality.missingCostTasks} task${quality.missingCostTasks === 1 ? '' : 's'} have unknown cost. Unknown is kept separate from zero.`);
  }
  if (quality.zeroCostTasks > 0) {
    notes.push(`${quality.zeroCostTasks} task${quality.zeroCostTasks === 1 ? '' : 's'} report exactly $0 despite having sessions; inspect these as likely high-signal edge cases.`);
  }
  const reviewCount = findings.filter((finding) => finding.severity === 'review').length;
  if (reviewCount > 0) {
    notes.push(`${reviewCount} review finding${reviewCount === 1 ? '' : 's'} should be resolved before comparing harness variants.`);
  }
  if (summary.taskCount < 5) {
    notes.push('Small sample: keep this as an audit view, not a statistical conclusion.');
  }
  return notes;
}

function sortTasks(rows: OutcomeLedgerTaskRow[]): OutcomeLedgerTaskRow[] {
  return rows.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function labelTask(task: Task, liveTaskIds: ReadonlySet<string> | undefined): string {
  if (liveTaskIds && !liveTaskIds.has(task.id)) return `Historical task ${shortId(task.id)}`;
  return task.name ?? summarizePrompt(task.prompt);
}

function shortId(value: string): string {
  return value.length > 8 ? value.slice(0, 8) : value;
}

function summarizePrompt(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '<untitled task>';
  return collapsed.length > 80 ? `${collapsed.slice(0, 77)}...` : collapsed;
}

function humanMetric(metric: string): string {
  if (metric === 'durationMs') return 'Duration';
  if (metric === 'knownCostUsd') return 'Cost';
  if (metric === 'interventionCount') return 'Intervention count';
  if (metric === 'totalTokens') return 'Token count';
  return metric;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] * (1 - (idx - lo)) + sortedAsc[hi] * (idx - lo);
}

function toMs(value: Date | string | undefined): number {
  if (!value) return Number.NaN;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function severityRank(severity: OutcomeLedgerFinding['severity']): number {
  if (severity === 'critical') return 3;
  if (severity === 'review') return 2;
  return 1;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled outcome ledger flag: ${String(value)}`);
}
