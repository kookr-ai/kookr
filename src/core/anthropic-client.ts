/**
 * Anthropic LLM client implementation.
 *
 * Wraps @anthropic-ai/sdk to implement the LlmClient interface.
 * Used as a fallback when Groq is unavailable.
 *
 * Note: responseFormat is silently ignored — Anthropic's Messages API
 * does not support json_schema response_format. The caller's system prompt
 * must instruct the model to return JSON.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient, LlmCompletionRequest } from './llm-client.js';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export class AnthropicLlmClient implements LlmClient {
  readonly provider = 'anthropic';
  readonly model: string;
  private client: Anthropic;

  constructor(apiKey: string, model = DEFAULT_MODEL) {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async complete(req: LlmCompletionRequest): Promise<string | null> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: req.maxTokens,
      ...(req.system ? { system: req.system } : {}),
      messages: [{ role: 'user', content: req.userMessage }],
    }, { timeout: req.timeoutMs ?? 5000, signal: req.signal });

    const block = response.content[0];
    return block?.type === 'text' ? block.text.trim() || null : null;
  }
}
