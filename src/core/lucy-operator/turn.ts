/**
 * One turn of a conversation with Lucy: the operator says one thing, she answers,
 * looking things up on the way when she needs to (issue #3660).
 *
 * How a turn runs:
 * 1. The model gets her instructions, a fresh board, a note of what she told the operator
 *    without being asked in the last few minutes, the earlier turns and the new sentence.
 * 2. It either answers, and the turn is over, or asks for look-ups. Each look-up goes
 *    through `dispatchLucyTool`, and its answer is added to the conversation. A call to a
 *    tool that proposes a change (`propose_launch`, `propose_answer`, `propose_reply`,
 *    `propose_close`) ends the turn instead, with the sentence the server wrote.
 * 3. The model is called again with what it learned. This repeats until it answers or
 *    a limit is reached.
 *
 * Limits keep one question from running away: at most four model calls, a time limit
 * and a token limit. When one is reached she says so in one fixed sentence, so the
 * operator never waits on a turn that will not end. A model that sends nothing for
 * `firstTokenMs` is given up on, as if it had failed.
 *
 * When the model fails on the first call (an error from the provider, nothing sent in time, or the
 * circuit breaker of `model-health.ts` refusing the call), the turn still answers: with a sentence
 * saying the model is not answering, then what the opening briefing says, written without the model
 * from the board. That reply is marked `source: 'board'` on the closing event. A failure after look-ups
 * ran ends the turn with `error` and the same sentence.
 *
 * The loop has no I/O of its own. The model and the look-ups are ports, so it runs the
 * same against OpenRouter and against a script in tests.
 */

import type { LucyTurnDoneEvent, LucyTurnEnd, LucyTurnEvent } from '../../shared/contracts/lucy-turn.js';
import { redactSpeechSecrets } from '../task-speech-summary.js';
import { boardText, buildLucyBoard, MAX_BOARD_CHARS } from './board.js';
import { buildUnpromptedNote, type LucyUnpromptedSaid } from './unprompted.js';
import { LucyModelError, type LucyChatMessage, type LucyModelEvent, type LucyModelPort, type LucyToolCall } from './model-port.js';
import { plainFailureReason } from './model-failure.js';
import { buildOperatorBriefing, type OperatorBriefingInput } from './operator-briefing.js';
import { buildLucyOperatorPrompt, LUCY_CAP_SENTENCES } from './prompt.js';
import { dispatchLucyTool, displayToolArgs, LUCY_LOOK_TOOLS, type LucyLookSource, type LucyToolOutcome } from './tools.js';
import { LUCY_PROPOSE_LAUNCH, type LucyLaunchPort } from './launch-tool.js';
import { isLucyActionTool, LUCY_ACTION_TOOLS, resolveActionCall, type LucyActionPort } from './action-tool.js';
import { LUCY_PROPOSE_LAUNCH_TOOL } from '../../shared/contracts/lucy-turn.js';

export interface LucyTurnLimits {
  /** Most model calls in one turn. */
  maxSteps: number;
  /** Longest a turn may run, in milliseconds. */
  maxMs: number;
  /**
   * How long the provider may stay silent on one model call (no data of any kind: no text, no look-up and
   * no reasoning) before the call is abandoned and treated as a failure, in milliseconds. `0` switches it
   * off. Reasoning counts as data because a healthy model that is thinking sends no text for a while: in
   * the operator's own history the slowest healthy first text took 9.4 s (9 of 30 turns took over 5 s),
   * while the failing provider answered with its error after 20 s. 12 s clears the first and still cuts
   * the second well short.
   */
  firstTokenMs: number;
  /** Most tokens (read plus written, summed over the model calls) before no further call is made. */
  maxTokens: number;
  /** Most tokens the model may write in one call, reasoning included. */
  maxOutputTokensPerStep: number;
  /** Most look-ups carried out from one model call; any beyond it are dropped. */
  maxToolCallsPerStep: number;
}

export const DEFAULT_LUCY_TURN_LIMITS: LucyTurnLimits = {
  maxSteps: 4,
  maxMs: 30_000,
  firstTokenMs: 12_000,
  maxTokens: 40_000,
  maxOutputTokensPerStep: 1500,
  maxToolCallsPerStep: 4,
};

