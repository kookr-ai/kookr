import { dirname, basename } from 'node:path';
import { compactToolSummary, summarizeActivity } from '../core/activity-summary.js';
import type { Monitor } from '../core/monitor.js';
import type { ReflectionReport } from '../core/friction-analyzer.js';
import { getReflectionRecommendation } from '../core/reflection-recommendation.js';
import type { Task, TaskStore } from '../core/tasks.js';

export interface ReflectionRecommendationResponse {
  sessionId: string | null;
  interactionLogPath: string | null;
  report: ReflectionReport;
  recommendation: ReturnType<typeof getReflectionRecommendation>;
}

export function inferSessionIdFromInteractionLogPath(logPath: string | null): string | null {
  if (!logPath) return null;
  const parent = dirname(logPath);
  const sessionId = basename(parent);
  return sessionId || null;
}

export function buildReflectionRecommendationResponse(
  logPath: string | null,
  report: ReflectionReport,
): ReflectionRecommendationResponse {
  return {
    sessionId: inferSessionIdFromInteractionLogPath(logPath),
    interactionLogPath: logPath,
    report,
    recommendation: getReflectionRecommendation(report),
  };
}

export function buildReflectionTaskPrompt(args: {
  interactionLogPath: string;
  report: ReflectionReport;
  taskStore: TaskStore;
  monitor: Monitor;
}): string {
  const { interactionLogPath, report, taskStore, monitor } = args;
  const sessionId = inferSessionIdFromInteractionLogPath(interactionLogPath) ?? 'unknown-session';
  const recommendation = getReflectionRecommendation(report);
  const taskSummaries = collectRelevantTaskSummaries(taskStore, monitor, report);
  const anomalyBreakdown = Object.entries(report.anomalyBreakdown)
    .map(([type, count]) => `  - ${type}: ${count}`)
    .join('\n') || '  - none recorded';
  const findings = report.findings
    .map((finding, index) => [
      `${index + 1}. ${finding.name} (${finding.category}, frequency ${finding.frequency})`,
      ...finding.evidence.slice(0, 3).map((evidence) => `   - ${evidence}`),
      `   Suggested fix: ${finding.suggestedFix}`,
    ].join('\n'))
    .join('\n\n') || 'None. Explain why the session stayed below threshold.';

  const taskSummaryBlock = taskSummaries.length > 0
    ? taskSummaries.map((summary) => `- ${summary}`).join('\n')
    : '- No task summaries were available; use the interaction log and current Kookr docs.';

  return [
    'Use the `session-reflect` skill.',
    'Analyze this Kookr supervision session and produce a concise reflection report.',
    '',
    'Session metadata',
    `- Session ID: ${sessionId}`,
    `- Interaction log: ${interactionLogPath}`,
    `- Time window: ${report.sessionStart || 'unknown'} -> ${report.sessionEnd || 'unknown'}`,
    `- Agents involved: ${report.agentCount}`,
    `- User interventions: ${report.totalInterventions}`,
    `- Recommendation trigger: ${recommendation.summary}`,
    '',
    'Anomaly breakdown',
    anomalyBreakdown,
    '',
    'Rule-based friction findings',
    findings,
    '',
    'Concise task/session summaries',
    taskSummaryBlock,
    '',
    'Deliverable',
    '- Briefly explain what happened in the session.',
    '- Identify the main friction patterns and root causes.',
    '- Recommend 3-5 concrete improvements, preferring skill updates over CLAUDE.md bloat when appropriate.',
    '- Keep the report actionable and ordered by impact.',
  ].join('\n');
}

function collectRelevantTaskSummaries(
  taskStore: TaskStore,
  monitor: Monitor,
  report: ReflectionReport,
): string[] {
  const startMs = safeParseMs(report.sessionStart);
  const endMs = safeParseMs(report.sessionEnd);

  return taskStore.getAllTasks()
    .filter((task) => isTaskRelevant(task, startMs, endMs))
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
    .slice(-5)
    .map((task) => summarizeTask(task, monitor));
}

function isTaskRelevant(task: Task, sessionStartMs: number | null, sessionEndMs: number | null): boolean {
  if (sessionStartMs === null || sessionEndMs === null) return true;

  const createdAtMs = task.createdAt.getTime();
  const updatedAtMs = task.updatedAt.getTime();
  const paddingMs = 15 * 60_000;
  return updatedAtMs >= sessionStartMs - paddingMs && createdAtMs <= sessionEndMs + paddingMs;
}

function summarizeTask(task: Task, monitor: Monitor): string {
  const title = task.name ?? truncate(task.prompt, 72);
  const status = task.status;
  const digest = task.completionDigest;

  if (digest) {
    const bullets = digest.bullets.slice(0, 2).join(' | ');
    const files = digest.filesChanged.length > 0
      ? ` Files: ${digest.filesChanged.slice(0, 3).join(', ')}.`
      : '';
    return `"${title}" (${status}). ${bullets}${files}`.trim();
  }

  const latestSession = task.sessions[task.sessions.length - 1];
  if (!latestSession) {
    return `"${title}" (${status}). Prompt: ${truncate(task.prompt, 120)}`;
  }

  const events = monitor.getAgentEvents(latestSession.tmuxSession);
  if (events.length === 0) {
    return `"${title}" (${status}). Prompt: ${truncate(task.prompt, 120)}`;
  }

  const activity = summarizeActivity(events)
    .slice(0, 4)
    .map((item) => {
      switch (item.type) {
        case 'user_message':
          return `user: ${truncate(item.text, 72)}`;
        case 'agent_message':
          return `agent: ${truncate(item.text, 72)}`;
        case 'tool_group':
          return `activity: ${compactToolSummary(item) || 'tool activity'}`;
        case 'system_notice':
          return `system: ${item.text}`;
      }
    })
    .filter(Boolean)
    .join(' | ');

  return `"${title}" (${status}). ${activity || truncate(task.prompt, 120)}`;
}

function safeParseMs(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}...`;
}
