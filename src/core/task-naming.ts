import type { LlmClient } from './llm-client.js';
import { logTaskNaming } from './training-data-logger.js';

// Budget for a single LLM call. OpenRouter floors this up internally, since
// DeepSeek V4 Flash is slower than the free-tier providers this is tuned for.
const TIMEOUT_MS = 10_000;
const MAX_NAME_LENGTH = 80;
const MAX_NAME_WORDS = 12;

const SYSTEM_PROMPT = `You generate short names for coding tasks.

You MUST respond with ONLY a JSON object matching this shape:
{ "name": "3-8 word task name" }

Rules:
- The name must be plain text, not markdown.
- Do not include quotes inside the name.
- Do not include labels such as "Task name:".
- Do not include explanations, alternatives, or surrounding prose.`;

const TASK_NAME_SCHEMA = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_NAME_LENGTH,
    },
  },
  required: ['name'],
  additionalProperties: false,
};

function extractStructuredName(raw: string): string | null | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && 'name' in parsed) {
      const name = parsed.name;
      return typeof name === 'string' ? name : null;
    }
    return null;
  } catch {
    return undefined;
  }
}

function normalizeTaskName(raw: string): string | null {
  let name = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();

  name = name.replace(
    /^(?:here(?:'s| is)\s+)?(?:a\s+|the\s+)?(?:concise\s+|short\s+|suggested\s+|descriptive\s+)*(?:task\s+)?name(?:\s+that\s+you\s+could\s+use(?:\s+for\s+the\s+task)?)?\s*:\s*/i,
    '',
  ).trim();
  name = name.replace(/[.!?;:]+$/g, '').trim();

  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return null;
  if (name.split(/\s+/).filter(Boolean).length > MAX_NAME_WORDS) return null;
  return name;
}

function parseTaskName(raw: string): string | null {
  const structuredName = extractStructuredName(raw);
  if (structuredName === null) return null;
  return normalizeTaskName(structuredName ?? raw);
}

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
    const rawName = await client.complete({
      useCase: 'task_naming',
      maxTokens: 30,
      system: SYSTEM_PROMPT,
      userMessage: `Generate a task name for this coding task.\n\n${contextParts.join('\n')}`,
      responseFormat: {
        type: 'json_schema',
        jsonSchema: {
          name: 'task_name',
          schema: TASK_NAME_SCHEMA,
        },
      },
      timeoutMs: TIMEOUT_MS,
    });

    const name = rawName ? parseTaskName(rawName) : null;
    if (name) {
      logTaskNaming(prompt, cwd, criteria, name);
    }
    return name;
  } catch (err) {
    console.warn(`[task-naming] Failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}
