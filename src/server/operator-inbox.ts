/**
 * The operator's inbox (issue #3931): everything that waits on the operator,
 * across every project, oldest first.
 *
 * Before this, the things that wait on the operator were spread over the
 * dashboard (permission prompts and findings, shown only for the selected
 * project), Telegram (questions), `/api/asks` and the integration train's
 * state in `/api/health`. This module reads those same sources and adds no
 * detector of its own:
 *
 * 1. `permission`: a task stopped on a permission prompt. Same reader as the
 *    3-minute permission page (`collectPermissionPromptWaits`), so the tool
 *    and the command (secrets hidden) are the ones the page quotes. A
 *    snoozed prompt is still listed: the task cannot move until someone
 *    answers it.
 * 2. `question`: a pending `kookr ask` question.
 * 3. `flagged`: any other active finding, by the dashboard's own rule (not
 *    snoozed, not suppressed), or an unattended task blocked from an
 *    interactive tool (`operatorNeeded`).
 * 4. `review`: a task that raised `completion_ready` and that Kookr will not
 *    close by itself (it did not opt into auto-close), so a person has to.
 * 5. `train`: the integration train is halted, or its stall alert is out.
 *
 * A task appears at most once: permission, else review, else flagged. A
 * question is its own item even when its task also appears.
 *
 * `summary` fields are built only from fixed phrases and the tool name, so a
 * surface that must not show command text or secrets (Telegram) can print
 * them as they are.
 */

import type { AgentEvent } from '../core/agent-events.js';
import { classifyCompletionReadyClosePolicy } from '../core/completion/completion-ready-cleanup.js';
import { redactSecrets } from '../core/redact-secrets.js';
import type { Task } from '../core/task-read-model.js';
import { isTerminalStatus } from '../core/task-status.js';
import type { Anomaly, AnomalyType } from '../shared/contracts/anomalies.js';
import type { AskRecord } from '../shared/contracts/asks.js';
import {
  OPERATOR_INBOX_KINDS,
  type OperatorInbox,
  type OperatorInboxItem,
  type OperatorInboxItemKind,
} from '../shared/contracts/operator-inbox.js';
import { DASHBOARD_TASK_QUERY } from '../shared/dashboard-task-url.js';
import type { IntegrationTrainHealth } from './integration-train-monitor.js';
import { collectPermissionPromptWaits } from './permission-prompt-wait-alert.js';

/** Task fields the inbox reads. */
export type OperatorInboxTask = Pick<
  Task,
  'id' | 'name' | 'status' | 'cwd' | 'projectId' | 'sessions' | 'pendingSignal'
  | 'autoCloseOnSignal' | 'deliveryAuthorization' | 'operatorNeeded'
>;

/** Monitor reads the inbox uses; `Monitor` satisfies it. */
export interface OperatorInboxMonitorView {
  getCurrentAnomaly(agentId: string): Anomaly | null;
  getAgentEvents(agentId: string): AgentEvent[];
  /** The dashboard's view of one session: its finding and whether it is snoozed or suppressed. */
  getAgentState(agentId: string): { anomaly: Anomaly | null; snoozedUntil?: number; suppressed?: boolean } | undefined;
}

export interface OperatorInboxSources {
  /** Non-terminal tasks. */
  liveTasks: readonly OperatorInboxTask[];
  /** Lookup for a question's task when it is no longer live. */
  getTask?: (taskId: string) => OperatorInboxTask | undefined;
  monitor: OperatorInboxMonitorView;
  /** Every ask record; only pending ones are listed. */
  asks: readonly AskRecord[];
  train: IntegrationTrainHealth | null;
  now: number;
}

/** Plain words for each finding type. */
const FINDING_SUMMARY: Record<AnomalyType, string> = {
  needs_input: 'is waiting for your reply',
  permission_blocked: 'is waiting on a permission prompt',
  repeated_error: 'keeps hitting the same error',
  merge_conflict: 'hit a merge conflict',
  stale_agent: 'looks stuck',
  hook_disconnected: 'stopped reporting its activity',
  hook_missing: 'is not reporting its activity',
  hook_parse_degraded: 'reports activity Kookr cannot read',
  backend_unreachable: 'lost its terminal',
  api_error: 'hit a model API error',
  budget_exceeded: 'went over its cost budget',
};

/** Plain words for each halt reason (docs/reference/integration-train.md). */
const TRAIN_HALT_REASON: Record<string, string> = {
  'base-red': 'main itself fails the full suite',
  'main-unverified-red': 'main fails the full suite after commits that skipped the train',
  'verify-infra': 'the full suite could not run (checkout or install failed)',
  'culprit-is-merge': 'the failure comes from merging main into staging',
  'history-shape': 'staging is red and its history cannot be bisected',
  'revert-not-sufficient': 'reverting the suspected pull request did not make staging green',
  'multiple-failures': 'more than one change is failing',
  'revert-conflict': 'reverting the failing pull request conflicts with later commits',
  'reconcile-conflict': 'main and staging conflict',
  'push-rejected': 'pushes to main or staging keep being rejected',
  'train-error': 'something failed inside the train itself',
};

