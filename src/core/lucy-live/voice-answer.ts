/**
 * Answering a task's question (`kookr ask`) by voice, with a read-back.
 *
 * A spoken answer is riskier than a button press: the speech recogniser mishears short words and the
 * answer is typed into the task at once. So the flow is two turns: the operator's words are mapped to
 * one listed choice (by a separate, non-streaming model call that only returns numbers), Lucy reads
 * the choice back, and only a clear "yes" in the next turn sends it.
 *
 * This module holds the pure parts: the prompt for the mapping call, the strict check of its reply,
 * and the sentences Lucy says. The model's text is never spoken; every sentence below is built here
 * from the ask's own words.
 */

import { classifyReply } from '../lucy-operator/launch-proposal.js';
import { redactSpeechSecrets } from '../task-speech-summary.js';
import type { OperatorAskView } from '../../shared/contracts/asks.js';

export { classifyReply };

/** A question still waiting for the operator, as the voice flow needs it. */
export interface VoiceAskChoice {
  askId: string;
  taskName?: string;
  question: string;
  options: readonly string[];
}

/** What the mapping call decided. Indices only: never text. */
export type AnswerMatch =
  | { kind: 'none' }
  | { kind: 'unclear' }
  | { kind: 'choice'; askId: string; optionIndex: number };

/** How long a read-back stays confirmable after Lucy has finished saying it. */
export const VOICE_ANSWER_CONFIRM_WINDOW_MS = 20_000;

const MAX_QUESTION_CHARS = 200;
const MAX_OPTION_CHARS = 80;

function clip(text: string, max: number): string {
  const flat = redactSpeechSecrets(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The system and user messages for the mapping call. The numbering is the only thing the model may answer with. */
export function buildAnswerMatchPrompt(transcript: string, asks: readonly VoiceAskChoice[]): { system: string; user: string } {
  const system = [
    'You map what an operator said out loud to ONE of the listed choices of a waiting question, or to none.',
    'The words come from speech recognition and may be slightly wrong, but never pick a choice the words do not clearly point at.',
    'Reply with JSON only: {"ask": <number or null>, "choice": <number or null>, "unclear": <true or false>}.',
    '- "ask" and "choice" are the numbers shown below. Use null for both when the operator is not answering any listed question (a question about status, small talk, or an answer that is not one of the listed choices).',
    '- When the words fit a choice of more than one question and nothing tells which question is meant, set "unclear" to true and both numbers to null.',
    '- Do not guess. A wrong choice is sent to a running task and cannot be taken back.',
  ].join('\n');
  const lines = asks.map((ask, i) => {
    const who = ask.taskName ? ` (task "${clip(ask.taskName, 60)}")` : '';
    const choices = ask.options.map((o, j) => `    ${j + 1}. ${clip(o, MAX_OPTION_CHARS)}`).join('\n');
    return `Question ${i + 1}${who}: ${clip(ask.question, MAX_QUESTION_CHARS)}\n  Choices:\n${choices}`;
  });
  const user = `${lines.join('\n')}\n\nThe operator said: "${clip(transcript, 300)}"`;
  return { system, user };
}

/**
 * Turn the mapping call's raw reply into an {@link AnswerMatch}. Anything that is not exactly a valid
 * pick (bad JSON, a number out of range, a choice without a question) is `none`: the safe outcome.
 */
export function parseAnswerMatch(raw: string | null | undefined, asks: readonly VoiceAskChoice[]): AnswerMatch {
  if (!raw) return { kind: 'none' };
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return { kind: 'none' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { kind: 'none' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'none' };
  const { ask, choice, unclear } = parsed as Record<string, unknown>;
  if (unclear === true && asks.length > 1) return { kind: 'unclear' };
  if (!Number.isInteger(ask) || !Number.isInteger(choice)) return { kind: 'none' };
  const chosenAsk = asks[(ask as number) - 1];
  if (!chosenAsk) return { kind: 'none' };
  const optionIndex = (choice as number) - 1;
  if (optionIndex < 0 || optionIndex >= chosenAsk.options.length) return { kind: 'none' };
  return { kind: 'choice', askId: chosenAsk.askId, optionIndex };
}

/** The read-back. With several questions waiting it names the task so the operator can tell which one it is. */
export function buildAnswerReadBack(ask: VoiceAskChoice, optionIndex: number, waiting: number): string {
  const label = clip(ask.options[optionIndex] ?? '', MAX_OPTION_CHARS);
  const where = waiting > 1 && ask.taskName ? ` for ${clip(ask.taskName, 60)}` : '';
  return `You want: ${label}${where}. Shall I send that?`;
}

export function buildWhichQuestion(asks: readonly VoiceAskChoice[]): string {
  const names = asks.map((a) => a.taskName).filter((n): n is string => !!n).slice(0, 3).map((n) => clip(n, 40));
  const from = names.length > 0 ? ` They are from ${names.join(', ')}.` : '';
  return `${asks.length} questions are waiting.${from} Which one do you mean?`;
}

export const ANSWER_NOT_SENT = 'Okay, I did not send it.';
export const ANSWER_TIMED_OUT = 'That timed out, so I did not send it. Tell me the answer again if you still want it.';
export const ANSWER_HEARD_OVER_HER = 'I may have heard myself, so I did not send it. Say the answer again if you want it.';
export const ANSWER_NO_LONGER_WAITING = 'That question is not waiting any more, so I did not send anything.';

/** What she says after trying to send the answer. `reason` is the ask service's refusal, when there is one. */
export function sayAnswerOutcome(result: { ok: true } | { ok: false; reason?: string }, label: string): string {
  if (result.ok) return `Sent: ${clip(label, MAX_OPTION_CHARS)}.`;
  switch (result.reason) {
    case 'already_answered': return 'That question was already answered, so I did not send anything.';
    case 'expired': return 'That question expired, so I did not send anything.';
    case 'cancelled':
    case 'not_found': return ANSWER_NO_LONGER_WAITING;
    case 'task_gone': return 'The task is no longer running, so I did not send anything.';
    default: return 'I could not send that answer. You can press the choice in my panel or answer on Telegram.';
  }
}

/** The waiting questions that have listed choices: closed ones and free-text-only ones are never offered for a spoken answer. */
export function pendingVoiceAsks(asks: readonly OperatorAskView[]): VoiceAskChoice[] {
  return asks
    .filter((a) => a.state === 'pending' && a.options.length > 0)
    .map((a) => ({ askId: a.id, ...(a.taskName ? { taskName: a.taskName } : {}), question: a.question, options: a.options }));
}
