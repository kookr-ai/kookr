/**
 * Streaming chat with tools against OpenRouter, for the Lucy operator loop (issue #3660).
 *
 * The helper-model clients in this folder ask one question and wait for the whole
 * answer. A conversation needs two more things: the reply piece by piece, so the
 * first words reach the operator while the rest is still being written, and tool
 * calls, so the model can ask to look something up. This module does both and
 * nothing else; it implements `LucyModelPort`.
 *
 * The request shape is the one measured in the model trial recorded on issue #3632:
 * - by default there is no `provider` field, so the routing rule on the OpenRouter
 *   account chooses the provider. When a list is configured, `provider.order` lists
 *   the providers to try, in order, and `provider.only` forbids every other one;
 * - `reasoning.effort` sets how much the model thinks before it answers;
 * - `usage.include` makes the last chunk carry token counts and the price charged.
 *
 * Reading the response stream is shared with the Baseten adapter: see `lucy-chat-stream-core.ts`.
 */

import type { LucyModelPort, LucyModelRequest } from '../../core/lucy-operator/model-port.js';
import { LucyChatStreamParser, streamLucyChat } from './lucy-chat-stream-core.js';

export const LUCY_OPERATOR_REASONING_LEVELS = ['none', 'low', 'medium', 'high'] as const;
export type LucyOperatorReasoning = (typeof LUCY_OPERATOR_REASONING_LEVELS)[number];

export interface OpenRouterChatStreamConfig {
  apiKey: string;
  model: string;
  /** OpenAI-compatible base URL, without a trailing slash. */
  baseUrl: string;
  /**
   * Providers to use, in order, as OpenRouter endpoint tags (for example
   * `deepinfra/fp8`). Empty (the default) sends no `provider` field, so the
   * OpenRouter account's routing rule chooses.
   */
  providers: readonly string[];
  reasoning: LucyOperatorReasoning;
  /** Sent as `X-Title` so the calls are attributed to Kookr on OpenRouter. */
  appTitle?: string;
  /** Cuts the request when no byte arrives for this long, in ms. Default 20 s. */
  stallTimeoutMs?: number;
}

/** `deepinfra/fp8` → `deepinfra`: the provider part of an endpoint tag. */
function providerSlug(tag: string): string {
  return tag.split('/')[0] ?? tag;
}

/** The JSON body of one request. Exported so tests can check the wire shape without a network. */
export function buildOpenRouterChatBody(config: OpenRouterChatStreamConfig, request: LucyModelRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: request.messages,
    stream: true,
    max_tokens: request.maxOutputTokens,
    temperature: 0,
    usage: { include: true },
    reasoning: { effort: config.reasoning },
  };
  if (request.tools.length > 0) {
    body.tools = request.tools;
    body.tool_choice = 'auto';
  }
  if (config.providers.length > 0) {
    body.provider = { order: [...config.providers], only: [...new Set(config.providers.map(providerSlug))] };
  }
  return body;
}

/** Turns the chunks of one OpenRouter reply into text pieces, completed tool calls and the final usage. */
export class OpenRouterChatStreamParser extends LucyChatStreamParser {
  constructor() {
    super('OpenRouter');
  }
}

/**
 * Build the model port for the operator loop. Each call opens one streamed request;
 * aborting `request.signal` closes the connection at once.
 */
export function createOpenRouterChatStream(config: OpenRouterChatStreamConfig, fetchImpl: typeof fetch = fetch): LucyModelPort {
  return (request) => streamLucyChat({
    service: 'OpenRouter',
    url: `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    headers: { authorization: `Bearer ${config.apiKey}`, 'X-Title': config.appTitle ?? 'Kookr' },
    body: buildOpenRouterChatBody(config, request),
    stallTimeoutMs: config.stallTimeoutMs,
  }, request, fetchImpl);
}
