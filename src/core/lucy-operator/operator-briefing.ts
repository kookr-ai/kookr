/**
 * The briefing Lucy writes to the operator when they open her panel or come back to the dashboard:
 * a few sentences, addressed to them, saying what is waiting on them.
 *
 * It is built from Kookr's own records with fixed sentence patterns. No model is called, so it costs
 * nothing, cannot be shaped by what an agent wrote, and is ready the moment the panel opens. (The
 * board and the hands-free status, `board.ts` and `lucy-live/briefing.ts`, describe the same tasks,
 * but in the third person and with task codes, for a model to read.)
 *
 * The order is the order in which the operator should care:
 *  1. what is stopped until they act: questions, permission prompts, tasks that need input, tasks
 *     that stalled or lost contact, tasks that say they are finished and want a review;
 *  2. questions left by tasks that have already ended (an opinion is wanted, nothing waits on it);
 *  3. how many tasks are working.
 * When nothing needs them she writes nothing: the text is empty, and the panel adds no entry.
 *
 * Every sentence names its task when it can: a question reads "<task> is stopped on a question, 117
 * minutes left." (the one that closes soonest is named, the others counted), and a question Kookr asks
 * itself reads "Kookr is waiting for your answer about the interrupted tasks." A task is named only
 * when its title may be said aloud (no path, id or secret: the rules of `spokenLabel`), cut to its
 * first words when it is only too long ({@link sayableTaskName}); otherwise it is counted. Ids, paths,
 * prompts and the text of a question never appear: an agent cannot shape her sentence, and the card
 * has the question. The text is at most {@link MAX_OPERATOR_BRIEFING_WORDS} words: when
 * there is more to say than fits, the least urgent needs are counted in one closing sentence.
 */

import type { OperatorAskView } from '../../shared/contracts/asks.js';
import type { TaskStatus } from '../../shared/contracts/task-status.js';
import { isTerminalStatus } from '../../shared/contracts/task-status.js';
import type { OperatorAttentionKind } from './attention.js';
import { isGenericTaskName, spokenTaskName } from '../spoken-task-name.js';
import { redactedTaskName, redactSpeechSecrets } from '../task-speech-summary.js';
import { orderPendingAsks, spokenLabel } from './board.js';
import { cleanTaskText } from './task-text.js';

/** The task fields the briefing reads. The server maps its task record and the findings onto this. */
export interface OperatorBriefingTask {
  id: string;
  name?: string;
  status: TaskStatus;
  /** Why the task waits on the operator (`operatorAttention`); absent when it does not. */
  attention?: OperatorAttentionKind;
  /** When the task ended, in epoch milliseconds, for a task that has. */
  endedAt?: number;
}

export interface OperatorBriefingInput {
  tasks: readonly OperatorBriefingTask[];
  /** The questions tasks asked with `kookr ask`; only the pending ones are read. */
  asks?: readonly OperatorAskView[];
}

export interface OperatorBriefing {
  /** What she writes, addressed to the operator. */
  text: string;
  /** Up to {@link MAX_OPERATOR_BRIEFING_CHIPS} follow-up requests the operator can press, most useful first. */
  chips: string[];
  /**
   * Changes only when what waits on the operator changes: which tasks, and why. The number of tasks
   * that are simply working, and which tasks ended, are not part of it, so a briefing is not repeated
   * because one more task started.
   */
  signature: string;
}

export const MAX_OPERATOR_BRIEFING_WORDS = 45;
export const MAX_OPERATOR_BRIEFING_CHIPS = 3;
/** A task that ended within this time makes "What finished while I was away?" worth offering. */
export const RECENTLY_ENDED_MS = 8 * 60 * 60 * 1000;

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** A small count in words ("three"), a larger one in digits. */
export function countWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** A title too long to be said whole is shortened to at most this many of its first words. */
export const SHORTENED_NAME_WORDS = 4;
/**
 * Only a title up to this long is shortened. Beyond it the title is a request pasted in as a name
 * ("can you check which of the tasks is terminated unexpectedly..."), and its first words would read
 * as a broken sentence, so the task is counted instead.
 */
const MAX_SHORTENABLE_WORDS = 9;
const MAX_SHORTENABLE_CHARS = 64;
/** A cut shorter than this names too little to be worth writing. */
const MIN_CUT_CHARS = 10;
/** Words a shortened title must not end on: they begin a phrase that the cut removed. */
const DANGLING_WORDS: ReadonlySet<string> = new Set(['a', 'an', 'the', 'of', 'for', 'to', 'in', 'on', 'with', 'and', 'or']);

