/**
 * Google Gemini LLM client implementation.
 *
 * Uses Gemini 3 Flash on Google's free tier.
 * Thinking is disabled (thinkingBudget: 0) since our tasks are simple
 * and thinking tokens would consume the output budget.
 * Supports strict structured output via responseMimeType + responseJsonSchema.
 */

import { GoogleGenAI, type GenerateContentConfig } from '@google/genai';
import type { LlmClient, LlmCompletionRequest } from './llm-types.js';

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

    if (req.responseFormat) {
      config.responseMimeType = 'application/json';
      config.responseJsonSchema = req.responseFormat.jsonSchema.schema;
    }

    const timeoutMs = req.timeoutMs ?? 5000;

    const apiCall = this.client.models.generateContent({
      model: this.model,
      contents: req.userMessage,
      config,
    });

    // Race the API call against timeout (and optional abort signal)
    const response = await Promise.race([
      apiCall,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Request timed out')), timeoutMs);
        if (req.signal) {
          if (req.signal.aborted) {
            clearTimeout(timer);
            reject(new Error('Request aborted'));
            return;
          }
          req.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('Request aborted'));
          }, { once: true });
        }
      }),
    ]);

    const text = response.text?.trim();
    return text || null;
  }
}