const HOW_TO_ANSWER: Record<Exclude<OperatorInboxItemKind, 'train'>, string> = {
  permission: 'approve or deny it in the dashboard, or with the Telegram permission card',
  question: 'answer it on Telegram, or in Lucy\'s panel in the dashboard',
  flagged: 'open the task in the dashboard, or reply with kookr reply',
  review: 'check its result, then press Complete in the dashboard',
};

const KIND_ORDER = new Map(OPERATOR_INBOX_KINDS.map((kind, index) => [kind, index]));

function taskLink(taskId: string): string {
  return `/?${DASHBOARD_TASK_QUERY}=${encodeURIComponent(taskId)}`;
}

function projectOf(task: Pick<OperatorInboxTask, 'projectId' | 'cwd'>): string | undefined {
  if (task.projectId) return task.projectId;
  const base = task.cwd?.replace(/\/+$/, '').split('/').pop();
  return base || undefined;
}

function taskFields(task: OperatorInboxTask): Pick<OperatorInboxItem, 'taskId' | 'taskName' | 'project' | 'cwd' | 'link'> {
  const project = projectOf(task);
  return {
    taskId: task.id,
    ...(task.name ? { taskName: redactSecrets(task.name) } : {}),
    ...(project ? { project } : {}),
    ...(task.cwd ? { cwd: task.cwd } : {}),
    link: taskLink(task.id),
  };
}

