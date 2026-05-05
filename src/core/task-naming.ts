import type { LlmClient } from './llm-client.js';
import { logTaskNaming } from './training-data-logger.js';

const TIMEOUT_MS = 5000;

/** Generates a short task name via an LLM. Returns null on any failure. */
export async function generateTaskName(
  client: LlmClient,
  prompt: string,
  cwd: string,
  criteria?: string,
): Promise<string | null> {
  const contextParts = [
    `Task prompt: ${prompt}`,
    `Working directory: ${cwd}`,
  ];
  if (criteria) {
    contextParts.push(`Success criteria: ${criteria}`);
  }

  try {
    const name = await client.complete({
      maxTokens: 30,
      userMessage: `Given this coding task, generate a short descriptive name (3-8 words, no quotes, no punctuation at the end). The name should help a developer instantly understand what this task is about when scanning a list of tasks.\n\n${contextParts.join('\n')}`,
      timeoutMs: TIMEOUT_MS,
    });

    if (name) {
      logTaskNaming(prompt, cwd, criteria, name);
    }
    return name;
  } catch (err) {
    console.warn(`[task-naming] Failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
