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
 * When nothing needs them it is one all-clear line.
 *
 * A task is named only when its title may be said aloud (short, complete, no path, id or secret:
 * the rules of `spokenLabel`); otherwise it is counted. Ids, paths, prompts and the text of a
 * question never appear. The text is at most {@link MAX_OPERATOR_BRIEFING_WORDS} words: when
 * there is more to say than fits, the least urgent needs are counted in one closing sentence.
 */

import type { OperatorAskView } from '../../shared/contracts/asks.js';
import type { TaskStatus } from '../../shared/contracts/task-status.js';
import { isTerminalStatus } from '../../shared/contracts/task-status.js';
import type { OperatorAttentionKind } from './attention.js';
import { orderPendingAsks, spokenLabel } from './board.js';

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

/** The task's title when it may be said aloud, otherwise undefined. The same rules as the board's names. */
export function sayableTaskName(name: string | undefined): string | undefined {
  const label = spokenLabel({ name });
  return label.startsWith('"') && label.length > 2 ? label.slice(1, -1) : undefined;
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
}

interface BriefingState {
  needs: Record<NeedGroup, Need[]>;
  /** The name of the task whose question closes first, when it may be said. */
  firstToClose?: string;
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
    needs.question.push({ taskId: ask.taskId, name: sayableTaskName(ask.taskName ?? taskById.get(ask.taskId)?.name), kind: 'asked_question' });
  }
  const firstToClose = blocking.length > 0 ? needs.question[0]?.name : undefined;

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
  return { needs, ...(firstToClose ? { firstToClose } : {}), blockingAskIds: blocking.map((ask) => ask.id), opinions, working, recentlyEnded };
}

/** One sentence for a group. `first` is false once an earlier sentence has already spoken of tasks. */
function groupSentence(group: NeedGroup, tasks: readonly Need[], first: boolean, firstToClose: string | undefined): string {
  const words = GROUP_WORDS[group];
  if (tasks.length === 1) {
    const only = tasks[0]!;
    const does = group === 'trouble' ? TROUBLE_WORDS[only.kind] ?? words.one : words.one;
    if (only.name) return `${only.name} ${does}.`;
    return `${first ? 'One task' : 'Another'} ${does}.`;
  }
  const subject = first ? `${capital(countWord(tasks.length))} tasks` : `${capital(countWord(tasks.length))} others`;
  const tail = group === 'question' && firstToClose ? `; ${firstToClose}'s closes first` : '';
  return `${subject} ${words.many}${tail}.`;
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
    const lead = opinions > 0 ? 'Nothing is stopped waiting for you.' : 'All clear: nothing needs you.';
    return [lead, ...(opinions > 0 ? [opinionSentence(opinions)] : []), workingSentence(state.working, false)].join(' ');
  }

  const sentences: string[] = [];
  let used = 0;
  let untold = 0;
  for (const [index, group] of groups.entries()) {
    const sentence = groupSentence(group, state.needs[group], index === 0, state.firstToClose);
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

function buildChips(state: BriefingState): string[] {
  const { needs } = state;
  const needCount = NEED_ORDER.reduce((n, group) => n + needs[group].length, 0);
  const chips: string[] = [];
  if (needs.question.length > 1) chips.push('Walk me through the questions');
  else if (needs.question.length === 1) chips.push('Walk me through the question');
  if (needCount > 1) chips.push('What should I do first?');
  if (needs.review.length > 0) chips.push('What wants my review?');
  else if (state.opinions.length > 0) chips.push('Which opinions are wanted?');
  if (needs.trouble.length > 0) chips.push('What went wrong?');
  if (state.recentlyEnded > 0) chips.push('What finished while I was away?');
  if (state.working > 0) chips.push('What is everyone working on?');
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
  const parts = NEED_ORDER.map((group) => `${group}:${state.needs[group].map((need) => need.taskId).sort().join(',')}`);
  // A task that asks a second question after its first was answered is news, so the questions themselves count too.
  parts.push(`asks:${[...state.blockingAskIds].sort().join(',')}`);
  parts.push(`opinion:${state.opinions.map((ask) => ask.id).sort().join(',')}`);
  return fingerprint(parts.join('|'));
}

/** The briefing for the state of the work at `nowMs`. Pure: the same input gives the same result. */
export function buildOperatorBriefing(input: OperatorBriefingInput, nowMs: number): OperatorBriefing {
  const state = readState(input, nowMs);
  return { text: buildText(state), chips: buildChips(state), signature: buildSignature(state) };
}
