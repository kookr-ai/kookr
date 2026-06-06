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

import { OpenAiCompatibleLlmClient } from '../core/openai-compatible-client.js';
import type { LlmClient, LlmCompletionRequest } from '../core/llm-types.js';

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

type OpenRouterEnv = Record<string, string | undefined>;

/**
 * Build the OpenRouter adapter from environment configuration.
 *
 * This lives in adapters so core can stay behind the provider-neutral
 * `LlmClient` contract and does not need to know OpenRouter transport details.
 */
export function createOpenRouterLlmClientFromEnv(env: OpenRouterEnv = process.env): LlmClient | null {
  // Component-specific key wins so a separate OpenRouter credit limit can be
  // scoped to Kookr; OPENROUTER_API_KEY remains a valid single-key fallback.
  // Trim before falling through so a blank KOOKR_OPENROUTER_API_KEY (empty
  // .env line, empty CI secret) does not shadow a working OPENROUTER_API_KEY.
  const key = env.KOOKR_OPENROUTER_API_KEY?.trim() || env.OPENROUTER_API_KEY?.trim();
  if (!key) return null;

  // Optional timeout override; a non-numeric or non-positive value is ignored
  // so the client falls back to its DEFAULT_TIMEOUT_MS floor.
  const parsedTimeout = Number(env.KOOKR_LLM_TIMEOUT_MS?.trim());
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : undefined;

  return new OpenRouterLlmClient({
    apiKey: key,
    model: env.KOOKR_LLM_MODEL?.trim() || undefined,
    baseUrl: env.KOOKR_LLM_BASE_URL?.trim() || undefined,
    httpReferer: env.KOOKR_LLM_HTTP_REFERER?.trim() || undefined,
    appTitle: env.KOOKR_LLM_APP_TITLE?.trim() || undefined,
    timeoutMs,
  });
}

export class OpenRouterLlmClient implements LlmClient {
  readonly provider = 'openrouter';
  readonly model: string;
  private readonly transport: OpenAiCompatibleLlmClient;

  constructor(options: OpenRouterClientOptions) {
    this.model = options.model?.trim() || DEFAULT_MODEL;
    const baseUrl = (options.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const appTitle = options.appTitle?.trim() || DEFAULT_APP_TITLE;
    const extraHeaders: Record<string, string> = { 'X-Title': appTitle };
    const httpReferer = options.httpReferer?.trim();
    if (httpReferer) {
      extraHeaders['HTTP-Referer'] = httpReferer;
    }
    this.transport = new OpenAiCompatibleLlmClient({
      provider: 'openrouter',
      apiKey: options.apiKey,
      model: this.model,
      baseUrl,
      extraHeaders,
      timeoutMs: options.timeoutMs,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    });
  }

  async complete(req: LlmCompletionRequest): Promise<string | null> {
    return this.transport.complete(req);
  }
}
