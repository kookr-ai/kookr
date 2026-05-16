/**
 * OpenRouter LLM client implementation.
 *
 * OpenRouter exposes an OpenAI-compatible chat completions API, so this client
 * is a small `fetch` wrapper rather than another SDK dependency. It works with
 * any OpenRouter-hosted model; Kookr defaults to `deepseek/deepseek-v4-flash`.
 * In the `auto` provider chain it is tried last, since OpenRouter is paid.
 *
 * Structured output is best-effort: OpenRouter accepts an OpenAI-style
 * `response_format`, but `strict` JSON schema is not honored by every
 * model/provider, so it is sent with `strict: false` like the Groq client.
 *
 * Timeout: OpenRouter routes through varied upstreams and DeepSeek V4 Flash
 * tail latency runs to several seconds, so a short caller timeout tuned for
 * fast free-tier providers is floored up to `DEFAULT_TIMEOUT_MS`. The
 * `KOOKR_LLM_TIMEOUT_MS` env var (passed as `timeoutMs`) overrides it.
 */

import type { LlmClient, LlmCompletionRequest } from './llm-types.js';

const DEFAULT_MODEL = 'deepseek/deepseek-v4-flash';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_APP_TITLE = 'Kookr';
/**
 * OpenRouter request timeout floor. The free-tier providers respond in well
 * under a second; DeepSeek V4 Flash via OpenRouter measures 1-4s warm and
 * higher under load, so callers passing a 5-10s budget are floored up to this.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

export interface OpenRouterClientOptions {
  /** OpenRouter API key. Sent as `Authorization: Bearer <key>`; never logged. */
  apiKey: string;
  /** Model id, e.g. `deepseek/deepseek-v4-flash`. */
  model?: string;
  /** OpenAI-compatible base URL. Defaults to `https://openrouter.ai/api/v1`. */
  baseUrl?: string;
  /** Optional `HTTP-Referer` app-attribution header. */
  httpReferer?: string;
  /** Optional `X-Title` app-attribution header. Defaults to `Kookr`. */
  appTitle?: string;
  /**
   * Request timeout override in milliseconds (from `KOOKR_LLM_TIMEOUT_MS`).
   * When set, it is used verbatim. When unset, the per-request timeout is
   * floored up to `DEFAULT_TIMEOUT_MS` so a short caller value tuned for the
   * fast free-tier providers cannot abort OpenRouter prematurely.
   */
  timeoutMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

export class OpenRouterLlmClient implements LlmClient {
  readonly provider = 'openrouter';
  readonly model: string;
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly httpReferer?: string;
  private readonly appTitle: string;
  private readonly timeoutMs?: number;

  constructor(options: OpenRouterClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model?.trim() || DEFAULT_MODEL;
    const baseUrl = (options.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.endpoint = `${baseUrl}/chat/completions`;
    this.httpReferer = options.httpReferer?.trim() || undefined;
    this.appTitle = options.appTitle?.trim() || DEFAULT_APP_TITLE;
    this.timeoutMs = options.timeoutMs !== undefined && options.timeoutMs > 0
      ? options.timeoutMs
      : undefined;
  }

  async complete(req: LlmCompletionRequest): Promise<string | null> {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (req.system) {
      messages.push({ role: 'system', content: req.system });
    }
    messages.push({ role: 'user', content: req.userMessage });

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: req.maxTokens,
      messages,
    };
    if (req.responseFormat) {
      body.response_format = {
        type: 'json_schema' as const,
        json_schema: {
          name: req.responseFormat.jsonSchema.name,
          strict: false, // best-effort — not every OpenRouter model honors strict schema
          schema: req.responseFormat.jsonSchema.schema,
        },
      };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
      'X-Title': this.appTitle,
    };
    if (this.httpReferer) {
      headers['HTTP-Referer'] = this.httpReferer;
    }

    // Bound the request with a timeout, and also honor a caller-supplied signal.
    // An explicit override (KOOKR_LLM_TIMEOUT_MS) wins; otherwise the caller's
    // value is floored up to DEFAULT_TIMEOUT_MS, since callers tune timeouts
    // for the fast free-tier providers and that budget aborts OpenRouter early.
    const controller = new AbortController();
    const timeoutMs = this.timeoutMs
      ?? Math.max(req.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    if (req.signal) {
      if (req.signal.aborted) controller.abort();
      else req.signal.addEventListener('abort', onAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }

    if (!response.ok) {
      // The body may carry an OpenRouter error message. It never contains the
      // API key (that only travels in the request Authorization header).
      const detail = (await response.text().catch(() => '')).trim().slice(0, 200);
      throw new Error(
        `OpenRouter request failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`,
      );
    }

    const data = (await response.json()) as ChatCompletionResponse;
    return data.choices?.[0]?.message?.content?.trim() || null;
  }
}
