/**
 * Streaming chat completion against Baseten's OpenAI-compatible endpoint.
 *
 * The regular Baseten client (`baseten-client.ts`) waits for the whole reply. Lucy live
 * speaks while the model is still writing, so it needs each piece of text as soon as
 * the server sends it. This module reads the server-sent-events stream (lines starting
 * `data: `, ended by `data: [DONE]`) and yields the text pieces ("deltas") one by one.
 *
 * Configuration is read exactly like the regular client: `KOOKR_BASETEN_API_KEY` (or
 * `BASETEN_API_KEY`), `KOOKR_BASETEN_MODEL` and `KOOKR_BASETEN_BASE_URL`.
 */

import { DEFAULT_BASE_URL, DEFAULT_MODEL, type BasetenEnv, type BasetenReasoningEffort } from './baseten-client.js';

export interface BasetenStreamConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

/** Same environment lookup as `createBasetenLlmClientFromEnv`; null when no key is set. */
export function readBasetenStreamConfig(env: BasetenEnv = process.env): BasetenStreamConfig | null {
  const apiKey = env.KOOKR_BASETEN_API_KEY?.trim() || env.BASETEN_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    model: env.KOOKR_BASETEN_MODEL?.trim() || DEFAULT_MODEL,
    baseUrl: env.KOOKR_BASETEN_BASE_URL?.trim() || DEFAULT_BASE_URL,
  };
}

export interface StreamChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface StreamChatRequest {
  messages: readonly StreamChatMessage[];
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  /** Default `none`: a spoken answer cannot wait for the model to think first. */
  reasoningEffort?: BasetenReasoningEffort;
  /** Cuts the request when no byte arrives for this long, in ms. Default 15 s. */
  timeoutMs?: number;
}

export class BasetenStreamError extends Error {
  constructor(public readonly kind: 'http' | 'network' | 'timeout' | 'aborted' | 'bad-response', message: string) {
    super(message);
    this.name = 'BasetenStreamError';
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Pulls complete lines out of a byte stream that may split them anywhere, and turns
 * `data:` lines into text deltas. Lines that are not `data:` (comments, `event:`) and
 * `data:` payloads that are not JSON are ignored: a proxy may inject keep-alives.
 */
export class SseDeltaParser {
  private buffer = '';
  done = false;

  /** Feed decoded text; returns the deltas completed by it, in order. */
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
    const content = extractDelta(json);
    if (content) out.push(content);
  }
}

function extractDelta(json: unknown): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined;
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const delta = (choices[0] as { delta?: { content?: unknown } } | null)?.delta;
  return typeof delta?.content === 'string' ? delta.content : undefined;
}

/**
 * Stream the model's reply as text deltas. Throws {@link BasetenStreamError} on HTTP
 * errors, network failures, a stalled stream or abort. Aborting `req.signal` closes the
 * connection at once.
 */
export async function* streamBasetenChat(
  config: BasetenStreamConfig,
  req: StreamChatRequest,
  fetchImpl: typeof fetch = fetch,
): AsyncGenerator<string, void, void> {
  const controller = new AbortController();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  const onCallerAbort = (): void => controller.abort();
  if (req.signal?.aborted) throw new BasetenStreamError('aborted', 'Baseten stream aborted by caller');
  req.signal?.addEventListener('abort', onCallerAbort, { once: true });

  const failure = (err: unknown): BasetenStreamError => {
    if (timedOut) return new BasetenStreamError('timeout', `Baseten stream stalled for ${timeoutMs}ms`);
    if (req.signal?.aborted) return new BasetenStreamError('aborted', 'Baseten stream aborted by caller');
    const reason = err instanceof Error ? err.message : String(err);
    return new BasetenStreamError('network', `Baseten stream failed: ${reason}`);
  };

  try {
    arm();
    let res: Response;
    try {
      res = await fetchImpl(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model,
          messages: req.messages,
          stream: true,
          max_tokens: req.maxTokens ?? 200,
          temperature: req.temperature ?? 0.3,
          reasoning_effort: req.reasoningEffort ?? 'none',
        }),
        signal: controller.signal,
      });
    } catch (err) {
      throw failure(err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // The key is in a header, never the body, so echoing a short body is safe.
      throw new BasetenStreamError('http', `Baseten returned HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    if (!res.body) throw new BasetenStreamError('bad-response', 'Baseten response has no body');

    const parser = new SseDeltaParser();
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
        for (const delta of parser.push(decoder.decode(chunk.value, { stream: true }))) yield delta;
        if (parser.done) return;
      }
      for (const delta of parser.push(decoder.decode())) yield delta;
      for (const delta of parser.end()) yield delta;
    } finally {
      // Stop reading and drop the connection; ignore errors from an already-closed body.
      reader.cancel().catch(() => {});
    }
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onCallerAbort);
  }
}
