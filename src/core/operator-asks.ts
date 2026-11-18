/**
 * How a `kookr ask` question is shown and spoken in the dashboard, where Lucy
 * (the avatar panel) asks the operator the same question Telegram carries.
 *
 * Two pure helpers, no I/O:
 *  - {@link listOperatorAsks} picks what the dashboard shows: every question
 *    still waiting, plus the ones closed in the last few minutes so the operator
 *    can see "answered on Telegram" instead of a card that silently vanished.
 *  - {@link buildAskSpeech} writes what Lucy says out loud: who is asking, the
 *    question (cut when it is long) and that the choices are on her card. The
 *    choices and the longer background (`context`) are left to the card: read
 *    aloud they made clips of 16 to 45 seconds, and the background often holds
 *    paths, ids and numbers that read badly.
 */

import {
  OPERATOR_ASK_MAX_LISTED,
  OPERATOR_ASK_RESOLVED_VISIBLE_MS,
  type AskRecord,
  type OperatorAskView,
} from '../shared/contracts/asks.js';
import { isTerminalStatus, type TaskStatus } from '../shared/contracts/task-status.js';
import { makeSpeakable } from './speakable-text.js';
import { isGenericTaskName, spokenTaskName } from './spoken-task-name.js';
import { redactSpeechSecrets, redactedTaskName } from './task-speech-summary.js';

/** Looks up a task's title; undefined when the task is unknown or untitled. */
export type TaskNameLookup = (taskId: string) => string | undefined;

/** Looks up a task's status; undefined when the task no longer exists. */
export type TaskStatusLookup = (taskId: string) => TaskStatus | undefined;

/** The task title as Lucy may show and say it: redacted, and absent when it is too long or unreadable. */
export function askTaskName(rawName: string | undefined): string | undefined {
  const spoken = spokenTaskName(redactedTaskName(rawName));
  return isGenericTaskName(spoken) ? undefined : spoken;
}

