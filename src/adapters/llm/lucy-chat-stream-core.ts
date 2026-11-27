/**
 * The part of Lucy's streaming chat that does not depend on the provider: reading the
 * server-sent-events stream into text pieces, tool calls and usage, and running one
 * streamed request with a stall timer and an abort signal. Both OpenAI-compatible
 * providers the operator can use (OpenRouter, Baseten) call it; each adds only its own
 * request (URL, headers, body) and its own name for log lines.
 *
 * The response is a stream of lines starting `data: `, each a JSON chunk, ended by
 * `data: [DONE]`. Tool calls arrive in fragments (the name, then the arguments a few
 * characters at a time), so they are collected and handed over only once the stream has
 * ended. The model's reasoning text is never forwarded.
 */

import {
  LucyModelError,
  type LucyModelErrorDetail,
  type LucyModelEvent,
  type LucyModelRequest,
  type LucyModelUsage,
  type LucyToolCall,
} from '../../core/lucy-operator/model-port.js';
import { cleanLogText, modelErrorDetailFrom, modelErrorLogLine } from '../../core/lucy-operator/model-failure.js';

/** Which service a stream talks to; used in log lines and in the detail the operator's sentence is built from. */
export type LucyChatService = 'OpenRouter' | 'Baseten';

export const DEFAULT_STALL_TIMEOUT_MS = 20_000;
const MAX_LOGGED_ERROR_CHARS = 200;
/** Most tool calls accepted from one reply. The loop runs at most four of them. */
const MAX_TOOL_CALLS_PER_REPLY = 16;

/** OpenRouter is what the operator's sentence assumes when nothing is said, so only another service is named. */
function serviceField(service: LucyChatService): Pick<LucyModelErrorDetail, 'service'> {
  return service === 'OpenRouter' ? {} : { service };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Turns the chunks of one streamed reply into text pieces, completed tool calls and
 * the final usage. Lines that are not `data:` and payloads that are not JSON are
 * ignored, because a proxy may inject keep-alive comments.
 */
export class LucyChatStreamParser {
  constructor(private readonly service: LucyChatService = 'OpenRouter') {}

  private buffer = '';
  private readonly calls: Array<{ id: string; name: string; arguments: string }> = [];
  private usage: LucyModelUsage = { inputTokens: 0, outputTokens: 0, costUsd: null };
  private provider: string | undefined;
  private finishReason: string | null = null;
  done = false;
  /**
   * True once a JSON chunk has carried a delta of content, a tool call or reasoning. Comment lines
   * (`: OPENROUTER PROCESSING`) and empty keep-alives never set it: a router sends those while the
   * provider has not started. Only the fact is kept; reasoning text is not read.
   */
  sawActivity = false;

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
      error?: { message?: unknown; code?: unknown; metadata?: unknown };
      provider?: unknown;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown };
      choices?: Array<{
        finish_reason?: unknown;
        delta?: {
          content?: unknown;
          reasoning?: unknown;
          reasoning_content?: unknown;
          reasoning_details?: unknown;
          tool_calls?: Array<{ index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } }>;
        };
      }>;
    };

    if (typeof chunk.provider === 'string' && chunk.provider) this.provider = chunk.provider;
    if (chunk.error) {
      // The provider's name and status are kept as short checked fields (what the operator may be told);
      // its message is only ever quoted in the server log, and only when no field could be read.
      const errorDetail: LucyModelErrorDetail = { ...modelErrorDetailFrom({ status: chunk.error.code, provider: this.provider ?? (this.service === 'Baseten' ? 'Baseten' : undefined), metadata: chunk.error.metadata }), ...serviceField(this.service) };
      const text = typeof chunk.error.message === 'string' ? chunk.error.message : 'unknown error';
      // The log keeps the provider's own words after the fields; the operator's sentence never has them.
      const fields = modelErrorLogLine(errorDetail);
      const line = fields ? `${fields}: ${cleanLogText(text, MAX_LOGGED_ERROR_CHARS)}` : `${this.service} reported an error in the stream: ${text.slice(0, MAX_LOGGED_ERROR_CHARS)}`;
      throw new LucyModelError('provider', line, errorDetail.status, errorDetail);
    }
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
    if (
      (typeof delta.content === 'string' && delta.content !== '')
      || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
      || (typeof delta.reasoning === 'string' && delta.reasoning !== '')
      || (typeof delta.reasoning_content === 'string' && delta.reasoning_content !== '')
      || (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0)
    ) this.sawActivity = true;
    // `delta.reasoning` and `delta.reasoning_content` (the model thinking aloud): only the fact that they arrived is used, above; their text is never read.
    if (typeof delta.content === 'string' && delta.content) out.push(delta.content);
    for (const fragment of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      // The index comes from the provider. Anything that is not a small whole number is dropped,
      // so a wild value cannot make the list of calls enormous.
      let index: unknown = fragment.index;
      if (index === undefined || index === null) {
        // No index at all: a fragment carrying a new id starts a new call; any other continues the latest.
        const last = this.calls.length - 1;
        const startsNewCall = last < 0 || (typeof fragment.id === 'string' && fragment.id !== '' && this.calls[last]?.id !== '' && fragment.id !== this.calls[last]?.id);
        index = startsNewCall ? last + 1 : last;
      }
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= MAX_TOOL_CALLS_PER_REPLY) continue;
      const call = (this.calls[index] ??= { id: '', name: '', arguments: '' });
      if (typeof fragment.id === 'string' && fragment.id) call.id = fragment.id;
      if (typeof fragment.function?.name === 'string') call.name += fragment.function.name;
      if (typeof fragment.function?.arguments === 'string') call.arguments += fragment.function.arguments;
    }
  }
}