/**
 * The task's title as she may write it, otherwise undefined. A title that may be said whole (the rules
 * of `spokenLabel`) is returned as it is. A title that is only too long ("Test Inkling 2 Mini Unsloth
 * Context Throughput") is cut to at most its first {@link SHORTENED_NAME_WORDS} words (a request pasted
 * in as a title is not: see {@link MAX_SHORTENABLE_WORDS}), because a line that names nothing is worse
 * than one that names the start of the title. The cut drops trailing words such as "for" and "the"
 * ({@link DANGLING_WORDS}), unless that would leave fewer than two other words or fewer than
 * {@link MIN_CUT_CHARS} characters ("Port it to an ARM build box" would become "Port it"); then the
 * first four words are kept as they are. Four words that are all such words name nothing: undefined. The cut text goes through the same
 * cleaning and the same checks again, since a cut can leave a half-token or a cut-off phrase; a title
 * that still fails (an identifier, a path, a secret, a word of 40 letters) gives undefined.
 */
export function sayableTaskName(name: string | undefined): string | undefined {
  const label = spokenLabel({ name });
  if (label.startsWith('"') && label.length > 2) return label.slice(1, -1);
  const cleaned = redactedTaskName(name === undefined ? undefined : cleanTaskText(name));
  if (!cleaned) return undefined;
  // Markup characters are not words: a title made of them is not shortened into a name.
  if (/[<>`]/.test(cleaned)) return undefined;
  const words = cleaned.split(' ');
  // A title already this short that still failed is cut off, unpronounceable or too long in letters: not shortened.
  if (words.length <= SHORTENED_NAME_WORDS || words.length > MAX_SHORTENABLE_WORDS || cleaned.length > MAX_SHORTENABLE_CHARS) return undefined;
  // The cut must not end on a word that leads into the next one ("Add support for").
  const dangling = (word: string): boolean => DANGLING_WORDS.has(word.replace(/[,;:.…]+$/u, '').toLowerCase());
  const firstWords = words.slice(0, SHORTENED_NAME_WORDS);
  if (firstWords.every(dangling)) return undefined;
  const kept = [...firstWords];
  while (kept.length > 0 && dangling(kept[kept.length - 1]!)) kept.pop();
  const tooLittle = kept.filter((word) => !dangling(word)).length < 2 || kept.join(' ').length < MIN_CUT_CHARS;
  const cut = redactSpeechSecrets((tooLittle ? firstWords : kept).join(' ').replace(/[\s,;:\-–—.…]+$/u, ''));
  if (!cut) return undefined;
  const spoken = spokenTaskName(cut);
  return isGenericTaskName(spoken) ? undefined : spoken;
}

/** The groups of tasks that wait on the operator, in the order they are told. */
type NeedGroup = 'question' | 'permission' | 'input' | 'trouble' | 'review';
const NEED_ORDER: readonly NeedGroup[] = ['question', 'permission', 'input', 'trouble', 'review'];

const GROUP_OF: Record<OperatorAttentionKind, NeedGroup> = {
  asked_question: 'question',
  permission_blocked: 'permission',
  needs_input: 'input',
  wants_review: 'review',
  stale_agent: 'trouble',
  hook_disconnected: 'trouble',
  hook_missing: 'trouble',
  hook_parse_degraded: 'trouble',
  backend_unreachable: 'trouble',
  repeated_error: 'trouble',
  merge_conflict: 'trouble',
  api_error: 'trouble',
  budget_exceeded: 'trouble',
};

/** What is said of one named task in trouble. Kookr's own words, never the finding's text. */
const TROUBLE_WORDS: Partial<Record<OperatorAttentionKind, string>> = {
  stale_agent: 'has gone quiet',
  hook_disconnected: 'has lost contact with Kookr',
  repeated_error: 'keeps hitting the same error',
  merge_conflict: 'has a merge conflict',
  api_error: 'hit an error from its model provider',
  budget_exceeded: 'went over its budget',
  backend_unreachable: 'cannot be reached',
  hook_missing: 'cannot be seen by Kookr',
  hook_parse_degraded: 'can only partly be seen by Kookr',
};

/** What a group's tasks are doing, for one task and for several. */
const GROUP_WORDS: Record<NeedGroup, { one: string; many: string }> = {
  question: { one: 'is stopped on a question', many: 'are stopped on a question' },
  permission: { one: 'is waiting for a permission', many: 'are waiting for a permission' },
  input: { one: 'stopped and needs your input', many: 'stopped and need your input' },
  trouble: { one: 'has stalled or hit a problem', many: 'have stalled or hit a problem' },
  review: { one: 'says it is finished and wants your review', many: 'say they are finished and want your review' },
};

interface Need {
  taskId: string;
  name?: string;
  kind: OperatorAttentionKind;
  /** For a question: when it closes, and the Kookr component that asks it when no task does. */
  expiresAt?: number;
  system?: string;
}

interface BriefingState {
  needs: Record<NeedGroup, Need[]>;
  /** The time the briefing is for, for the time left on a question. */
  nowMs: number;
  /** The pending questions a task is still waiting on. */
  blockingAskIds: string[];
  /** Pending questions whose task has ended. */
  opinions: OperatorAskView[];
  working: number;
  recentlyEnded: number;
}

function readState(input: OperatorBriefingInput, nowMs: number): BriefingState {
  const needs: Record<NeedGroup, Need[]> = { question: [], permission: [], input: [], trouble: [], review: [] };
  const pending = orderPendingAsks(input.asks ?? []);
  const blocking = pending.filter((ask) => ask.taskEnded !== true);
  const opinions = pending.filter((ask) => ask.taskEnded === true);
  const taskById = new Map(input.tasks.map((task) => [task.id, task]));

  // A task with a question on a card is told once, as "stopped on a question", whatever else is known about it.
  const asking = new Set<string>();
  for (const ask of blocking) {
    if (asking.has(ask.taskId)) continue;
    asking.add(ask.taskId);
    needs.question.push({
      taskId: ask.taskId,
      // The text of the question is never read here, only who asks it and when it closes.
      ...(ask.system === undefined ? { name: sayableTaskName(ask.taskName ?? taskById.get(ask.taskId)?.name) } : { system: ask.system }),
      kind: 'asked_question',
      expiresAt: ask.expiresAt,
    });
  }

  let working = 0;
  let recentlyEnded = 0;
  for (const task of input.tasks) {
    if (isTerminalStatus(task.status)) {
      if (task.endedAt !== undefined && nowMs - task.endedAt >= 0 && nowMs - task.endedAt <= RECENTLY_ENDED_MS) recentlyEnded += 1;
      continue;
    }
    if (asking.has(task.id)) continue;
    if (task.attention) {
      needs[GROUP_OF[task.attention] ?? 'trouble'].push({ taskId: task.id, name: sayableTaskName(task.name), kind: task.attention });
    } else if (task.status === 'inProgress') {
      working += 1;
    }
  }
  return { needs, nowMs, blockingAskIds: blocking.map((ask) => ask.id), opinions, working, recentlyEnded };
}

/** What Kookr is asking about, for each component that asks. A component not listed is asked about without a subject. */
const SYSTEM_SUBJECTS: Readonly<Record<string, string>> = { 'interrupted-tasks': 'the interrupted tasks' };

/** "117 minutes left": the time a question has before it closes, in the unit that reads naturally. */
export function timeLeftWords(msLeft: number): string {
  const minutes = Math.ceil(msLeft / 60_000);
  if (minutes < 1) return 'less than a minute left';
  if (minutes === 1) return '1 minute left';
  if (minutes <= 180) return `${minutes} minutes left`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `about ${hours} hours left`;
  return `about ${Math.round(hours / 24)} days left`;
}

/** The questions: the one that closes soonest is named with its time left, the others are counted. */
function questionSentence(questions: readonly Need[], nowMs: number): string {
  const [soonest, ...others] = questions;
  const left = soonest!.expiresAt !== undefined ? `, ${timeLeftWords(soonest!.expiresAt - nowMs)}` : '';
  let head: string;
  if (soonest!.system !== undefined) {
    const subject = SYSTEM_SUBJECTS[soonest!.system];
    head = `Kookr is waiting for your answer${subject ? ` about ${subject}` : ''}${left}.`;
  } else if (soonest!.name) {
    head = `${soonest!.name} is stopped on a question${left}.`;
  } else {
    head = `One task is stopped on a question${left}.`;
  }
  if (others.length === 0) return head;
  const what = others.some((need) => need.system !== undefined) ? 'waiting for your answer' : 'stopped on a question';
  return `${head} ${others.length === 1 ? 'One more is' : `${capital(countWord(others.length))} more are`} ${what}.`;
}

/** One sentence for a group. `first` is false once an earlier sentence has already spoken of tasks. */
function groupSentence(group: NeedGroup, tasks: readonly Need[], first: boolean, nowMs: number): string {
  if (group === 'question') return questionSentence(tasks, nowMs);
  const words = GROUP_WORDS[group];
  if (tasks.length === 1) {
    const only = tasks[0]!;
    const does = group === 'trouble' ? TROUBLE_WORDS[only.kind] ?? words.one : words.one;
    if (only.name) return `${only.name} ${does}.`;
    return `${first ? 'One task' : 'Another'} ${does}.`;
  }
  const subject = first ? `${capital(countWord(tasks.length))} tasks` : `${capital(countWord(tasks.length))} others`;
  return `${subject} ${words.many}.`;
}

function opinionSentence(count: number): string {
  return count === 1
    ? 'One finished task would like your opinion.'
    : `${capital(countWord(count))} finished tasks would like your opinion.`;
}

function workingSentence(count: number, afterOthers: boolean): string {
  if (count === 0) return afterOthers ? 'Nothing else is running.' : 'Nothing is running.';
  if (afterOthers) return count === 1 ? 'One more is working.' : `${capital(countWord(count))} more are working.`;
  return count === 1 ? 'One task is working.' : `${capital(countWord(count))} tasks are working.`;
}

function buildText(state: BriefingState): string {
  const groups = NEED_ORDER.filter((group) => state.needs[group].length > 0);
  const needCount = groups.reduce((n, group) => n + state.needs[group].length, 0);
  const opinions = state.opinions.length;

  if (needCount === 0) {
    // Nothing waits and nothing is in trouble: she has nothing to say, and writes nothing.
    if (opinions === 0) return '';
    return ['Nothing is stopped waiting for you.', opinionSentence(opinions), workingSentence(state.working, false)].join(' ');
  }

  const sentences: string[] = [];
  let used = 0;
  let untold = 0;
  for (const [index, group] of groups.entries()) {
    const sentence = groupSentence(group, state.needs[group], index === 0, state.nowMs);
    // Room is kept for the sentence that counts what did not fit, unless this is the last group.
    const reserve = index < groups.length - 1 ? 5 : 0;
    if (untold === 0 && used + wordCount(sentence) + reserve <= MAX_OPERATOR_BRIEFING_WORDS) {
      sentences.push(sentence);
      used += wordCount(sentence);
    } else {
      untold += state.needs[group].length;
    }
  }
  if (untold > 0) {
    const more = untold === 1 ? 'One more needs you.' : `${capital(countWord(untold))} more need you.`;
    sentences.push(more);
    used += wordCount(more);
  }
  for (const extra of [...(opinions > 0 ? [opinionSentence(opinions)] : []), workingSentence(state.working, true)]) {
    if (used + wordCount(extra) > MAX_OPERATOR_BRIEFING_WORDS) break;
    sentences.push(extra);
    used += wordCount(extra);
  }
  return sentences.join(' ');
}

/** The chips are next moves, never a restatement of the briefing, and at most {@link MAX_OPERATOR_BRIEFING_CHIPS}. */
function buildChips(state: BriefingState): string[] {
  const { needs } = state;
  const needCount = NEED_ORDER.reduce((n, group) => n + needs[group].length, 0);
  const chips: string[] = [];
  if (needs.question.length > 1) chips.push('Walk me through the questions');
  else if (needs.question.length === 1) chips.push('Walk me through the question');
  if (needCount > 1) chips.push('What should I do first?');
  // One named task is already told in the sentence, so only the unnamed or several are worth asking about.
  const oneReview = needs.review.length === 1 && needs.review[0]!.name !== undefined;
  if (needs.review.length > 0 && !oneReview) chips.push('What wants my review?');
  else if (needs.review.length === 0 && state.opinions.length > 0) chips.push('Which opinions are wanted?');
  const trouble = needs.trouble.length === 1 ? needs.trouble[0]!.name : undefined;
  if (needs.trouble.length > 0) chips.push(trouble ? `What went wrong with ${trouble}?` : 'What went wrong?');
  if (state.recentlyEnded > 0) chips.push('What finished while I was away?');
  return chips.slice(0, MAX_OPERATOR_BRIEFING_CHIPS);
}

/** A short, stable fingerprint of a string (two FNV-1a passes); not for security. */
function fingerprint(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x811c9dc5) + 0x9e3779b9;
  }
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

function buildSignature(state: BriefingState): string {
  const parts = NEED_ORDER.map((group) => `${group}:${state.needs[group].map((need) => `${need.taskId}/${need.kind}`).sort().join(',')}`);
  // A task that asks a second question after its first was answered is news, so the questions themselves count too.
  parts.push(`asks:${[...state.blockingAskIds].sort().join(',')}`);
  parts.push(`opinion:${state.opinions.map((ask) => ask.id).sort().join(',')}`);
  return fingerprint(parts.join('|'));
}

/** The briefing for the state of the work at `nowMs`. Pure: the same input gives the same result. */
export function buildOperatorBriefing(input: OperatorBriefingInput, nowMs: number): OperatorBriefing {
  const state = readState(input, nowMs);
  const text = buildText(state);
  return { text, chips: text ? buildChips(state) : [], signature: buildSignature(state) };
}
