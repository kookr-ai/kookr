/**
 * Builds the plain-text task status that Lucy reads before answering a question.
 *
 * The helper model knows nothing about the operator's work, so each turn it gets a fresh
 * snapshot: how many tasks are in each state, what the unfinished ones are called and how
 * long since they changed, and the latest few that ended. Task names go through the same
 * redaction and "is it short enough to say aloud" rules as the spoken summaries, so a
 * pasted secret or a 200-character request never reaches the model or the speaker.
 *
 * Questions that tasks asked the operator (`kookr ask`) come first: the ones still
 * waiting, then the ones just closed with where the answer came from. They are listed
 * before the tasks because the briefing is cut from the end when it is too long, and
 * a task waiting on the operator matters more than the tail of the task list.
 */

import type { OperatorAskView } from '../../shared/contracts/asks.js';
import type { TaskStatus } from '../../shared/contracts/task-status.js';
import { isTerminalStatus } from '../../shared/contracts/task-status.js';
import { isGenericTaskName, spokenTaskName } from '../spoken-task-name.js';
import { redactSpeechSecrets, redactedTaskName } from '../task-speech-summary.js';

/** The few task fields the briefing reads; the full `Task` satisfies this. */
export interface BriefingTask {
  name?: string;
  status: TaskStatus;
  updatedAt: Date | string | number;
  finishedAt?: Date | string | number;
  terminatedAt?: Date | string | number;
  terminationReason?: string;
}

export const MAX_BRIEFING_CHARS = 2500;
export const MAX_LISTED_ACTIVE_TASKS = 15;
export const MAX_LISTED_RECENT_ENDED = 6;
/** The questions' share of the briefing, so long questions cannot push the task counts and list out of it. */
const MAX_ASK_BRIEFING_CHARS = 1100;
const MAX_LISTED_ASKS = 4;
/** A question longer than this is cut in the briefing; the full text is on the card and on Telegram. */
const MAX_BRIEFING_QUESTION_CHARS = 220;

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

function askWho(ask: OperatorAskView): string {
  return ask.taskName ? `The task "${ask.taskName}"` : 'A task';
}

function askOutcome(ask: OperatorAskView, nowMs: number): string {
  const when = minutesAgo(ask.resolvedAt ?? ask.expiresAt, nowMs);
  if (ask.state === 'answered' && ask.answer) {
    const chosen = ask.answer.kind === 'option' ? ask.answer.label : ask.answer.text;
    const where = ask.answeredVia === 'dashboard' ? 'in Kookr' : 'on Telegram';
    return `the operator answered "${oneLine(chosen, 80)}" ${where} ${when}`;
  }
  if (ask.state === 'expired') return `it expired with no answer ${when}`;
  if (ask.resolution === 'task_gone') return `the task ended before an answer was given ${when}`;
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
    lines.push('Questions from tasks waiting for the operator (answered with the buttons in your panel or on Telegram, not by voice):');
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
  return [capLines(lines, MAX_ASK_BRIEFING_CHARS), ''];
}

export function buildLucyLiveBriefing(tasks: readonly BriefingTask[], nowMs: number, asks: readonly OperatorAskView[] = []): string {
  const askLines = buildAskBriefingLines(asks, nowMs);
  if (tasks.length === 0) return capLines([...askLines, 'There are no tasks at all.'], MAX_BRIEFING_CHARS);

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

  const lines: string[] = [...askLines, `Task counts: ${countsLine}.`];

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

/** Join lines, dropping whole trailing lines rather than cutting one in half. */
function capLines(lines: readonly string[], max: number): string {
  const kept: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > max) {
      kept.push('(list cut short)');
      break;
    }
    kept.push(line);
    length += line.length + 1;
  }
  return kept.join('\n');
}