/** An earlier exchange in the same conversation: only the operator's words and what she said back. */
export interface LucyHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
  /**
   * Set on a `user` message that is Kookr's own note standing in for words nobody said (Talk reading
   * a question out unprompted). The model reads it like any earlier message, but it is not one of the
   * operator's own words, so it is never given to the writers of a task, a reply or an answer.
   */
  note?: true;
}

/** The operator's own sentences of the conversation, oldest first, ending with the current one. */
export function operatorWordsOf(history: readonly LucyHistoryMessage[], text: string): string[] {
  return [...history.filter((m) => m.role === 'user' && m.note !== true).map((m) => m.content), text];
}

export interface LucyTurnDeps {
  model: LucyModelPort;
  source: LucyLookSource;
  /** Present when launching is switched on: she then has `propose_launch`, and her instructions say so. */
  launch?: LucyLaunchPort;
  /** Present when she may act on existing tasks: she then has `propose_answer`, `propose_reply` and `propose_close`. */
  actions?: LucyActionPort;
  limits?: Partial<LucyTurnLimits>;
  /**
   * The same facts the opening briefing is built from. When present, a turn whose first model call fails
   * is answered from them, without the model. When absent, such a turn ends with `error`.
   */
  briefing?: () => OperatorBriefingInput;
  /**
   * Told of a model call the turn abandoned itself (nothing arrived within `firstTokenMs`), which the
   * model port cannot see: its own request was simply cancelled. Failures the port raises are the port's to record.
   */
  onModelFailure?: (err: LucyModelError) => void;
  now?: () => number;
  /** Receives the detail of a model failure for the server log. It may quote the provider, so it is never sent to a client. */
  warn?: (message: string) => void;
  /**
   * Called exactly once when the turn is over, however it ended, with the same summary the
   * generator returns. When the caller stopped reading before the end, this is the only
   * place the figures so far (model calls, tokens, cost, what she had said) are available;
   * the turn is then reported as `aborted`.
   */
  onSettled?: (summary: LucyTurnSummary) => void;
}

export interface LucyTurnInput {
  text: string;
  /** Needed for the tools that propose: the proposal is held against this conversation. */
  conversationId?: string;
  /**
   * The words were spoken: the reply is said aloud, so she is told to write no list, and a spoken
   * proposal's hands-off launch waits until its read-back has been heard.
   */
  spoken?: boolean;
  history: readonly LucyHistoryMessage[];
  /**
   * What she said or wrote to the operator without being asked, lately (a permission notice, a task's
   * question read out, a line about a task, a launch report). Shown to the model next to the board on
   * this turn only: it is never added to the history, and never given to the writers of a task, a
   * reply or an answer.
   */
  unprompted?: readonly LucyUnpromptedSaid[];
  /** Aborting it (the client went away) ends the turn with `aborted`. */
  signal?: AbortSignal;
}

/** What the caller keeps after the stream has ended: for the conversation history and the interaction log. */
export interface LucyTurnSummary {
  /** Everything she said, cap sentence included. */
  answer: string;
  /** Names of the look-ups that were attempted, in order. */
  tools: string[];
  done: LucyTurnDoneEvent;
}

/** What she cannot do while her model is away. Said only when the operator's words look like a request to act. */
const CANNOT_ACT_SENTENCE = 'I cannot launch, answer, reply or close anything until my language model is back.';
const ACTION_VERBS = 'launch|start|spawn|run|answer|reply|respond|close|stop|kill|cancel|approve|deny|send|merge';
/** An action word counts only as the first word, or right after a polite lead-in: "close the finished ones", "can you launch a task". */
const ACTION_REQUEST_RE = new RegExp(`^\\W*(?:(?:lucy|can you|could you|would you|will you|please|go ahead and|i want you to)[\\s,]+)*(?:${ACTION_VERBS})\\b`, 'i');

/**
 * The reply written without the model: the failure sentence, then the briefing from the board. Null when
 * the briefing could not be built, so the turn then ends with `error` as it did before.
 */
function boardReply(reason: string, asked: string, briefing: () => OperatorBriefingInput, nowMs: number): string | null {
  try {
    const board = buildOperatorBriefing(briefing(), nowMs).text;
    return [reason, `From the board: ${board}`, ...(ACTION_REQUEST_RE.test(asked) ? [CANNOT_ACT_SENTENCE] : [])].join(' ');
  } catch {
    return null;
  }
}

