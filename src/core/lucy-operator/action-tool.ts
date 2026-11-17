/**
 * `propose_answer`, `propose_reply`, `propose_close`: the tools with which Lucy proposes doing
 * something to an existing task. Like `propose_launch` (`launch-tool.ts`) each one is a signal:
 * the server holds a proposal, shows a card, and only the operator confirms it.
 *
 * What the model may say with a call is narrow on purpose, because the model has read text that
 * agents wrote and may have been steered by it:
 *
 * - Its arguments are only *selectors*: which task (the code on the board), which question (the
 *   code `read_questions` shows), which of that question's choices (its number). Each is checked
 *   here against the board and again on the server against the real task and question. Anything
 *   else in the arguments is never read.
 * - No argument carries text to send. The reply to a task and a free-text answer are written on
 *   the server from the operator's own words (see `action-proposal.ts`).
 *
 * Confirming is not a tool: it happens on the server, before any model is called, on the
 * operator's next sentence, or through the confirm route.
 */

import type { LlmFunctionTool } from '../llm-types.js';
import type { LucyActionProposalView } from '../../shared/contracts/lucy-action.js';
import { LUCY_ACTION_TOOL_NAMES, type LucyActionToolName } from '../../shared/contracts/lucy-turn.js';
import { askCodes, orderPendingAsks, resolveTaskRef, type LucyBoardInput } from './board.js';
import { parseToolArgs } from './tools.js';

const TASK_PARAM = {
  type: 'string',
  description: 'The code shown in square brackets before the task on the board, for example "3f2a".',
} as const;

function tool(name: LucyActionToolName, description: string, properties: Record<string, unknown>, required: string[]): LlmFunctionTool {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}

export const LUCY_ACTION_TOOLS: readonly LlmFunctionTool[] = [
  tool(
    'propose_answer',
    'Call this when the operator tells you their answer to a question a task asked them. Pass the question\'s code and the number of the choice they named. Leave "option" out only when their answer is not one of the choices and the question takes free text: Kookr then writes the answer from the operator\'s own words. Kookr shows the operator a card; nothing is sent until they confirm it.',
    {
      question: { type: 'string', description: 'The code shown for the question on the board or by read_questions, for example "q3fa2".' },
      option: { type: 'integer', description: 'The number of the choice the operator named, as listed for that question (1 for the first).' },
    },
    ['question'],
  ),
  tool(
    'propose_reply',
    'Call this when the operator asks you to tell a running task something. Pass only the task: Kookr writes the message from the operator\'s own words and shows them a card with the exact text. Nothing is typed into the task until they confirm it. Do not call it to answer a question listed as waiting for the operator: use propose_answer for that.',
    { task: TASK_PARAM },
    ['task'],
  ),
  tool(
    'propose_close',
    'Call this when the operator asks you to close (complete) a task that says it is finished. Pass only the task. Kookr shows the operator a card; the task is closed only when they confirm it. It is refused for a task that is still working.',
    { task: TASK_PARAM },
    ['task'],
  ),
];

/** What the model asked for, reduced to ids Kookr knows. Nothing here was written by the model as free text. */
export type LucyActionRequest =
  /** `optionIndex` is zero-based. Absent: the answer is the operator's own words, for a question that takes free text. */
  | { kind: 'answer'; askId: string; optionIndex?: number }
  | { kind: 'reply'; taskId: string }
  | { kind: 'close'; taskId: string };

/** What the server did with a request to propose. */
export type LucyActionProposeResult =
  /** A proposal is now held. `say` is the read-back she speaks, written by the server. */
  | { ok: true; proposal: LucyActionProposalView; say: string }
  /** No proposal: `say` is a question or a reason, written by the server, for her to speak as it is. */
  | { ok: false; say: string; why: string };

/** The server side of the action tools. */
export interface LucyActionPort {
  /**
   * Make a proposal. `operatorWords` are the operator's own messages of this conversation, oldest
   * first, ending with the current one: the only source for any text that will be sent.
   */
  propose(input: { conversationId: string; request: LucyActionRequest; operatorWords: readonly string[]; spoken?: boolean; signal?: AbortSignal }): Promise<LucyActionProposeResult>;
}

export function isLucyActionTool(name: string): name is LucyActionToolName {
  return (LUCY_ACTION_TOOL_NAMES as readonly string[]).includes(name);
}

export type LucyActionCallResult =
  | { ok: true; request: LucyActionRequest }
  /** The selectors did not point at one task, question or choice. `message` goes back to the model, which may correct the call or ask the operator. */
  | { ok: false; message: string };

const NO_QUESTION = 'No waiting question matches that. Call read_questions and pass the code shown for the question, for example "q3fa2".';

/** The choice number the model passed, as a zero-based index; `undefined` when none was passed, `null` when it is not a whole number. */
function optionIndexOf(value: unknown): number | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d{1,3}\s*$/.test(value) ? Number(value) : Number.NaN;
  return Number.isInteger(n) ? n - 1 : null;
}

/**
 * Turn an action tool call into a request, reading only its selectors and checking each against
 * the board. Pure: it proposes nothing. The server checks the same ids again against the real
 * task and question before it holds a proposal, and once more when the operator confirms.
 */
export function resolveActionCall(name: LucyActionToolName, rawArguments: string, board: LucyBoardInput): LucyActionCallResult {
  const args = parseToolArgs(rawArguments);
  if (args === null) return { ok: false, message: 'The arguments were not a JSON object. Call the tool again with valid arguments.' };

  if (name === 'propose_answer') {
    const pending = orderPendingAsks(board.asks ?? []);
    if (pending.length === 0) return { ok: false, message: 'No question from a task is waiting for the operator, so there is nothing to answer. Tell the operator so.' };
    const wanted = typeof args.question === 'string' ? args.question.trim().replace(/^\[|\]$/g, '').replace(/^"|"$/g, '').trim().toLowerCase() : '';
    if (!wanted) return { ok: false, message: NO_QUESTION };
    const codes = askCodes(pending);
    const hits = pending.filter((ask) => codes.get(ask.id) === wanted || ask.id.toLowerCase() === wanted);
    if (hits.length !== 1) return { ok: false, message: NO_QUESTION };
    const ask = hits[0]!;
    const optionIndex = optionIndexOf(args.option);
    if (optionIndex === null || (optionIndex !== undefined && (optionIndex < 0 || optionIndex >= ask.options.length))) {
      return { ok: false, message: `That question has ${ask.options.length} choices, numbered from 1. Pass the number of the choice the operator named; if you cannot tell which one they mean, ask them.` };
    }
    if (optionIndex === undefined && !ask.allowText) {
      return { ok: false, message: 'That question takes one of its listed choices only. Pass "option", the number of the choice the operator named; if they named none of them, tell them the choices and ask which one.' };
    }
    return { ok: true, request: { kind: 'answer', askId: ask.id, ...(optionIndex !== undefined ? { optionIndex } : {}) } };
  }

  const found = resolveTaskRef(args.task, board.tasks);
  if (!found.ok) return { ok: false, message: found.message };
  return { ok: true, request: { kind: name === 'propose_reply' ? 'reply' : 'close', taskId: found.task.id } };
}
