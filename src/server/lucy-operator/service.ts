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
import { countSpokenWords, DISABLED_LUCY_INTERACTION_LOG, type LucyInteractionLog } from '../lucy-interaction-log.js';

/** Earlier messages sent with a turn: ten exchanges. */
export const MAX_HISTORY_MESSAGES = 20;
/** Longest remembered message, in characters. */
export const MAX_HISTORY_MESSAGE_CHARS = 2000;
export const MAX_CONVERSATIONS = 50;
export const CONVERSATION_TTL_MS = 2 * 60 * 60 * 1000;

export interface LucyOperatorDeps {
  model: LucyModelPort;
  /** Model id, for the interaction log. */
  modelName: string;
  source: LucyLookSource;
  log?: LucyInteractionLog;
  limits?: Partial<LucyTurnLimits>;
  now?: () => number;
  warn?: (message: string) => void;
}

export interface LucyOperatorService {
  /** True while a turn of this conversation is running; the route answers 409 instead of starting another. */
  isBusy(conversationId: string): boolean;
  /**
   * Run one turn. The stream always ends with one `done` event, unless the caller stops
   * reading first; either way the conversation is released and the turn is recorded.
   */
  runTurn(request: LucyTurnRequest, signal?: AbortSignal): AsyncGenerator<LucyTurnEvent, void, void>;
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
    isBusy: (conversationId) => running.has(conversationId),

    async *runTurn(request, signal) {
      const startedAt = now();
      if (running.has(request.conversationId)) {
        // Two requests raced past the route's check: the second one ends at once and changes nothing.
        yield { type: 'done', end: 'error', reason: 'Another turn of this conversation is still running.', firstTextMs: null, totalMs: 0, steps: 0, inputTokens: 0, outputTokens: 0, costUsd: null };
        return;
      }
      running.add(request.conversationId);

      const inner = runLucyTurn(
        { model: deps.model, source: deps.source, limits: deps.limits, now, warn },
        { text: request.text, history: historyOf(request.conversationId, startedAt), signal },
      );
      let summary: LucyTurnSummary | undefined;
      // Followed as events pass, so a turn the caller walked away from is still recorded.
      let partialAnswer = '';
      const partialTools: string[] = [];
      let firstTextMs: number | null = null;
      // The loop's own closing event, kept in case the caller stops reading right after it.
      let lastDone: LucyTurnDoneEvent | undefined;
      try {
        for (;;) {
          const next = await inner.next();
          if (next.done) {
            summary = next.value;
            break;
          }
          const event = next.value;
          if (event.type === 'text') {
            if (firstTextMs === null) firstTextMs = Math.max(0, now() - startedAt);
            partialAnswer += event.delta;
          } else if (event.type === 'tool_call') {
            partialTools.push(event.name);
          } else if (event.type === 'done') {
            lastDone = event;
          }
          yield event;
        }
      } finally {
        // Runs on a normal end, on a thrown error and when the caller stops reading: the conversation is always released.
        running.delete(request.conversationId);
        try {
          if (!summary) await inner.return(undefined as never).catch(() => undefined);
          const answer = summary?.answer ?? partialAnswer;
          const done: LucyTurnDoneEvent = summary?.done ?? lastDone ?? {
            type: 'done',
            end: 'aborted',
            firstTextMs,
            totalMs: Math.max(0, now() - startedAt),
            steps: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: null,
          };
          // Remember only an exchange the operator actually heard something from.
          if (answer.trim()) remember(request.conversationId, request.text, answer, now());
          record(request, answer, summary?.tools ?? partialTools, done);
        } catch (err) {
          warn(`could not record a turn: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
  };
}
