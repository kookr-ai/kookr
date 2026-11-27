/**
 * Builds the plain-text task status that Lucy reads before answering a question.
 *
 * The helper model knows nothing about the operator's work, so each turn it gets a fresh
 * snapshot: how many tasks are in each state, what the unfinished ones are called and how
 * long since they changed, and the latest few that ended. Task names go through the same
 * redaction and "is it short enough to say aloud" rules as the spoken summaries, so a
 * pasted secret or a 200-character request never reaches the model or the speaker.
 *
 * It starts with what waits on the operator (issue #3927): the tasks that need them and
 * why (a permission prompt and for which tool, a question, finished and wants review,
 * stalled) and for how long, then one line on the integration train when it is halted
 * or stalled. Questions that tasks asked the operator (`kookr ask`) follow: the ones
 * still waiting, then the ones just closed with where the answer came from. This order
 * matters because the briefing is cut from the end when it is too long: the
 * "Needs the operator" section is the last thing to go.
 *
 * This text is sent to a model provider. A permission prompt contributes only the name
 * of the tool it asks about, never the command, path or other text it shows.
 */

import type { OperatorAskView } from '../../shared/contracts/asks.js';
import type { TaskStatus } from '../../shared/contracts/task-status.js';
import { isTerminalStatus } from '../../shared/contracts/task-status.js';
import { isGenericTaskName, spokenTaskName } from '../spoken-task-name.js';
import { redactSpeechSecrets, redactedTaskName } from '../task-speech-summary.js';
import type { OperatorAttention, OperatorAttentionKind } from '../lucy-operator/attention.js';
import { cleanTaskText } from '../lucy-operator/task-text.js';

/** The few task fields the briefing reads; the full `Task` satisfies this. */
export interface BriefingTask {
  name?: string;
  status: TaskStatus;
  updatedAt: Date | string | number;
  finishedAt?: Date | string | number;
  terminatedAt?: Date | string | number;
  terminationReason?: string;
}

/** A task waiting on the operator, as the server maps it from the findings (`operatorNeeds`). */
export interface BriefingNeed {
  name?: string;
  /** Display name of the project the task works in. */
  project?: string;
  attention: OperatorAttention;
}

/**
 * The integration train's state, as `/api/health` reports it (`IntegrationTrainHealth`). Only
 * these fields are read; the train's last-cycle detail, which can quote test output, never is.
 */
export interface BriefingTrainHealth {
  running: boolean;
  halted: { reason: string; at: string } | null;
  /** Since when merged changes have waited to reach `main`; null when nothing waits. */
  pendingSince: string | null;
  /** True while the train monitor's "stalled" alert is out. */
  alerting: boolean;
}

/** What the status says beyond the task list. Absent means "not known here", and nothing is said. */
export interface BriefingExtras {
  /** The live tasks waiting on the operator. An empty list is stated as "none". */
  needs?: readonly BriefingNeed[];
  /** Null or absent when the train is not watched on this server. */
  train?: BriefingTrainHealth | null;
}

export const MAX_BRIEFING_CHARS = 2500;
export const MAX_LISTED_ACTIVE_TASKS = 15;
export const MAX_LISTED_RECENT_ENDED = 6;
/** The questions' share of the briefing, so long questions cannot push the task counts and list out of it. */
const MAX_ASK_BRIEFING_CHARS = 1100;
const MAX_LISTED_ASKS = 4;
/** A question longer than this is cut in the briefing; the full text is on the card and on Telegram. */
const MAX_BRIEFING_QUESTION_CHARS = 220;
/**
 * At most this many waiting tasks are listed. The section has no share of its own: its lines are
 * short (a spoken name, a 40-character project, Kookr's reason, a duration), it comes first, and
 * the overall cap cuts from the end, so it is the last part to give way.
 */
export const MAX_LISTED_NEEDS = 8;

