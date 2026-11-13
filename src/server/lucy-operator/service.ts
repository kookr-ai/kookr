/**
 * The server side of a conversation with Lucy (issue #3660): it remembers what was
 * said, lets only one turn of a conversation run at a time, runs the turn, and keeps
 * the records.
 *
 * What is remembered between turns is small on purpose: the operator's sentence and
 * what she said back. What her look-ups returned is never kept, so task text read in
 * one turn cannot steer a later one. Conversations live in memory, are capped in
 * length and number, and are forgotten after two hours of silence or a restart.
 */

import type { LucyTurnDoneEvent, LucyTurnEvent, LucyTurnRequest } from '../../shared/contracts/lucy-turn.js';
import { recordLucyOperatorTurn } from '../../core/lucy-operator/diagnostics.js';
import type { LucyModelPort } from '../../core/lucy-operator/model-port.js';
import type { LucyLookSource } from '../../core/lucy-operator/tools.js';
import { runLucyTurn, type LucyHistoryMessage, type LucyTurnLimits, type LucyTurnSummary } from '../../core/lucy-operator/turn.js';
import { redactSpeechSecrets } from '../../core/task-speech-summary.js';
import type { LucyLaunchController } from './launch-controller.js';
import { countSpokenWords, DISABLED_LUCY_INTERACTION_LOG, type LucyInteractionLog } from '../lucy-interaction-log.js';

/** Earlier messages sent with a turn: ten exchanges. */
export const MAX_HISTORY_MESSAGES = 20;
/** Longest remembered message, in characters. */
export const MAX_HISTORY_MESSAGE_CHARS = 2000;
export const MAX_CONVERSATIONS = 50;
export const CONVERSATION_TTL_MS = 2 * 60 * 60 * 1000;
/** Most turns running at once, over all conversations. Each one is a paid model call. */
export const MAX_CONCURRENT_TURNS = 4;

export interface LucyOperatorDeps {
  model: LucyModelPort;
  /** Model id, for the interaction log. */
  modelName: string;
  source: LucyLookSource;
  /** Present when launching is switched on (issue #3676): she may propose a launch, and "go" confirms it. */
  launch?: LucyLaunchController;
  log?: LucyInteractionLog;
  limits?: Partial<LucyTurnLimits>;
  now?: () => number;
  warn?: (message: string) => void;
}

/** What only the server knows about a turn; never taken from the request body. */
export interface LucyTurnContext {
  /** Server clock at the moment the spoken words began (Talk). Used to tell her own voice from the operator's. */
  speechStartedAt?: number;
}

export interface LucyOperatorService {
  /** The launch proposals, when launching is on. The confirm, decline and cancel routes call it. */
  readonly launch?: LucyLaunchController;
  /** True while a turn of this conversation is running; the route answers 409 instead of starting another. */
  isBusy(conversationId: string): boolean;
  /** True while as many turns are running as are allowed at once; the route answers 429 instead of starting another. */
  atCapacity(): boolean;
  /**
   * Run one turn. The stream always ends with one `done` event, unless the caller stops
   * reading first; either way the conversation is released and the turn is recorded.
   */
  runTurn(request: LucyTurnRequest, signal?: AbortSignal, context?: LucyTurnContext): AsyncGenerator<LucyTurnEvent, void, void>;
}

interface Conversation {
  messages: LucyHistoryMessage[];
  lastUsedAt: number;
}

function clip(text: string): string {
  return text.length > MAX_HISTORY_MESSAGE_CHARS ? text.slice(0, MAX_HISTORY_MESSAGE_CHARS) : text;
}

