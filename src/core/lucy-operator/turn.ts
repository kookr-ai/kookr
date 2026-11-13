/**
 * One turn of a conversation with Lucy: the operator says one thing, she answers,
 * looking things up on the way when she needs to (issue #3660).
 *
 * How a turn runs:
 * 1. The model gets her instructions, a fresh board, the earlier turns and the new
 *    sentence.
 * 2. It either answers, and the turn is over, or asks for look-ups. Each look-up goes
 *    through `dispatchLucyTool`, and its answer is added to the conversation.
 * 3. The model is called again with what it learned. This repeats until it answers or
 *    a limit is reached.
 *
 * Limits keep one question from running away: at most four model calls, a time limit
 * and a token limit. When one is reached she says so in one fixed sentence, so the
 * operator never waits on a turn that will not end.
 *
 * The loop has no I/O of its own. The model and the look-ups are ports, so it runs the
 * same against OpenRouter and against a script in tests.
 */

import type { LucyTurnDoneEvent, LucyTurnEnd, LucyTurnEvent } from '../../shared/contracts/lucy-turn.js';
import { redactSpeechSecrets } from '../task-speech-summary.js';
import { boardText, buildLucyBoard } from './board.js';
import { LucyModelError, type LucyChatMessage, type LucyModelPort, type LucyToolCall } from './model-port.js';
import { buildLucyOperatorPrompt, LUCY_CAP_SENTENCES } from './prompt.js';
import { dispatchLucyTool, displayToolArgs, LUCY_LOOK_TOOLS, type LucyLookSource, type LucyToolOutcome } from './tools.js';
import { LUCY_PROPOSE_LAUNCH, type LucyLaunchPort } from './launch-tool.js';
import { LUCY_PROPOSE_LAUNCH_TOOL } from '../../shared/contracts/lucy-turn.js';

export interface LucyTurnLimits {
  /** Most model calls in one turn. */
  maxSteps: number;
  /** Longest a turn may run, in milliseconds. */
  maxMs: number;
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
  maxTokens: 40_000,
  maxOutputTokensPerStep: 1500,
  maxToolCallsPerStep: 4,
};

/** An earlier exchange in the same conversation: only the operator's words and what she said back. */
export interface LucyHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LucyTurnDeps {
  model: LucyModelPort;
  source: LucyLookSource;
  /** Present when launching is switched on: she then has `propose_launch`, and her instructions say so. */
  launch?: LucyLaunchPort;
  limits?: Partial<LucyTurnLimits>;
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
  /** Needed for `propose_launch`: the proposal is held against this conversation. */
  conversationId?: string;
  /** The words were spoken: a spoken proposal's hands-off launch waits until its read-back has been heard. */
  spoken?: boolean;
  history: readonly LucyHistoryMessage[];
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

/** What to tell the operator when the model call failed. Never includes the provider's own error text. */
function plainReason(err: unknown): string {
  if (!(err instanceof LucyModelError)) return 'Something went wrong while preparing the answer.';
  switch (err.kind) {
    case 'http':
      if (err.status === 401 || err.status === 402 || err.status === 403) return 'The model provider refused the request. Check the OpenRouter key and its credit.';
      if (err.status === 429) return 'The model provider is limiting requests right now.';
      return 'The model provider returned an error.';
    case 'network':
      return 'The model provider could not be reached.';
    case 'timeout':
      return 'The model stopped responding.';
    case 'aborted':
      return 'The request was cancelled.';
    case 'bad-response':
    case 'provider':
      return 'The model provider returned an error.';
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
  const summary = (end: LucyTurnEnd, reason?: string): LucyTurnSummary => ({
    answer,
    tools,
    done: {
      type: 'done',
      end,
      ...(reason ? { reason } : {}),
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
  const end = (kind: LucyTurnEnd, reason?: string): LucyTurnSummary => (settled = summary(kind, reason));
  /** Resolves when the turn is cancelled (the caller left, or the time limit passed), so a slow look-up cannot hold it. */
  const cancelled = new Promise<null>((resolve) => {
    if (controller.signal.aborted) resolve(null);
    else controller.signal.addEventListener('abort', () => resolve(null), { once: true });
  });

  try {
    let board: string;
    try {
      board = buildLucyBoard(deps.source.board(), startedAt);
    } catch (err) {
      deps.warn?.(redactSpeechSecrets(`could not build the board: ${err instanceof Error ? err.message : String(err)}`));
      const result = end('error', 'Kookr could not read the task list.');
      yield result.done;
      return result;
    }
    const messages: LucyChatMessage[] = [
      { role: 'system', content: buildLucyOperatorPrompt(board, { canLaunch: Boolean(deps.launch) }) },
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
      try {
        for await (const event of deps.model({
          messages,
          tools: deps.launch ? [...LUCY_LOOK_TOOLS, LUCY_PROPOSE_LAUNCH] : LUCY_LOOK_TOOLS,
          maxOutputTokens: limits.maxOutputTokensPerStep,
          signal: controller.signal,
        })) {
          if (event.type === 'text') {
            if (!event.delta) continue;
            yield textEvent(stepText ? event.delta : joined(event.delta));
            stepText += event.delta;
          } else if (event.type === 'tool_call') {
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
        // The provider's own words may echo part of the request, so secrets are hidden before they are logged.
        deps.warn?.(redactSpeechSecrets(`model call failed at step ${steps}: ${err instanceof Error ? err.message : String(err)}`));
        const result = end('error', plainReason(err));
        yield result.done;
        return result;
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
          const operatorWords = [...input.history.filter((m) => m.role === 'user').map((m) => m.content), input.text];
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
        // A look-up cannot be interrupted, but the turn does not have to wait for one that hangs.
        const outcome: LucyToolOutcome | null = await Promise.race([dispatchLucyTool(call.name, call.arguments, deps.source, now()), cancelled]);
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