/** Why a task waits, said of the operator in the third person. Only Kookr's own words: nothing an agent wrote. */
const NEED_WORDS: Record<OperatorAttentionKind, string> = {
  needs_input: 'it stopped and needs input',
  asked_question: 'it asked a question in its session',
  wants_review: 'it says it is finished and wants review',
  permission_blocked: 'waiting for permission to use a tool',
  repeated_error: 'it keeps hitting the same error',
  merge_conflict: 'it has a merge conflict',
  stale_agent: 'it has stalled and gone quiet',
  hook_disconnected: 'Kookr lost contact with it',
  hook_missing: 'Kookr cannot see what it is doing',
  hook_parse_degraded: 'Kookr can only partly see what it is doing',
  backend_unreachable: 'its terminal cannot be reached',
  api_error: 'it hit an error from its model provider',
  budget_exceeded: 'it went over its budget',
};

/** Why the train stopped, in plain words. The reason codes are the ones `scripts/lib/integration-train-core.ts` writes. */
const TRAIN_HALT_WORDS: Record<string, string> = {
  'base-red': 'main itself fails the full test suite',
  'main-unverified-red': 'main fails the full test suite',
  'verify-infra': 'the full test suite could not be run',
  'push-rejected': 'it could not push its result',
  'revert-conflict': 'it could not take back the change that broke the tests',
  'revert-not-sufficient': 'taking back the change that broke the tests did not fix them',
  'culprit-is-merge': 'the change that broke the tests is a merge it cannot take back',
  'multiple-failures': 'several changes broke the tests at once',
  'history-shape': 'the branch history is in a shape it cannot handle',
  'reconcile-conflict': 'it could not bring main into the staging branch',
  'train-error': 'it hit an internal error',
};

const STATUS_WORDS: Record<TaskStatus, string> = {
  open: 'open',
  pending: 'pending',
  inProgress: 'in progress',
  completed: 'completed',
  terminated: 'terminated',
  cancelled: 'cancelled',
};
const STATUS_ORDER: readonly TaskStatus[] = ['inProgress', 'open', 'pending', 'completed', 'terminated', 'cancelled'];