export function toOperatorAskView(ask: AskRecord, taskName: TaskNameLookup, taskStatus: TaskStatusLookup): OperatorAskView {
  const name = ask.system !== undefined ? undefined : askTaskName(taskName(ask.taskId));
  // A task that is gone counts as ended: nothing can be waiting on its answer. Kookr's own
  // questions have no task, and Kookr is always waiting on them.
  const status = ask.system !== undefined ? undefined : taskStatus(ask.taskId);
  const taskEnded = ask.system === undefined && (status === undefined || isTerminalStatus(status));
  // A closed ask always carries the time it closed, worked out here once, so the browser and Lucy's
  // briefing never have to guess it from other fields.
  const resolvedAt = ask.state === 'pending' ? undefined : closedAt(ask);
  return {
    id: ask.id,
    taskId: ask.taskId,
    ...(name !== undefined ? { taskName: name } : {}),
    ...(ask.system !== undefined ? { system: ask.system } : {}),
    taskEnded,
    question: ask.question,
    ...(ask.context !== undefined ? { context: ask.context } : {}),
    options: [...ask.options],
    ...(ask.links !== undefined && ask.links.length > 0 ? { links: ask.links.map((l) => ({ ...l })) } : {}),
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
export function listOperatorAsks(
  asks: readonly AskRecord[],
  nowMs: number,
  taskName: TaskNameLookup,
  taskStatus: TaskStatusLookup,
): OperatorAskView[] {
  const asked = asks.filter((ask) => ask.delivery !== undefined && ask.resolution !== 'delivery_failed');
  const newestFirst = (a: AskRecord, b: AskRecord): number => b.createdAt - a.createdAt;
  const pending = asked.filter((ask) => ask.state === 'pending').sort(newestFirst);
  const closed = asked
    .filter((ask) => ask.state !== 'pending' && nowMs - closedAt(ask) <= OPERATOR_ASK_RESOLVED_VISIBLE_MS)
    .sort((a, b) => closedAt(b) - closedAt(a))
    .slice(0, OPERATOR_ASK_MAX_LISTED);
  return [...pending, ...closed].sort(newestFirst).map((ask) => toOperatorAskView(ask, taskName, taskStatus));
}

function endSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** The longest spoken question, in words: about eight seconds of speech. */
export const MAX_ASK_SPEECH_WORDS = 25;
/** The most words of the question itself that are read out; the card has the whole text. */
export const MAX_ASK_SPEECH_QUESTION_WORDS = 18;

const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Where the choices are, never the choices themselves. `cut` when part of the question was left out. */
function whereToAnswer(optionCount: number, cut: boolean): string {
  if (optionCount <= 0) return cut ? 'The rest is on my card, where you can answer.' : 'You can answer on my card.';
  const count = COUNT_WORDS[optionCount] ?? String(optionCount);
  const choices = optionCount === 1 ? 'choice' : 'choices';
  if (cut) return `The rest and ${count.toLowerCase()} ${choices} are on my card.`;
  return `${count} ${choices} ${optionCount === 1 ? 'is' : 'are'} on my card.`;
}

/**
 * The start of `question` that fits in `maxWords`: whole sentences when at least one fits, otherwise
 * whole words followed by "…". Returns undefined when not even one word fits.
 */
function cutQuestion(question: string, maxWords: number): string | undefined {
  if (maxWords <= 0) return undefined;
  // A sentence ends at end punctuation followed by a space and then a capital, a digit or an opening
  // quote or bracket. A dot inside a token ("2.1", "api.example.com") or after an abbreviation that
  // the sentence continues from ("e.g. skip") is not an end.
  const sentences = question.split(/(?<=[.!?…])\s+(?=[\p{Lu}\p{N}"'“‘(\[])/u);
  const kept: string[] = [];
  let used = 0;
  for (const sentence of sentences) {
    const count = wordsOf(sentence).length;
    if (used + count > maxWords) break;
    kept.push(sentence.trim());
    used += count;
  }
  if (kept.length > 0) return kept.join(' ');
  const words = wordsOf(question).slice(0, maxWords);
  return `${words.join(' ').replace(/[\s,;:.!?…(\-]+$/u, '')}…`;
}

/**
 * What Lucy says for a pending question: one short sentence saying who asks and what about, then
 * where the choices are. The choices are never read out and a long question is cut (at the end of
 * a sentence when one fits, otherwise between two words), because the card shows all of it and a
 * clip of half a minute is not listened to. At most {@link MAX_ASK_SPEECH_WORDS} words, of which
 * at most {@link MAX_ASK_SPEECH_QUESTION_WORDS} are the question; a long task name leaves the
 * question fewer. Made speakable (no markdown, paths or ids read out letter by letter) and with
 * secrets redacted, before it is cut, so a cut never splits a secret into two harmless-looking halves.
 */
export function buildAskSpeech(
  ask: Pick<AskRecord, 'question' | 'options' | 'allowText' | 'system'>,
  taskName: string | undefined,
): string {
  // The speakable rewrite ends its text with a full stop; the colon that follows replaces it.
  const asker = ask.system !== undefined
    ? 'Kookr needs your input'
    : taskName ? `The task ${taskName} needs your input` : 'A task needs your input';
  const who = makeSpeakable(redactSpeechSecrets(asker))
    .replace(/[.!?…\s]+$/u, '');
  const question = makeSpeakable(redactSpeechSecrets(ask.question)).replace(/\s+/g, ' ').trim();
  const optionCount = ask.options.length;
  const room = (tail: string): number =>
    Math.min(MAX_ASK_SPEECH_QUESTION_WORDS, MAX_ASK_SPEECH_WORDS - wordsOf(who).length - wordsOf(tail).length);

  const whole = whereToAnswer(optionCount, false);
  if (!question) return `${who}. ${whole}`;
  if (wordsOf(question).length <= room(whole)) return `${who}: ${endSentence(question)} ${whole}`;
  const rest = whereToAnswer(optionCount, true);
  const start = cutQuestion(question, room(rest));
  return start ? `${who}: ${endSentence(start)} ${rest}` : `${who}. ${whole}`;
}
