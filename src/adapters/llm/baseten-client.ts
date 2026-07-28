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

const DEFAULT_MODEL = 'nvidia/Nemotron-120B-A12B';
const DEFAULT_BASE_URL = 'https://inference.baseten.co/v1';
const DEFAULT_TIMEOUT_MS = 20_000;

export interface BasetenClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
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
