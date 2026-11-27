/**
 * Streaming chat with tools against Baseten, for the Lucy operator loop.
 *
 * Baseten's Model APIs speak the OpenAI chat-completions format, the same one the
 * OpenRouter adapter reads, so this module only builds the Baseten request (address,
 * `Api-Key` header, `reasoning_effort`) and hands it to the shared runner in
 * `lucy-chat-stream-core.ts`. It implements `LucyModelPort`.
 *
 * Differences from OpenRouter: Baseten reports no price (the usage `costUsd` stays
 * null), the model's thinking may arrive as `reasoning_content` (counted as activity,
 * never forwarded), and an error carries no provider name, so a failure is named
 * "Baseten" itself.
 */

import { LucyModelError, type LucyModelEvent, type LucyModelPort, type LucyModelRequest } from '../../core/lucy-operator/model-port.js';
import { DEFAULT_BASE_URL, DEFAULT_MODEL, type BasetenReasoningEffort } from './baseten-client.js';
import { streamLucyChat } from './lucy-chat-stream-core.js';

export { DEFAULT_BASE_URL as DEFAULT_BASETEN_BASE_URL, DEFAULT_MODEL as DEFAULT_BASETEN_MODEL };

export interface BasetenChatStreamConfig {
  apiKey: string;
  model: string;
  /** OpenAI-compatible base URL, without a trailing slash. */
  baseUrl: string;
  /** Sent as `reasoning_effort`. `none` is Baseten's own "do not think" level; null leaves the field out. */
  reasoningEffort: BasetenReasoningEffort | null;
  /** Cuts the request when no byte arrives for this long, in ms. Default 20 s. */
  stallTimeoutMs?: number;
}

/** The JSON body of one request. Exported so tests can check the wire shape without a network. */
export function buildBasetenChatBody(config: BasetenChatStreamConfig, request: LucyModelRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: request.maxOutputTokens,
    temperature: 0,
  };
  if (config.reasoningEffort) body.reasoning_effort = config.reasoningEffort;
  if (request.tools.length > 0) {
    body.tools = request.tools;
    body.tool_choice = 'auto';
  }
  return body;
}

/**
 * Build the model port for the operator loop against Baseten. Aborting `request.signal` closes the connection at once.
 *
 * A model that refuses `reasoning_effort` answers HTTP 400. As Lucy live does, the request is then asked once more
 * without the field; once that is accepted the field is left out for the rest of this process. A 400 the retry does
 * not cure had another cause, so nothing is remembered and the failure is reported.
 */
export function createBasetenChatStream(
  config: BasetenChatStreamConfig,
  fetchImpl: typeof fetch = fetch,
  warn: (message: string) => void = (message) => console.warn(`[lucy-operator] ${message}`),
): LucyModelPort {
  let omitReasoningEffort = false;
  const run = (request: LucyModelRequest, effort: BasetenReasoningEffort | null): AsyncIterable<LucyModelEvent> => {
    const sent = { ...config, reasoningEffort: effort };
    return streamLucyChat({
      service: 'Baseten',
      url: `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      headers: { authorization: `Api-Key ${config.apiKey}` },
      body: buildBasetenChatBody(sent, request),
      stallTimeoutMs: config.stallTimeoutMs,
      httpErrorDetail: { providerName: 'Baseten' },
    }, request, fetchImpl);
  };
  return async function* (request) {
    if (!config.reasoningEffort || omitReasoningEffort) {
      yield* run(request, null);
      return;
    }
    let started = false;
    try {
      for await (const event of run(request, config.reasoningEffort)) {
        started = true;
        yield event;
      }
      return;
    } catch (err) {
      // An HTTP error is thrown before the first event, so `started` is only true for a later failure.
      if (started || !(err instanceof LucyModelError && err.kind === 'http' && err.status === 400)) throw err;
    }
    for await (const event of run(request, null)) {
      if (!omitReasoningEffort) {
        omitReasoningEffort = true;
        warn(`${config.model} refused reasoning_effort "${config.reasoningEffort}" with HTTP 400; it is now asked without that setting.`);
      }
      yield event;
    }
  };
}
