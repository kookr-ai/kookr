/**
 * Baseten LLM provider wrapper for Kookr helper LLM calls.
 *
 * Baseten's Model APIs expose an OpenAI-compatible chat completions endpoint,
 * so this client reuses the shared `OpenAiCompatibleLlmClient` transport rather
 * than adding another SDK dependency. It is explicit-only (selected via
 * `KOOKR_LLM_PROVIDER=baseten`) and, like Requesty, is intentionally not part of
 * the `auto` fallback chain.
 */

import { OpenAiCompatibleLlmClient } from './openai-compatible-client.js';
import type { LlmClient, LlmCompletionDetail, LlmCompletionRequest } from '../../core/llm-types.js';

export const DEFAULT_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-Fast';
export const DEFAULT_BASE_URL = 'https://inference.baseten.co/v1';
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Reasoning depths Baseten's Model APIs accept as the top-level `reasoning_effort`
 * (named levels only: a number is rejected with HTTP 400). Which levels a model
 * honours is listed per model in Baseten's reasoning docs.
 */
export const BASETEN_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type BasetenReasoningEffort = typeof BASETEN_REASONING_EFFORTS[number];

export interface BasetenClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Sent as `reasoning_effort` on every request. Unset leaves the model's own default. */
  reasoningEffort?: BasetenReasoningEffort;
}

/**
 * Read `KOOKR_BASETEN_REASONING_EFFORT`. Unset or blank means "do not send the field".
 * An unknown value is ignored with a warning: sending it would turn every helper call
 * into an HTTP 400.
 */
export function readBasetenReasoningEffort(env: BasetenEnv = process.env): BasetenReasoningEffort | undefined {
  const raw = env.KOOKR_BASETEN_REASONING_EFFORT?.trim().toLowerCase();
  if (!raw) return undefined;
  if ((BASETEN_REASONING_EFFORTS as readonly string[]).includes(raw)) return raw as BasetenReasoningEffort;
  console.warn(
    `[llm] Unknown KOOKR_BASETEN_REASONING_EFFORT="${raw.slice(0, 40)}" — expected ${BASETEN_REASONING_EFFORTS.join('|')}. Using the model's default reasoning depth.`,
  );
  return undefined;
}

export type BasetenEnv = Record<string, string | undefined>;

/**
 * Build the Baseten adapter from environment configuration.
 *
 * `KOOKR_BASETEN_API_KEY` is preferred so a Kookr-scoped Baseten credential can
 * be kept separate from any shared `BASETEN_API_KEY`. Returns null when neither
 * key is configured.
 */
export function createBasetenLlmClientFromEnv(env: BasetenEnv = process.env): LlmClient | null {
  const key = env.KOOKR_BASETEN_API_KEY?.trim() || env.BASETEN_API_KEY?.trim();
  if (!key) return null;

  return new BasetenLlmClient({
    apiKey: key,
    model: env.KOOKR_BASETEN_MODEL?.trim() || undefined,
    baseUrl: env.KOOKR_BASETEN_BASE_URL?.trim() || undefined,
    reasoningEffort: readBasetenReasoningEffort(env),
  });
}

export class BasetenLlmClient implements LlmClient {
  readonly provider = 'baseten';
  readonly model: string;
  private readonly transport: OpenAiCompatibleLlmClient;

  constructor(options: BasetenClientOptions) {
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.transport = new OpenAiCompatibleLlmClient({
      provider: 'baseten',
      apiKey: options.apiKey,
      model: this.model,
      baseUrl: options.baseUrl?.trim() || DEFAULT_BASE_URL,
      extraBody: options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : undefined,
      timeoutMs: options.timeoutMs,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    });
  }

  async complete(req: LlmCompletionRequest): Promise<string | null> {
    return this.transport.complete(req);
  }

  async completeDetailed(req: LlmCompletionRequest): Promise<LlmCompletionDetail> {
    return this.transport.completeDetailed(req);
  }
}
