/**
 * Groq LLM client implementation.
 *
 * Uses Llama 4 Scout 17B on Groq's free tier.
 * Supports best-effort structured output via response_format.
 */

import Groq from 'groq-sdk';
import type { LlmClient, LlmCompletionDetail, LlmCompletionRequest } from '../../core/llm-types.js';

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
    return (await this.completeDetailed(req)).text;
  }

  async completeDetailed(req: LlmCompletionRequest): Promise<LlmCompletionDetail> {
    const messages: Groq.Chat.ChatCompletionMessageParam[] = [];
    if (req.system) {
      messages.push({ role: 'system', content: req.system });
    }
    messages.push({ role: 'user', content: req.userMessage });

    const responseFormat = req.responseFormat?.type === 'json_schema'
      ? {
          type: 'json_schema' as const,
          json_schema: {
            name: req.responseFormat.jsonSchema.name,
            strict: false,  // best-effort for Llama 4 Scout
            schema: req.responseFormat.jsonSchema.schema,
          },
        }
      : req.responseFormat?.type === 'json_object'
        ? { type: 'json_object' as const }
        : undefined;

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: req.maxTokens,
      messages,
      ...(responseFormat ? { response_format: responseFormat } : {}),
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools,
            ...(req.toolChoice !== undefined ? { tool_choice: req.toolChoice } : {}),
          }
        : {}),
    }, {
      timeout: req.timeoutMs ?? 10_000,
      signal: req.signal ?? undefined,
    });

    const choice = response.choices[0];
    const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
    const message = choice?.message;
    const content = message?.content?.trim();
    if (content) return { text: content, finishReason };
    const toolArgs = message?.tool_calls?.find((call) => typeof call.function?.arguments === 'string')
      ?.function?.arguments;
    if (typeof toolArgs === 'string' && toolArgs.trim()) return { text: toolArgs.trim(), finishReason };
    return { text: null, finishReason };
  }
}
