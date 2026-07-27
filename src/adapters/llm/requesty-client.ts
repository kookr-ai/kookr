/**
 * Requesty LLM provider wrapper for Kookr helper LLM calls.
 */

import { OpenAiCompatibleLlmClient } from './openai-compatible-client.js';
import type { LlmClient, LlmCompletionDetail, LlmCompletionRequest } from '../../core/llm-types.js';

const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://router.requesty.ai/v1';
const DEFAULT_TIMEOUT_MS = 20_000;

export interface RequestyClientOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}

export type RequestyEnv = Record<string, string | undefined>;

export function createRequestyLlmClientFromEnv(env: RequestyEnv = process.env): LlmClient | null {
  const key = env.KOOKR_REQUESTY_API_KEY?.trim() || env.REQUESTY_API_KEY?.trim();
  if (!key) return null;

  return new RequestyLlmClient({
    apiKey: key,
    model: env.KOOKR_REQUESTY_MODEL?.trim() || undefined,
  });
}

export class RequestyLlmClient implements LlmClient {
  readonly provider = 'requesty';
  readonly model: string;
  private readonly transport: OpenAiCompatibleLlmClient;

  constructor(options: RequestyClientOptions) {
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.transport = new OpenAiCompatibleLlmClient({
      provider: 'requesty',
      apiKey: options.apiKey,
      model: this.model,
      baseUrl: DEFAULT_BASE_URL,
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
