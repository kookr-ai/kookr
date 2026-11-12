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
 * - `provider.order` lists the providers to try, in order, and `provider.only`
 *   forbids every other one, so a turn is never served by a provider that was not
 *   chosen;
 * - `reasoning.effort` sets how much the model thinks before it answers;
 * - `usage.include` makes the last chunk carry token counts and the price charged.
 *
 * The response is a server-sent-events stream: lines starting `data: `, each a JSON
 * chunk, ended by `data: [DONE]`. Tool calls arrive in fragments (the name, then the
 * arguments a few characters at a time), so they are collected and handed over only
 * once the stream has ended. The model's reasoning text is never forwarded.
 */

import {
  LucyModelError,
  type LucyModelEvent,
  type LucyModelPort,
  type LucyModelRequest,
  type LucyModelUsage,
  type LucyToolCall,
} from '../../core/lucy-operator/model-port.js';

export const LUCY_OPERATOR_REASONING_LEVELS = ['none', 'low', 'medium', 'high'] as const;
export type LucyOperatorReasoning = (typeof LUCY_OPERATOR_REASONING_LEVELS)[number];

export interface OpenRouterChatStreamConfig {
  apiKey: string;
  model: string;
  /** OpenAI-compatible base URL, without a trailing slash. */
  baseUrl: string;
  /**
   * Providers to use, in order, as OpenRouter endpoint tags (for example
   * `cohere/fp8`). Empty means "let OpenRouter choose".
   */
  providers: readonly string[];
  reasoning: LucyOperatorReasoning;
  /** Sent as `X-Title` so the calls are attributed to Kookr on OpenRouter. */
  appTitle?: string;
  /** Cuts the request when no byte arrives for this long, in ms. Default 20 s. */
  stallTimeoutMs?: number;
}

const DEFAULT_STALL_TIMEOUT_MS = 20_000;
const MAX_LOGGED_ERROR_CHARS = 200;

/** `cohere/fp8` → `cohere`: the provider part of an endpoint tag. */
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

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Turns the chunks of one streamed reply into text pieces, completed tool calls and
 * the final usage. Lines that are not `data:` and payloads that are not JSON are
 * ignored, because a proxy may inject keep-alive comments.
 */
export class OpenRouterChatStreamParser {
  private buffer = '';
  private readonly calls: Array<{ id: string; name: string; arguments: string }> = [];
  private usage: LucyModelUsage = { inputTokens: 0, outputTokens: 0, costUsd: null };
  private provider: string | undefined;
  private finishReason: string | null = null;
  done = false;

  /** Feed decoded text; returns the text pieces completed by it, in order. Throws when the provider reports an error in the stream. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line, out);
    }
    return out;
  }

  /** Call at end of stream: a final line without a newline still counts. */
  end(): string[] {
    const out: string[] = [];
    if (this.buffer) this.consumeLine(this.buffer.replace(/\r$/, ''), out);
    this.buffer = '';
    return out;
  }

  /** The tool calls and the closing event, once the stream has ended. Calls without a name are dropped. */
  finish(): LucyModelEvent[] {
    const calls: LucyToolCall[] = this.calls.filter((call) => call && call.name).map((call) => ({ ...call }));
    return [
      ...calls.map((call): LucyModelEvent => ({ type: 'tool_call', call })),
      { type: 'finish', finishReason: this.finishReason, usage: this.usage, ...(this.provider ? { provider: this.provider } : {}) },
    ];
  }

  private consumeLine(line: string, out: string[]): void {
    if (this.done || !line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      this.done = true;
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof json !== 'object' || json === null) return;
    const chunk = json as {
      error?: { message?: unknown; code?: unknown };
      provider?: unknown;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown };
      choices?: Array<{
        finish_reason?: unknown;
        delta?: {
          content?: unknown;
          tool_calls?: Array<{ index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }>;
        };
      }>;
    };