function isoOrEmpty(value: Date | string | number | undefined): string {
  if (value === undefined) return '';
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function lastSessionId(task: OperatorInboxTask): string | undefined {
  return task.sessions[task.sessions.length - 1]?.tmuxSession;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function totalsLine(items: readonly OperatorInboxItem[], totals: Record<OperatorInboxItemKind, number>): string {
  const parts: string[] = [];
  if (totals.permission) parts.push(plural(totals.permission, 'permission prompt', 'permission prompts'));
  if (totals.question) parts.push(plural(totals.question, 'question', 'questions'));
  if (totals.flagged) parts.push(plural(totals.flagged, 'flagged task', 'flagged tasks'));
  if (totals.review) parts.push(plural(totals.review, 'review', 'reviews'));
  const train = items.find((item) => item.kind === 'train');
  if (train) parts.push(train.trainState === 'stalled' ? 'train stalled' : 'train halted');
  return `${items.length} waiting: ${parts.join(', ')}`;
}

function emptyLine(working: { tasks: number; projects: number }): string {
  if (working.tasks === 0) return 'Nothing is waiting on you. No tasks are working.';
  const verb = working.tasks === 1 ? 'is' : 'are';
  return `Nothing is waiting on you. ${plural(working.tasks, 'task', 'tasks')} ${verb} working in ${plural(working.projects, 'project', 'projects')}.`;
}

function trainItem(train: IntegrationTrainHealth | null): OperatorInboxItem | null {
  if (!train) return null;
  if (train.halted) {
    const reason = TRAIN_HALT_REASON[train.halted.reason] ?? `it stopped (${train.halted.reason})`;
    return {
      kind: 'train',
      summary: `The integration train is halted: ${reason}.`,
      since: isoOrEmpty(train.halted.at),
      howToAnswer: 'fix the cause, then run pnpm train:resume (see "Resuming a halt" in docs/reference/integration-train.md)',
      trainState: train.halted.reason,
    };
  }
  if (train.alerting) {
    return {
      kind: 'train',
      summary: `The integration train is stalled: ${train.integrationBranch} has changes waiting and the train is not running.`,
      since: isoOrEmpty(train.pendingSince ?? undefined),
      howToAnswer: 'check pnpm train:status in the production checkout, and start the train if it is stopped',
      trainState: 'stalled',
    };
  }
  return null;
}

/** Build the inbox from already-read sources. Pure: no I/O, no clock of its own. */
export function buildOperatorInbox(sources: OperatorInboxSources): OperatorInbox {
  const items: OperatorInboxItem[] = [];
  const listedTaskIds = new Set<string>();
  const liveById = new Map(sources.liveTasks.map((task) => [task.id, task]));

  for (const wait of collectPermissionPromptWaits(sources.liveTasks, sources.monitor)) {
    const task = liveById.get(wait.taskId);
    if (!task) continue;
    listedTaskIds.add(task.id);
    items.push({
      kind: 'permission',
      summary: `wants permission to use ${wait.toolName}`,
      since: isoOrEmpty(wait.sinceMs),
      howToAnswer: HOW_TO_ANSWER.permission,
      ...taskFields(task),
      toolName: wait.toolName,
      ...(wait.command ? { command: wait.command } : {}),
    });
  }

  let workingTasks = 0;
  const workingProjects = new Set<string>();
  for (const task of sources.liveTasks) {
    if (task.status === 'inProgress') {
      workingTasks += 1;
      workingProjects.add(projectOf(task) ?? '');
    }
    if (listedTaskIds.has(task.id) || task.status === 'pending' || isTerminalStatus(task.status)) continue;

    const signal = task.pendingSignal;
    if (
      task.status === 'inProgress'
      && signal?.kind === 'completion_ready'
      && !classifyCompletionReadyClosePolicy(task).canAutoClose
    ) {
      listedTaskIds.add(task.id);
      items.push({
        kind: 'review',
        summary: 'says it is finished and wants your review',
        since: isoOrEmpty(signal.raisedAt),
        howToAnswer: HOW_TO_ANSWER.review,
        ...taskFields(task),
      });
      continue;
    }

    const sessionId = lastSessionId(task);
    const state = sessionId ? sources.monitor.getAgentState(sessionId) : undefined;
    const anomaly = state?.anomaly ?? null;
    if (anomaly && !state?.snoozedUntil && !state?.suppressed) {
      listedTaskIds.add(task.id);
      items.push({
        kind: 'flagged',
        summary: anomaly.type === 'needs_input' && anomaly.subType === 'ask_user_question'
          ? 'asked you a question in its session'
          : anomaly.type === 'needs_input' && anomaly.subType === 'stop'
            ? 'finished its turn and is waiting for you'
            : FINDING_SUMMARY[anomaly.type] ?? 'needs you',
        since: isoOrEmpty(anomaly.detectedAt),
        howToAnswer: HOW_TO_ANSWER.flagged,
        ...taskFields(task),
        findingType: anomaly.type,
      });
      continue;
    }

    if (task.operatorNeeded) {
      listedTaskIds.add(task.id);
      items.push({
        kind: 'flagged',
        summary: `was stopped from using ${task.operatorNeeded.toolName}, which unattended tasks may not use`,
        since: isoOrEmpty(task.operatorNeeded.detectedAt),
        howToAnswer: HOW_TO_ANSWER.flagged,
        ...taskFields(task),
        findingType: 'operator_needed',
      });
    }
  }

  for (const ask of sources.asks) {
    if (ask.state !== 'pending') continue;
    // Kookr's own question (issue #4215) has the synthetic task id `system:<component>`: no task
    // exists, so the item names Kookr and has no task id or task link (issue #4295).
    const task = ask.system !== undefined ? undefined : liveById.get(ask.taskId) ?? sources.getTask?.(ask.taskId);
    items.push({
      kind: 'question',
      summary: 'asks you a question',
      since: isoOrEmpty(ask.createdAt),
      howToAnswer: HOW_TO_ANSWER.question,
      ...(ask.system !== undefined
        ? { taskName: 'Kookr' }
        : task ? taskFields(task) : { taskId: ask.taskId, link: taskLink(ask.taskId) }),
      askId: ask.id,
      question: redactSecrets(ask.question),
      options: ask.options.map((option) => redactSecrets(option)),
    });
  }

  const train = trainItem(sources.train);
  if (train) items.push(train);

  // Oldest first. A missing or unreadable time sorts as "now" (newest), then
  // by kind and id so the order is stable.
  const nowIso = new Date(sources.now).toISOString();
  for (const item of items) {
    if (!item.since) item.since = nowIso;
  }
  items.sort((a, b) => Date.parse(a.since) - Date.parse(b.since)
    || (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0)
    || (a.taskId ?? a.askId ?? '').localeCompare(b.taskId ?? b.askId ?? ''));

  const totals = Object.fromEntries(OPERATOR_INBOX_KINDS.map((kind) => [kind, 0])) as Record<OperatorInboxItemKind, number>;
  for (const item of items) totals[item.kind] += 1;
  const working = { tasks: workingTasks, projects: workingProjects.size };

  return {
    schema: 'kookr.operator-inbox.v1',
    generatedAt: nowIso,
    summary: items.length === 0 ? emptyLine(working) : totalsLine(items, totals),
    totals,
    items,
    working,
  };
}

/** Live readers for {@link readOperatorInbox}; the server passes its task store, monitor, ask service and train monitor. */
export interface OperatorInboxDeps {
  taskStore: {
    viewLiveTasks(): readonly OperatorInboxTask[];
    getTask(taskId: string): OperatorInboxTask | undefined;
  };
  monitor: OperatorInboxMonitorView;
  /** Undefined when Telegram is not configured (no questions can exist). */
  asks?: { all(): AskRecord[] };
  /** Undefined when the train monitor is off. */
  train?: { getHealthSnapshot(): IntegrationTrainHealth | null };
  now?: () => number;
}

/** Read the sources now and build the inbox. Never throws on a failing train read. */
export function readOperatorInbox(deps: OperatorInboxDeps): OperatorInbox {
  let train: IntegrationTrainHealth | null = null;
  try { train = deps.train?.getHealthSnapshot() ?? null; } catch { /* listed as not halted */ }
  return buildOperatorInbox({
    liveTasks: deps.taskStore.viewLiveTasks(),
    getTask: (taskId) => deps.taskStore.getTask(taskId),
    monitor: deps.monitor,
    asks: deps.asks?.all() ?? [],
    train,
    now: deps.now?.() ?? Date.now(),
  });
}
