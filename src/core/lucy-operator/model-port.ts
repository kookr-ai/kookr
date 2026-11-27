/**
 * What the Lucy operator loop needs from a language model, described without naming
 * a provider. The loop (`turn.ts`) talks to this; `adapters/llm/openrouter-chat-stream.ts`
 * implements it against OpenRouter, and tests implement it with a script.
 *
 * The message shapes follow the OpenAI chat format, because that is what the model on
 * the other side reads: an assistant message may carry tool calls, and each tool's
 * answer goes back as a `tool` message naming the call it answers.
 */

import type { LlmFunctionTool } from '../llm-types.js';

export interface LucyToolCall {
  id: string;
  name: string;
  /** The arguments as the model wrote them: a JSON string that may be malformed. */
  arguments: string;
}

export type LucyChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface LucyModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** What the provider charged for this call, in US dollars; null when it did not say. */
  costUsd: number | null;
}

export type LucyModelEvent =
  /**
   * The provider has started sending real data for this call (content, a tool call or reasoning), at most
   * once per call and before any text. It says nothing about what was sent: reasoning is never forwarded.
   * It lets the loop tell a model that is thinking from one that is silent.
   */
  | { type: 'activity' }
  /** A piece of the reply, as soon as the model produced it. */
  | { type: 'text'; delta: string }
  /** One tool call, emitted only once its name and arguments have arrived in full. */
  | { type: 'tool_call'; call: LucyToolCall }
  /** Always the last event of a successful call. */
  | { type: 'finish'; finishReason: string | null; usage: LucyModelUsage; provider?: string };

export interface LucyModelRequest {
  messages: readonly LucyChatMessage[];
  tools: readonly LlmFunctionTool[];
  /** Upper bound on the tokens the model may write in this call. */
  maxOutputTokens: number;
  signal?: AbortSignal;
}

/**
 * How a model call can fail. `kind` is for the loop to decide what to tell the operator;
 * `message` is for the server log only and may quote the provider, so it must never be
 * sent to a browser.
 */
export type LucyModelFailureKind = 'http' | 'network' | 'timeout' | 'aborted' | 'bad-response' | 'provider' | 'unavailable';

/**
 * What the provider said about a failure, reduced to short fields that are safe to show: the provider's
 * name, the status, and the two codes OpenRouter attaches to an error's `metadata`. Each field has been
 * cleaned and cut by whoever filled it in. The provider's free text (`message`, `raw`) is never here.
 * `unavailable` is raised by the circuit breaker, which carries the last real failure's fields.
 */
export interface LucyModelErrorDetail {
  providerName?: string;
  status?: number;
  errorType?: string;
  providerCode?: string;
  /** Set when the call was abandoned because nothing arrived in this many milliseconds. */
  firstTokenAfterMs?: number;
}

export class LucyModelError extends Error {
  constructor(
    public readonly kind: LucyModelFailureKind,
    message: string,
    public readonly status?: number,
    public readonly detail?: LucyModelErrorDetail,
  ) {
    super(message);
    this.name = 'LucyModelError';
  }
}

/** One model call. Yields the reply as it is generated; throws {@link LucyModelError} on failure. */
export type LucyModelPort = (request: LucyModelRequest) => AsyncIterable<LucyModelEvent>;