    if (chunk.error) {
      const detail = typeof chunk.error.message === 'string' ? chunk.error.message : 'unknown error';
      throw new LucyModelError('provider', `OpenRouter reported an error in the stream: ${detail.slice(0, MAX_LOGGED_ERROR_CHARS)}`);
    }
    if (typeof chunk.provider === 'string' && chunk.provider) this.provider = chunk.provider;
    if (chunk.usage) {
      this.usage = {
        inputTokens: finiteNumber(chunk.usage.prompt_tokens) ?? this.usage.inputTokens,
        outputTokens: finiteNumber(chunk.usage.completion_tokens) ?? this.usage.outputTokens,
        costUsd: finiteNumber(chunk.usage.cost) ?? this.usage.costUsd,
      };
    }

    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    if (!choice) return;
    if (typeof choice.finish_reason === 'string') this.finishReason = choice.finish_reason;
    const delta = choice.delta;
    if (!delta) return;
    // `delta.reasoning` (the model thinking aloud) is deliberately not read.
    if (typeof delta.content === 'string' && delta.content) out.push(delta.content);
    for (const fragment of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const index = typeof fragment.index === 'number' && fragment.index >= 0 ? fragment.index : 0;
      const call = (this.calls[index] ??= { id: '', name: '', arguments: '' });
      if (typeof fragment.id === 'string' && fragment.id) call.id = fragment.id;
      if (typeof fragment.function?.name === 'string') call.name += fragment.function.name;
      if (typeof fragment.function?.arguments === 'string') call.arguments += fragment.function.arguments;
    }
  }
}

/**
 * Build the model port for the operator loop. Each call opens one streamed request;
 * aborting `request.signal` closes the connection at once.
 */
export function createOpenRouterChatStream(config: OpenRouterChatStreamConfig, fetchImpl: typeof fetch = fetch): LucyModelPort {
  return (request) => streamOnce(config, request, fetchImpl);
}

async function* streamOnce(
  config: OpenRouterChatStreamConfig,
  request: LucyModelRequest,
  fetchImpl: typeof fetch,
): AsyncGenerator<LucyModelEvent, void, void> {
  const controller = new AbortController();
  const stallMs = config.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, stallMs);
  };
  const onCallerAbort = (): void => controller.abort();
  if (request.signal?.aborted) throw new LucyModelError('aborted', 'OpenRouter stream aborted by caller');
  request.signal?.addEventListener('abort', onCallerAbort, { once: true });

  const failure = (err: unknown): LucyModelError => {
    if (err instanceof LucyModelError) return err;
    if (stalled) return new LucyModelError('timeout', `OpenRouter stream stalled for ${stallMs}ms`);
    if (request.signal?.aborted) return new LucyModelError('aborted', 'OpenRouter stream aborted by caller');
    return new LucyModelError('network', `OpenRouter stream failed: ${err instanceof Error ? err.message : String(err)}`);
  };

  try {
    arm();
    let res: Response;
    try {
      res = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
          'X-Title': config.appTitle ?? 'Kookr',
        },
        body: JSON.stringify(buildOpenRouterChatBody(config, request)),
        signal: controller.signal,
      });
    } catch (err) {
      throw failure(err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // For the server log only (the loop never forwards this message). The key is in a header, never the body.
      throw new LucyModelError('http', `OpenRouter returned HTTP ${res.status}: ${body.slice(0, MAX_LOGGED_ERROR_CHARS)}`, res.status);
    }
    if (!res.body) throw new LucyModelError('bad-response', 'OpenRouter response has no body');

    const parser = new OpenRouterChatStreamParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          throw failure(err);
        }
        arm();
        if (chunk.done) break;
        for (const delta of parser.push(decoder.decode(chunk.value, { stream: true }))) yield { type: 'text', delta };
        if (parser.done) break;
      }
      if (!parser.done) {
        for (const delta of parser.push(decoder.decode())) yield { type: 'text', delta };
        for (const delta of parser.end()) yield { type: 'text', delta };
      }
      for (const event of parser.finish()) yield event;
    } finally {
      // Stop reading and drop the connection; ignore errors from an already-closed body.
      reader.cancel().catch(() => {});
    }
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onCallerAbort);
  }
}