/**
 * Run one turn. Yields the events of the wire contract in order, ending with exactly
 * one `done`, and returns a summary for the caller's records. Never throws for a model
 * or look-up failure: those end the turn with `error`.
 */
export async function* runLucyTurn(deps: LucyTurnDeps, input: LucyTurnInput): AsyncGenerator<LucyTurnEvent, LucyTurnSummary, void> {
  const limits: LucyTurnLimits = { ...DEFAULT_LUCY_TURN_LIMITS, ...deps.limits };
  const now = deps.now ?? Date.now;
  const startedAt = now();

  // One abort signal for the model: the caller going away, or the time limit.
  const controller = new AbortController();
  let timedOut = false;
  const onCallerAbort = (): void => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener('abort', onCallerAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limits.maxMs);

  let answer = '';
  let firstTextMs: number | null = null;
  let steps = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = null;
  let provider: string | undefined;
  const tools: string[] = [];

  const textEvent = (delta: string): LucyTurnEvent => {
    if (firstTextMs === null) firstTextMs = Math.max(0, now() - startedAt);
    answer += delta;
    return { type: 'text', delta };
  };
  /** A new stretch of text (a later model call, or a cap sentence) must not run into the previous one. */
  const joined = (delta: string): string => (answer && !/\s$/.test(answer) ? ` ${delta}` : delta);
  const summary = (end: LucyTurnEnd, reason?: string, source?: 'board'): LucyTurnSummary => ({
    answer,
    tools,
    done: {
      type: 'done',
      end,
      ...(reason ? { reason } : {}),
      ...(source ? { source } : {}),
      firstTextMs,
      totalMs: Math.max(0, now() - startedAt),
      steps,
      inputTokens,
      outputTokens,
      // Summing prices of a fraction of a cent leaves float noise; a hundred-millionth of a dollar is plenty.
      costUsd: costUsd === null ? null : Math.round(costUsd * 1e8) / 1e8,
      ...(provider ? { provider } : {}),
    },
  });

  /** The summary the turn ended with; unset while it runs, and when the caller stops reading early. */
  let settled: LucyTurnSummary | undefined;
  const end = (kind: LucyTurnEnd, reason?: string, source?: 'board'): LucyTurnSummary => (settled = summary(kind, reason, source));
  /** Resolves when the turn is cancelled (the caller left, or the time limit passed), so a slow look-up cannot hold it. */
  const cancelled = new Promise<null>((resolve) => {
    if (controller.signal.aborted) resolve(null);
    else controller.signal.addEventListener('abort', () => resolve(null), { once: true });
  });

  try {
    // She has the action tools only in a conversation a proposal can be held against.
    const actions = input.conversationId ? deps.actions : undefined;
    const boardOptions = { canAct: Boolean(actions) };
    const offered = [...LUCY_LOOK_TOOLS, ...(deps.launch ? [LUCY_PROPOSE_LAUNCH] : []), ...(actions ? LUCY_ACTION_TOOLS : [])];
    let board: string;
    let unprompted = '';
    try {
      const boardInput = deps.source.board();
      board = buildLucyBoard(boardInput, startedAt, MAX_BOARD_CHARS, boardOptions);
      try {
        unprompted = buildUnpromptedNote(input.unprompted, startedAt, boardInput.tasks);
      } catch {
        // The note is a help, not a need: a turn is never lost over it.
      }
    } catch (err) {
      deps.warn?.(redactSpeechSecrets(`could not build the board: ${err instanceof Error ? err.message : String(err)}`));
      const result = end('error', 'Kookr could not read the task list.');
      yield result.done;
      return result;
    }
    const messages: LucyChatMessage[] = [
      { role: 'system', content: buildLucyOperatorPrompt(board, { canLaunch: Boolean(deps.launch), canAct: Boolean(actions), spoken: input.spoken === true, unprompted }) },
      // The question and the remembered exchanges leave the machine too, so they get the same
      // secret hiding as the board and the look-ups (a key pasted into a question is not sent on).
      ...input.history.map((message) => ({ role: message.role, content: redactSpeechSecrets(message.content) })),
      { role: 'user', content: redactSpeechSecrets(input.text) },
    ];

    for (;;) {
      // Checked before every model call, in this order: gone, too slow, too many calls, too much read.
      let cap: 'step_cap' | 'time_cap' | 'token_cap' | null = null;
      if (controller.signal.aborted && !timedOut) {
        const result = end('aborted');
        yield result.done;
        return result;
      }
      if (timedOut || now() - startedAt >= limits.maxMs) cap = 'time_cap';
      else if (steps >= limits.maxSteps) cap = 'step_cap';
      else if (steps > 0 && inputTokens + outputTokens >= limits.maxTokens) cap = 'token_cap';
      if (cap) {
        yield textEvent(joined(LUCY_CAP_SENTENCES[cap]));
        const result = end(cap);
        yield result.done;
        return result;
      }

      steps += 1;
      let stepText = '';
      const calls: LucyToolCall[] = [];
      // This call has its own signal so the first-token deadline can cancel it without ending the turn.
      const stepController = new AbortController();
      const onTurnAbort = (): void => stepController.abort();
      if (controller.signal.aborted) stepController.abort();
      else controller.signal.addEventListener('abort', onTurnAbort, { once: true });
      let firstTokenSeen = false;
      let firstTokenExpired = false;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<'deadline'>((resolve) => {
        if (limits.firstTokenMs <= 0) return;
        deadlineTimer = setTimeout(() => {
          if (firstTokenSeen) return;
          firstTokenExpired = true;
          stepController.abort();
          resolve('deadline');
        }, limits.firstTokenMs);
      });
      let iterator: AsyncIterator<LucyModelEvent> | undefined;
      try {
        iterator = deps.model({
          messages,
          tools: offered,
          maxOutputTokens: limits.maxOutputTokensPerStep,
          signal: stepController.signal,
        })[Symbol.asyncIterator]();
        for (;;) {
          const pending = iterator.next();
          pending.catch(() => {}); // when the deadline wins the race, a later failure of this read is not news
          const next = firstTokenSeen ? await pending : await Promise.race([pending, deadline]);
          if (next === 'deadline') throw new LucyModelError('timeout', `no first token within ${limits.firstTokenMs}ms`, undefined, { firstTokenAfterMs: limits.firstTokenMs });
          if (next.done) break;
          const event = next.value;
          if (event.type === 'text') {
            if (!event.delta) continue;
            firstTokenSeen = true;
            yield textEvent(stepText ? event.delta : joined(event.delta));
            stepText += event.delta;
          } else if (event.type === 'activity') {
            firstTokenSeen = true;
          } else if (event.type === 'tool_call') {
            firstTokenSeen = true;
            calls.push(event.call);
          } else {
            inputTokens += event.usage.inputTokens;
            outputTokens += event.usage.outputTokens;
            if (event.usage.costUsd !== null) costUsd = (costUsd ?? 0) + event.usage.costUsd;
            if (event.provider) provider = event.provider;
          }
        }
      } catch (err) {
        if (timedOut) continue; // the check at the top of the loop says the time-limit sentence
        if (input.signal?.aborted) {
          const result = end('aborted');
          yield result.done;
          return result;
        }
        // When the deadline fired, the failure is ours whatever the cancelled request then threw.
        const failure = firstTokenExpired ? new LucyModelError('timeout', `no first token within ${limits.firstTokenMs}ms`, undefined, { firstTokenAfterMs: limits.firstTokenMs }) : err;
        if (firstTokenExpired) deps.onModelFailure?.(failure as LucyModelError);
        // The provider's own words may echo part of the request, so secrets are hidden before they are logged.
        deps.warn?.(redactSpeechSecrets(`model call failed at step ${steps}: ${failure instanceof Error ? failure.message : String(failure)}`));
        const reason = plainFailureReason(failure);
        // On the first call, with nothing said yet, she still answers from the board. Later, or after
        // some words were already said, an error cannot be papered over, so the turn ends with it.
        const fromBoard = steps === 1 && !answer && deps.briefing ? boardReply(reason, input.text, deps.briefing, now()) : null;
        if (fromBoard) {
          yield textEvent(fromBoard);
          const result = end('answered', reason, 'board');
          yield result.done;
          return result;
        }
        const result = end('error', reason);
        yield result.done;
        return result;
      } finally {
        clearTimeout(deadlineTimer);
        controller.signal.removeEventListener('abort', onTurnAbort);
        // Stops a call that is still running (the deadline, or the caller leaving); an already finished one ignores it.
        iterator?.return?.()?.catch(() => {});
      }

      if (calls.length === 0) {
        const result = answer.trim() ? end('answered') : end('error', 'The model returned an empty reply.');
        yield result.done;
        return result;
      }
      // She asked for look-ups on her last allowed call: they are not run; the cap check ends the turn.
      if (steps >= limits.maxSteps) continue;

      const run = calls.slice(0, limits.maxToolCallsPerStep).map((call, index) => ({ ...call, id: call.id || `call_${steps}_${index}` }));
      messages.push({
        role: 'assistant',
        content: stepText || null,
        tool_calls: run.map((call) => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: call.arguments || '{}' } })),
      });
      for (const call of run) {
        // The name comes from the model, so it is cleaned before it is logged or shown.
        const name = boardText(call.name, 40) || 'unnamed';
        tools.push(name);
        // Announced before it runs, so the operator sees what she is doing while she does it.
        yield { type: 'tool_call', id: call.id, name, args: displayToolArgs(call.arguments) };
        if (call.name === LUCY_PROPOSE_LAUNCH_TOOL && deps.launch && input.conversationId) {
          // The arguments of this call are never read: the server writes the task from the operator's words.
          const operatorWords = operatorWordsOf(input.history, input.text);
          const proposed = await Promise.race([
            deps.launch.propose({ conversationId: input.conversationId, operatorWords, spoken: input.spoken, signal: controller.signal }).catch(
              () => ({ ok: false as const, say: 'I could not prepare that launch just now.', why: 'propose failed' }),
            ),
            cancelled,
          ]);
          if (proposed === null) break;
          if (proposed.ok) yield { type: 'proposal', proposal: proposed.proposal };
          yield { type: 'tool_result', id: call.id, name, ok: proposed.ok, summary: proposed.ok ? 'Prepared a launch card' : 'No launch proposed' };
          // What she says is the server's sentence, not the model's: the card and the words cannot differ.
          yield textEvent(joined(proposed.say));
          const result = end('answered');
          yield result.done;
          return result;
        }
        if (isLucyActionTool(call.name) && actions && input.conversationId) {
          // Only the selectors of this call are read (which task, which question, which choice), and each is
          // checked against the board here and against the real task and question on the server.
          let resolved: ReturnType<typeof resolveActionCall>;
          try {
            resolved = resolveActionCall(call.name, call.arguments, deps.source.board());
          } catch {
            resolved = { ok: false, message: 'That could not be checked inside Kookr. Tell the operator you could not prepare it.' };
          }
          if (!resolved.ok) {
            // The selectors point at nothing: she is told why, in Kookr's words, and may correct the call or ask the operator.
            yield { type: 'tool_result', id: call.id, name, ok: false, summary: 'Nothing proposed: no such task, question or choice' };
            messages.push({ role: 'tool', tool_call_id: call.id, content: resolved.message });
            continue;
          }
          const proposed = await Promise.race([
            actions.propose({ conversationId: input.conversationId, request: resolved.request, operatorWords: operatorWordsOf(input.history, input.text), spoken: input.spoken, signal: controller.signal }).catch(
              () => ({ ok: false as const, say: 'I could not prepare that just now.', why: 'propose failed' }),
            ),
            cancelled,
          ]);
          if (proposed === null) break;
          if (proposed.ok) yield { type: 'action_proposal', proposal: proposed.proposal };
          yield { type: 'tool_result', id: call.id, name, ok: proposed.ok, summary: proposed.ok ? 'Prepared a card' : 'Nothing proposed' };
          // What she says is the server's sentence, not the model's: the card and the words cannot differ.
          yield textEvent(joined(proposed.say));
          const result = end('answered');
          yield result.done;
          return result;
        }
        // A look-up cannot be interrupted, but the turn does not have to wait for one that hangs.
        const outcome: LucyToolOutcome | null = await Promise.race([dispatchLucyTool(call.name, call.arguments, deps.source, now(), boardOptions), cancelled]);
        if (outcome === null) break; // the check at the top of the loop ends the turn
        if (outcome.screen) yield { type: 'screen', ...outcome.screen };
        yield { type: 'tool_result', id: call.id, name, ok: outcome.ok, summary: outcome.summary };
        messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.content });
      }
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onCallerAbort);
    // Reached without an ending only when the caller stopped reading: report what happened so far.
    try {
      deps.onSettled?.(settled ?? summary('aborted'));
    } catch {
      // A record keeper that throws must not turn a finished turn into a failure.
    }
  }
}