/** What a provider adapter gives the shared runner: where to send the request and what to call itself. */
export interface LucyChatRequestSpec {
  service: LucyChatService;
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** Cuts the request when no byte arrives for this long, in ms. Default 20 s. */
  stallTimeoutMs?: number;
  /** Fields added to the detail of an HTTP failure (Baseten names itself here: its errors carry no provider name). */
  httpErrorDetail?: LucyModelErrorDetail;
}

/** Run one streamed request. Aborting `request.signal` closes the connection at once. */
export async function* streamLucyChat(
  spec: LucyChatRequestSpec,
  request: LucyModelRequest,
  fetchImpl: typeof fetch,
): AsyncGenerator<LucyModelEvent, void, void> {
  const controller = new AbortController();
  const stallMs = spec.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
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
  if (request.signal?.aborted) throw new LucyModelError('aborted', `${spec.service} stream aborted by caller`);
  request.signal?.addEventListener('abort', onCallerAbort, { once: true });

  const failure = (err: unknown): LucyModelError => {
    if (err instanceof LucyModelError) return err;
    if (stalled) return new LucyModelError('timeout', `${spec.service} stream stalled for ${stallMs}ms`);
    if (request.signal?.aborted) return new LucyModelError('aborted', `${spec.service} stream aborted by caller`);
    return new LucyModelError('network', `${spec.service} stream failed: ${err instanceof Error ? err.message : String(err)}`);
  };

  try {
    arm();
    let res: Response;
    try {
      res = await fetchImpl(spec.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...spec.headers },
        body: JSON.stringify(spec.body),
        signal: controller.signal,
      });
    } catch (err) {
      throw failure(err);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // The message is for the server log only (the loop never forwards it). The key is in a header, never the body.
      // The body's `error.metadata` gives the provider's name and codes, kept as short checked fields.
      let metadata: unknown;
      try {
        metadata = (JSON.parse(body) as { error?: { metadata?: unknown } } | null)?.error?.metadata;
      } catch {
        // Not JSON (a proxy's page): there is nothing to read.
      }
      const errorDetail: LucyModelErrorDetail = { ...modelErrorDetailFrom({ status: res.status, metadata }), ...spec.httpErrorDetail, ...serviceField(spec.service) };
      const fields = errorDetail.providerName || errorDetail.errorType || errorDetail.providerCode ? modelErrorLogLine(errorDetail) : null;
      throw new LucyModelError('http', fields ? `${fields}: ${cleanLogText(body, MAX_LOGGED_ERROR_CHARS)}` : `${spec.service} returned HTTP ${res.status}: ${body.slice(0, MAX_LOGGED_ERROR_CHARS)}`, res.status, errorDetail);
    }
    if (!res.body) throw new LucyModelError('bad-response', `${spec.service} response has no body`);

    const parser = new LucyChatStreamParser(spec.service);
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let activitySent = false;
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
        const pieces = parser.push(decoder.decode(chunk.value, { stream: true }));
        if (parser.sawActivity && !activitySent) {
          activitySent = true;
          yield { type: 'activity' };
        }
        for (const delta of pieces) yield { type: 'text', delta };
        if (parser.done) break;
      }
      if (!parser.done) {
        const tail = [...parser.push(decoder.decode()), ...parser.end()];
        if (parser.sawActivity && !activitySent) {
          activitySent = true;
          yield { type: 'activity' };
        }
        for (const delta of tail) yield { type: 'text', delta };
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