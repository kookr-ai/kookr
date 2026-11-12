/**
 * How a `kookr ask` question is shown and spoken in the dashboard, where Lucy
 * (the avatar panel) asks the operator the same question Telegram carries.
 *
 * Two pure helpers, no I/O:
 *  - {@link listOperatorAsks} picks what the dashboard shows: every question
 *    still waiting, plus the ones closed in the last few minutes so the operator
 *    can see "answered on Telegram" instead of a card that silently vanished.
 *  - {@link buildAskSpeech} writes what Lucy says out loud: who is asking, the
 *    question and the choices. The longer background (`context`) is left to the
 *    card, because it often holds paths, ids and numbers that read badly aloud.
 */

import {
  OPERATOR_ASK_MAX_LISTED,
  OPERATOR_ASK_RESOLVED_VISIBLE_MS,
  type AskRecord,
  type OperatorAskView,
} from '../shared/contracts/asks.js';
import { makeSpeakable } from './speakable-text.js';
import { isGenericTaskName, spokenTaskName } from './spoken-task-name.js';
import { redactSpeechSecrets, redactedTaskName } from './task-speech-summary.js';

/** Looks up a task's title; undefined when the task is unknown or untitled. */
export type TaskNameLookup = (taskId: string) => string | undefined;

/** The task title as Lucy may show and say it: redacted, and absent when it is too long or unreadable. */
export function askTaskName(rawName: string | undefined): string | undefined {
  const spoken = spokenTaskName(redactedTaskName(rawName));
  return isGenericTaskName(spoken) ? undefined : spoken;
}

export function toOperatorAskView(ask: AskRecord, taskName: TaskNameLookup): OperatorAskView {
  const name = askTaskName(taskName(ask.taskId));
  // A closed ask always carries the time it closed, worked out here once, so the browser and Lucy's
  // briefing never have to guess it from other fields.
  const resolvedAt = ask.state === 'pending' ? undefined : closedAt(ask);
  return {
    id: ask.id,
    taskId: ask.taskId,
    ...(name !== undefined ? { taskName: name } : {}),
    question: ask.question,
    ...(ask.context !== undefined ? { context: ask.context } : {}),
    options: [...ask.options],
    allowText: ask.allowText,
    state: ask.state,
    createdAt: ask.createdAt,
    expiresAt: ask.expiresAt,
    ...(ask.answer !== undefined ? { answer: ask.answer } : {}),
    ...(ask.answeredVia !== undefined ? { answeredVia: ask.answeredVia } : {}),
    ...(resolvedAt !== undefined ? { resolvedAt } : {}),
    ...(ask.resolution !== undefined ? { resolution: ask.resolution } : {}),
    ...(ask.taskDelivery !== undefined ? { taskDelivery: ask.taskDelivery } : {}),
  };
}

/**
 * When a closed ask closed. Records written before `resolvedAt` existed carry less: an answered one
 * has `answeredAt`, an expired one closed at `expiresAt`, and for a cancelled one the time is not
 * recorded at all, so the earliest moment it could have been (`createdAt`) is used; that keeps an old
 * cancellation from being listed as "just closed" until its long-gone expiry.
 */
function closedAt(ask: AskRecord): number {
  if (ask.resolvedAt !== undefined) return ask.resolvedAt;
  if (ask.answeredAt !== undefined) return ask.answeredAt;
  return ask.state === 'expired' ? ask.expiresAt : ask.createdAt;
}

/**
 * The asks the dashboard shows, newest first. Every pending question is listed: a task is waiting on
 * it (and the rate limits keep their number small). Beside them, the questions closed within
 * {@link OPERATOR_ASK_RESOLVED_VISIBLE_MS}, at most {@link OPERATOR_ASK_MAX_LISTED} of them, most
 * recently closed first; they have their own allowance so that a question answered a moment ago
 * always shows its outcome, however many others are waiting.
 * A question whose Telegram message was never sent is left out on both counts: it was never asked.
 */
export function listOperatorAsks(asks: readonly AskRecord[], nowMs: number, taskName: TaskNameLookup): OperatorAskView[] {
  const asked = asks.filter((ask) => ask.delivery !== undefined && ask.resolution !== 'delivery_failed');
  const newestFirst = (a: AskRecord, b: AskRecord): number => b.createdAt - a.createdAt;
  const pending = asked.filter((ask) => ask.state === 'pending').sort(newestFirst);
  const closed = asked
    .filter((ask) => ask.state !== 'pending' && nowMs - closedAt(ask) <= OPERATOR_ASK_RESOLVED_VISIBLE_MS)
    .sort((a, b) => closedAt(b) - closedAt(a))
    .slice(0, OPERATOR_ASK_MAX_LISTED);
  return [...pending, ...closed].sort(newestFirst).map((ask) => toOperatorAskView(ask, taskName));
}

function endSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** "A, B or C" in spoken form. */
function spokenChoices(options: readonly string[]): string {
  if (options.length <= 1) return options.join('');
  if (options.length === 2) return `${options[0]} or ${options[1]}`;
  return `${options.slice(0, -1).join(', ')}, or ${options[options.length - 1]}`;
}

/**
 * What Lucy says for a pending question, already made speakable (no markdown,
 * paths or ids read out letter by letter) and with secrets redacted.
 */
export function buildAskSpeech(ask: Pick<AskRecord, 'question' | 'options' | 'allowText'>, taskName: string | undefined): string {
  const who = taskName ? `The task ${taskName} needs your input.` : 'A task needs your input.';
  const parts = [
    who,
    endSentence(ask.question),
    `You can answer: ${spokenChoices(ask.options)}.`,
  ];
  return makeSpeakable(redactSpeechSecrets(parts.join(' '))).trim();
}