export function createLucyOperator(deps: LucyOperatorDeps): LucyOperatorService {
  const log = deps.log ?? DISABLED_LUCY_INTERACTION_LOG;
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? ((message: string) => console.warn(`[lucy-operator] ${message}`));
  const conversations = new Map<string, Conversation>();
  const running = new Set<string>();

  const historyOf = (conversationId: string, at: number): LucyHistoryMessage[] => {
    const conversation = conversations.get(conversationId);
    if (!conversation) return [];
    if (at - conversation.lastUsedAt > CONVERSATION_TTL_MS) {
      conversations.delete(conversationId);
      return [];
    }
    return conversation.messages;
  };

  const remember = (conversationId: string, asked: string, answer: string, at: number): void => {
    const previous = conversations.get(conversationId)?.messages ?? [];
    const messages = [...previous, { role: 'user' as const, content: clip(asked) }, { role: 'assistant' as const, content: clip(answer) }].slice(-MAX_HISTORY_MESSAGES);
    // Re-insert so the map's order is "least recently used first", then drop the oldest beyond the cap.
    conversations.delete(conversationId);
    conversations.set(conversationId, { messages, lastUsedAt: at });
    for (const id of conversations.keys()) {
      if (conversations.size <= MAX_CONVERSATIONS) break;
      if (!running.has(id)) conversations.delete(id);
    }
  };

  const record = (request: LucyTurnRequest, answer: string, tools: string[], done: LucyTurnDoneEvent): void => {
    recordLucyOperatorTurn(done);
    const asked = redactSpeechSecrets(request.text);
    const said = redactSpeechSecrets(answer);
    log.recordOperatorTurn?.({
      conversationId: request.conversationId,
      end: done.end,
      ...(done.reason ? { reason: done.reason } : {}),
      asked,
      ...(said ? { answer: said } : {}),
      tools,
      model: deps.modelName,
      ...(done.provider ? { provider: done.provider } : {}),
      steps: done.steps,
      ...(done.firstTextMs !== null ? { firstTextMs: done.firstTextMs } : {}),
      totalMs: done.totalMs,
      inputTokens: done.inputTokens,
      outputTokens: done.outputTokens,
      ...(done.costUsd !== null ? { costUsd: done.costUsd } : {}),
      askedWords: countSpokenWords(asked),
      answerWords: said ? countSpokenWords(said) : 0,
    });
  };

  return {
    launch: deps.launch,
    isBusy: (conversationId) => running.has(conversationId),
    atCapacity: () => running.size >= MAX_CONCURRENT_TURNS,

    async *runTurn(request, signal, context) {
      const startedAt = now();
      if (running.has(request.conversationId) || running.size >= MAX_CONCURRENT_TURNS) {
        // Two requests raced past the route's checks: the later one ends at once and changes nothing.
        const reason = running.has(request.conversationId) ? 'Another turn of this conversation is still running.' : 'Too many turns are running at once.';
        yield { type: 'done', end: 'error', reason, firstTextMs: null, totalMs: 0, steps: 0, inputTokens: 0, outputTokens: 0, costUsd: null };
        return;
      }
      running.add(request.conversationId);

      // Confirming, declining and "ignore this, it may be my own voice" are decided here, before any
      // model is called, so no model output and no task text can confirm a launch.
      if (deps.launch) {
        let handling: Awaited<ReturnType<LucyLaunchController['handleReply']>> = { handled: false };
        try {
          handling = await deps.launch.handleReply(request.conversationId, request.text, {
            input: request.input,
            overlapsReadBack: request.overlapsReadBack,
            speechStartedAt: context?.speechStartedAt,
          });
        } catch (err) {
          warn(redactSpeechSecrets(`could not handle a reply to a launch: ${err instanceof Error ? err.message : String(err)}`));
        }
        if (handling.handled) {
          try {
            if (handling.outcome) yield { type: 'launch', ...handling.outcome };
            if (handling.say) yield { type: 'text', delta: handling.say };
            const done: LucyTurnDoneEvent = {
              type: 'done',
              end: handling.ignored ? 'ignored' : 'answered',
              firstTextMs: handling.say ? Math.max(0, now() - startedAt) : null,
              totalMs: Math.max(0, now() - startedAt),
              steps: 0, inputTokens: 0, outputTokens: 0, costUsd: null,
            };
            yield done;
            if (handling.say) remember(request.conversationId, request.text, handling.say, now());
            record(request, handling.say, [], done);
          } finally {
            running.delete(request.conversationId);
          }
          return;
        }
      }

      // Filled by the loop when the turn is over, including when this generator is abandoned mid-way.
      let settled: LucyTurnSummary | undefined;
      const inner = runLucyTurn(
        { model: deps.model, source: deps.source, launch: deps.launch, limits: deps.limits, now, warn, onSettled: (summary) => { settled = summary; } },
        { text: request.text, conversationId: request.conversationId, spoken: request.input === 'voice', history: historyOf(request.conversationId, startedAt), signal },
      );
      try {
        yield* inner;
      } finally {
        // Runs on a normal end, on a thrown error and when the caller stops reading: the conversation is always released.
        running.delete(request.conversationId);
        try {
          // A caller that stopped reading leaves the loop suspended; closing it makes it report what it had.
          await inner.return(undefined as never).catch(() => undefined);
          const summary: LucyTurnSummary = settled ?? {
            answer: '',
            tools: [],
            done: { type: 'done', end: 'error', reason: 'The turn ended without a result.', firstTextMs: null, totalMs: Math.max(0, now() - startedAt), steps: 0, inputTokens: 0, outputTokens: 0, costUsd: null },
          };
          // Remember only an exchange the operator actually heard something from.
          if (summary.answer.trim()) remember(request.conversationId, request.text, summary.answer, now());
          record(request, summary.answer, summary.tools, summary.done);
        } catch (err) {
          warn(`could not record a turn: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
  };
}
