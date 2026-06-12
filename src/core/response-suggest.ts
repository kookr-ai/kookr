/**
 * AI-suggested responses via LLM (Groq or Anthropic fallback).
 *
 * When an agent stops and waits for input, this module generates multiple
 * predicted responses the developer would likely type.
 * Suggestions are ordered from most agreeable to most pushback-oriented.
 *
 * See: docs/rfc/rfc-smart-response-assist.md
 */

import type { LlmClient } from './llm-client.js';
import { logResponseSuggestions } from './training-data-logger.js';

// Budget for a single LLM call. OpenRouter floors this up internally, since
// DeepSeek V4 Flash is slower than the free-tier providers this is tuned for.
const TIMEOUT_MS = 10_000;
const MAX_TOKENS = 300;
const MAX_SUGGESTIONS = 5;

const SYSTEM_PROMPT = `You are helping a developer supervise AI coding agents. An agent has paused and is waiting for the developer's response. Predict short replies the developer would type.

Rules:
- Return a JSON array of 3-5 short reply strings the developer would type.
- Order from most agreeable/cooperative to most pushback/disagreement.
- Each reply must be SHORT — under 80 characters, ideally under 50. Think chat message, not paragraph.
- These are replies TO the agent, not summaries OF the agent's output. Do not echo or paraphrase what the agent said.
- Use plain text only — absolutely no markdown (no **, *, backticks, #, bullets, or code blocks).
- No pleasantries, greetings, or filler words.
- Do not wrap the JSON in a code block — return ONLY the raw JSON array.

Example output:
["yes, go ahead", "yes but add tests first", "hold on, let me review the diff", "no, revert that change"]`;

export interface SuggestionContext {
  lastAssistantMessage: string;
  taskPrompt?: string;
  cwd?: string;
  recentToolCalls?: string[];
}

/**
 * Generate suggested responses using the configured LLM provider.
 * Returns an array of suggestion strings ordered agree-to-disagree, or empty on failure.
 */
export async function generateSuggestedResponses(
  client: LlmClient,
  ctx: SuggestionContext,
  signal?: AbortSignal,
): Promise<string[]> {
  const contextParts: string[] = [];
  if (ctx.taskPrompt) contextParts.push(`Task: ${ctx.taskPrompt}`);
  if (ctx.cwd) contextParts.push(`Working directory: ${ctx.cwd}`);
  if (ctx.recentToolCalls?.length) {
    contextParts.push(`Recent agent actions: ${ctx.recentToolCalls.join(', ')}`);
  }
  contextParts.push(`\nAgent's last message:\n${ctx.lastAssistantMessage}`);

  try {
    const text = await client.complete({
      useCase: 'response_suggestion',
      maxTokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      userMessage: `What responses might the developer give?\n\n${contextParts.join('\n')}`,
      responseFormat: {
        type: 'json_schema',
        jsonSchema: {
          name: 'suggested_responses',
          schema: {
            type: 'object',
            properties: {
              responses: {
                type: 'array',
                items: { type: 'string' },
              },
            },
            required: ['responses'],
          },
        },
      },
      timeoutMs: TIMEOUT_MS,
      signal,
    });

    if (!text) return [];

    const parsed = JSON.parse(text);
    // Handle both { responses: [...] } (structured output) and [...] (free-text JSON)
    const arr = Array.isArray(parsed) ? parsed : parsed?.responses;
    if (!Array.isArray(arr)) return [];

    const suggestions = arr
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      .map(s => s.trim())
      .slice(0, MAX_SUGGESTIONS);
    if (suggestions.length > 0) {
      logResponseSuggestions(ctx, suggestions);
    }
    return suggestions;
  } catch (err) {
    console.warn(`[response-suggest] Failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}