function toMs(value: Date | string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function minutesAgo(thenMs: number | undefined, nowMs: number): string {
  if (thenMs === undefined) return 'at an unknown time';
  const minutes = Math.max(0, Math.round((nowMs - thenMs) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 120) return `${minutes} minutes ago`;
  return `${Math.round(minutes / 60)} hours ago`;
}

/** Short name the model may repeat aloud. Long, cut-off or unpronounceable titles become a generic label. */
function shortName(name: string | undefined): string {
  const spoken = spokenTaskName(redactedTaskName(name));
  return isGenericTaskName(spoken) ? 'a task with no short name' : `"${spoken}"`;
}

function reasonSuffix(task: BriefingTask): string {
  return task.status === 'terminated' && task.terminationReason ? ` (reason: ${task.terminationReason})` : '';
}

function oneLine(text: string, max: number): string {
  const flat = redactSpeechSecrets(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** How long something has waited: "for 12 minutes". */
function forHowLong(sinceMs: number | undefined, nowMs: number): string {
  if (sinceMs === undefined) return 'for an unknown time';
  const minutes = Math.max(0, Math.round((nowMs - sinceMs) / 60_000));
  if (minutes < 1) return 'for less than a minute';
  if (minutes === 1) return 'for 1 minute';
  if (minutes < 120) return `for ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `for ${hours} hours` : `for ${Math.round(hours / 24)} days`;
}

function needWords(attention: OperatorAttention): string {
  if (attention.kind === 'permission_blocked' && attention.tool) return `waiting for permission to use ${attention.tool}`;
  return NEED_WORDS[attention.kind] ?? 'it needs the operator';
}

/** The "Needs the operator" lines, longest wait first; empty when the source is not wired. */
function buildNeedsBriefingLines(needs: readonly BriefingNeed[] | undefined, nowMs: number): string[] {
  if (needs === undefined) return [];
  if (needs.length === 0) return ['Needs the operator: no task is waiting on the operator.', ''];
  const sorted = [...needs].sort((a, b) => (a.attention.sinceMs ?? Infinity) - (b.attention.sinceMs ?? Infinity));
  const lines = [`Needs the operator: ${needs.length} ${needs.length === 1 ? 'task is' : 'tasks are'} waiting on the operator (longest first; the operator answers in the dashboard, you cannot):`];
  for (const need of sorted.slice(0, MAX_LISTED_NEEDS)) {
    const project = need.project ? oneLine(cleanTaskText(need.project), 40) : '';
    const where = project ? ` in project ${project}` : '';
    lines.push(`- ${shortName(need.name === undefined ? undefined : cleanTaskText(need.name))}${where}: ${needWords(need.attention)}, ${forHowLong(need.attention.sinceMs, nowMs)}`);
  }
  if (needs.length > MAX_LISTED_NEEDS) lines.push(`- and ${needs.length - MAX_LISTED_NEEDS} more not listed`);
  return [...lines, ''];
}

/** One line on the integration train: what is wrong when it is halted or stalled, and a short all-clear otherwise. */
function buildTrainBriefingLines(train: BriefingTrainHealth | null | undefined, nowMs: number): string[] {
  if (!train) return [];
  if (train.halted) {
    const why = TRAIN_HALT_WORDS[train.halted.reason] ?? 'of a problem it reported';
    return [`Integration train: halted ${forHowLong(toMs(train.halted.at || undefined), nowMs)} because ${why}; merged changes do not reach main until someone fixes it.`, ''];
  }
  const waiting = train.pendingSince ? forHowLong(toMs(train.pendingSince), nowMs) : undefined;
  // `running` is read fresh; `alerting` is the monitor's flag from its last check, minutes old at worst.
  // A train that is running again is said to run, even while that flag has not cleared yet.
  if (!train.running && (train.alerting || waiting)) {
    return [`Integration train: ${train.alerting ? 'stalled, ' : ''}not running; merged changes have waited ${waiting ?? 'for an unknown time'} to reach main.`, ''];
  }
  return [train.running ? 'Integration train: running, no problem reported.' : 'Integration train: not running, and no merged change is waiting for it.', ''];
}

function askWho(ask: OperatorAskView): string {
  if (ask.system !== undefined) return 'Kookr';
  return ask.taskName ? `The task "${ask.taskName}"` : 'A task';
}

function askOutcome(ask: OperatorAskView, nowMs: number): string {
  const when = minutesAgo(ask.resolvedAt ?? ask.expiresAt, nowMs);
  if (ask.state === 'answered' && ask.answer) {
    const chosen = ask.answer.kind === 'option' ? ask.answer.label : ask.answer.text;
    const where = ask.answeredVia === 'dashboard' ? 'in Kookr' : 'on Telegram';
    return `the operator answered "${oneLine(chosen, 80)}" ${where} ${when}`;
  }
  if (ask.state === 'expired') return `it expired with no answer ${when}${ask.expiryOutcome ? `; ${oneLine(ask.expiryOutcome, 200)}` : ''}`;
  if (ask.resolution === 'task_gone') return `the session that asked ended before an answer was given ${when}`;
  return `the task withdrew it ${when}`;
}

/** The lines about questions from tasks; empty when there is nothing to say. */
function buildAskBriefingLines(asks: readonly OperatorAskView[], nowMs: number): string[] {
  const pending = asks.filter((a) => a.state === 'pending');
  const closed = asks.filter((a) => a.state !== 'pending');
  if (pending.length === 0 && closed.length === 0) return [];
  const lines: string[] = [];
  if (pending.length === 0) {
    lines.push('Questions from tasks waiting for the operator: none.');
  } else {
    // The count is in the first line, which the cap below never drops, so she knows how many wait even when not all fit.
    lines.push(`Questions from tasks waiting for the operator: ${pending.length} (answered by saying one of the listed choices, which she reads back before sending, or with the buttons in your panel or on Telegram):`);
    for (const ask of pending.slice(0, MAX_LISTED_ASKS)) {
      lines.push(`- ${askWho(ask)} asked ${minutesAgo(ask.createdAt, nowMs)}: ${oneLine(ask.question, MAX_BRIEFING_QUESTION_CHARS)} Choices: ${ask.options.map((o) => oneLine(o, 60)).join('; ')}.`);
    }
    if (pending.length > MAX_LISTED_ASKS) lines.push(`- and ${pending.length - MAX_LISTED_ASKS} more questions not listed`);
  }
  if (closed.length > 0) {
    lines.push('Questions closed in the last few minutes:');
    for (const ask of closed.slice(0, MAX_LISTED_ASKS)) {
      lines.push(`- ${askWho(ask)} asked: ${oneLine(ask.question, MAX_BRIEFING_QUESTION_CHARS)} Outcome: ${askOutcome(ask, nowMs)}.`);
    }
  }
  // Back into separate lines, so the overall cap drops the questions from the end rather than all at once.
  return [...capLines(lines, MAX_ASK_BRIEFING_CHARS).split('\n'), ''];
}

export function buildLucyLiveBriefing(
  tasks: readonly BriefingTask[],
  nowMs: number,
  asks: readonly OperatorAskView[] = [],
  extras: BriefingExtras = {},
): string {
  const headLines = [
    ...buildNeedsBriefingLines(extras.needs, nowMs),
    ...buildTrainBriefingLines(extras.train, nowMs),
    ...buildAskBriefingLines(asks, nowMs),
  ];
  if (tasks.length === 0) return capLines([...headLines, 'There are no tasks at all.'], MAX_BRIEFING_CHARS);

  const counts = new Map<TaskStatus, number>();
  for (const t of tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const countsLine = STATUS_ORDER
    .filter((s) => (counts.get(s) ?? 0) > 0)
    .map((s) => `${counts.get(s)} ${STATUS_WORDS[s]}`)
    .join(', ');

  const active = tasks
    .filter((t) => !isTerminalStatus(t.status))
    .sort((a, b) => (toMs(b.updatedAt) ?? 0) - (toMs(a.updatedAt) ?? 0));
  const ended = tasks
    .filter((t) => isTerminalStatus(t.status))
    .map((t) => ({ task: t, at: toMs(t.finishedAt) ?? toMs(t.terminatedAt) ?? toMs(t.updatedAt) }))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, MAX_LISTED_RECENT_ENDED);

  const lines: string[] = [...headLines, `Task counts: ${countsLine}.`];

  lines.push('', active.length === 0 ? 'Unfinished tasks: none.' : 'Unfinished tasks (most recently changed first):');
  for (const t of active.slice(0, MAX_LISTED_ACTIVE_TASKS)) {
    lines.push(`- ${shortName(t.name)}: ${STATUS_WORDS[t.status]}, last updated ${minutesAgo(toMs(t.updatedAt), nowMs)}`);
  }
  if (active.length > MAX_LISTED_ACTIVE_TASKS) {
    lines.push(`- and ${active.length - MAX_LISTED_ACTIVE_TASKS} more not listed`);
  }

  if (ended.length > 0) {
    lines.push('', 'Most recently ended tasks (newest first):');
    for (const { task, at } of ended) {
      lines.push(`- ${shortName(task.name)}: ${STATUS_WORDS[task.status]}${reasonSuffix(task)} ${minutesAgo(at, nowMs)}`);
    }
  }

  return capLines(lines, MAX_BRIEFING_CHARS);
}

const CUT_LINE = '(list cut short)';

/** Join lines, dropping whole trailing lines rather than cutting one in half. The result, cut line included, fits in `max`. */
export function capLines(lines: readonly string[], max: number): string {
  const joined = lines.join('\n');
  if (joined.length <= max) return joined;
  const kept: string[] = [];
  let length = CUT_LINE.length;
  for (const line of lines) {
    if (length + line.length + 1 > max) break;
    kept.push(line);
    length += line.length + 1;
  }
  kept.push(CUT_LINE);
  return kept.join('\n');
}
