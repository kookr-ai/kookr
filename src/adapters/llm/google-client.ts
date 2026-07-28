/**
 * Google Gemini LLM client implementation.
 *
 * Uses Gemini 3 Flash on Google's free tier.
 * Thinking is disabled (thinkingBudget: 0) since our tasks are simple
 * and thinking tokens would consume the output budget.
 * Supports strict structured output via responseMimeType + responseJsonSchema.
 */

import { GoogleGenAI, type GenerateContentConfig } from '@google/genai';
import type { LlmClient, LlmCompletionRequest } from '../../core/llm-types.js';

const DEFAULT_MODEL = 'gemini-3-flash-preview';

export class GoogleLlmClient implements LlmClient {
  readonly provider = 'google';
  readonly model: string;
  private client: GoogleGenAI;

  constructor(apiKey: string, model = DEFAULT_MODEL) {
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
  }

  async complete(req: LlmCompletionRequest): Promise<string | null> {
    const config: GenerateContentConfig = {
      maxOutputTokens: req.maxTokens,
      thinkingConfig: { thinkingBudget: 0 },
    };

    if (req.system) {
      config.systemInstruction = req.system;
    }

    if (req.responseFormat?.type === 'json_schema') {
      config.responseMimeType = 'application/json';
      config.responseJsonSchema = req.responseFormat.jsonSchema.schema;
    } else if (req.responseFormat?.type === 'json_object') {
      config.responseMimeType = 'application/json';
    }

    const timeoutMs = req.timeoutMs ?? 10_000;

    // Wire the caller's signal AND the timeout into a single AbortController
    // so the underlying SDK fetch actually cancels — the prior `Promise.race`
    // rejected the awaited promise while letting the SDK call complete in
    // the background (rfc-speak-agent-summary-v2 R8 / round-1 finding).
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Request timed out')),
      timeoutMs,
    );
    const onUpstreamAbort = (): void => {
      const reason = req.signal?.reason;
      const err = reason instanceof Error ? reason : new Error('Request aborted');
      if (err.name !== 'AbortError') err.name = 'AbortError';
      controller.abort(err);
    };
    if (req.signal) {
      if (req.signal.aborted) onUpstreamAbort();
      else req.signal.addEventListener('abort', onUpstreamAbort, { once: true });
    }

    // GenerateContentConfig.abortSignal is honored by the SDK fetch path
    // (`@google/genai`'s `GenerateContentConfig`).
    config.abortSignal = controller.signal;

    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: req.userMessage,
        config,
      });

      const text = response.text?.trim();
      return text || null;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onUpstreamAbort);
    }
  }
}
