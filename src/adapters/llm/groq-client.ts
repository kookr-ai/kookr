/**
 * Groq LLM client implementation.
 *
 * Uses Llama 4 Scout 17B on Groq's free tier.
 * Supports best-effort structured output via response_format.
 */

import Groq from 'groq-sdk';
import type { LlmClient, LlmCompletionRequest } from '../../core/llm-types.js';

const DEFAULT_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

export class GroqLlmClient implements LlmClient {
  readonly provider = 'groq';
  readonly model: string;
  private client: Groq;

  constructor(apiKey: string, model = DEFAULT_MODEL) {
    this.client = new Groq({ apiKey });
    this.model = model;
  }

  async complete(req: LlmCompletionRequest): Promise<string | null> {
    const messages: Groq.Chat.ChatCompletionMessageParam[] = [];
    if (req.system) {
      messages.push({ role: 'system', content: req.system });
    }
    messages.push({ role: 'user', content: req.userMessage });

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: req.maxTokens,
      messages,
      ...(req.responseFormat ? {
        response_format: {
          type: 'json_schema' as const,
          json_schema: {
            name: req.responseFormat.jsonSchema.name,
            strict: false,  // best-effort for Llama 4 Scout
            schema: req.responseFormat.jsonSchema.schema,
          },
        },
      } : {}),
    }, {
      timeout: req.timeoutMs ?? 10_000,
      signal: req.signal ?? undefined,
    });

    return response.choices[0]?.message?.content?.trim() || null;
  }
}
