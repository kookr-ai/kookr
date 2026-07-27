import { basename } from 'node:path';
import { completeLlmDetailed } from './llm-client.js';
import type { LlmClient, LlmCompletionRequest, LlmResponseFormat } from './llm-client.js';
import { logTaskNaming } from './training-data-logger.js';

const TIMEOUT_MS = 10_000;
// Token budget for a single naming call. Reasoning models (e.g. baseten
// Nemotron) spend hidden reasoning tokens before any JSON is emitted; with the
// former budget of 30 the reasoning stream consumed the whole allowance and the
// completion finished with `length` before a single character of the name was
// produced — 0% success in prod (issue #1555). 512 leaves ample room for
// reasoning plus the tiny `{"name": "…"}` payload while staying cheap.
const MAX_TOKENS = 512;
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

/**
 * Deterministic, never-empty task name derived from the prompt itself —
 * the guaranteed fallback when the LLM namer returns nothing (issue #1526
 * Phase C4: during the 2026-07-24 grok burst every naming call came back
 * empty, leaving whole batches of unnamed tasks and degrading triage).
 * Uses the first non-empty prompt line (leading markdown/list markers
 * stripped, whitespace collapsed), truncated to {@link MAX_NAME_LENGTH};
 * for a blank prompt, falls back to the cwd basename.
 */
export function deterministicTaskName(prompt: string, cwd?: string): string {
  const firstLine = prompt
    .split('\n')
    .map((line) => line.replace(/^[\s#>*-]+/, '').trim())
    .find((line) => line.length > 0);
  const collapsed = firstLine?.replace(/\s+/g, ' ') ?? '';
  if (collapsed.length === 0) {
    const dir = cwd ? basename(cwd) : '';
    return dir ? `Task in ${dir}` : 'Unnamed task';
  }
  if (collapsed.length <= MAX_NAME_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}…`;
}

/**
 * Structured-output request shapes tried in order (issue #1555, mirroring the
 * #1522 criteria-evaluator chain): a provider that rejects `json_schema` (400)
 * or honors it but returns unparseable text falls through to the looser
 * `json_object`, then to a plain completion parsed heuristically — instead of a
 * single-shot `json_schema` call that fails open on the first hiccup.
 */
type NamingMode = 'json_schema' | 'json_object' | 'plain';

const NAMING_MODES: readonly NamingMode[] = ['json_schema', 'json_object', 'plain'];

function namingResponseFormat(mode: NamingMode): LlmResponseFormat | undefined {
  switch (mode) {
    case 'json_schema':
      return { type: 'json_schema', jsonSchema: { name: 'task_name', schema: TASK_NAME_SCHEMA } };
    case 'json_object':
      return { type: 'json_object' };
    case 'plain':
      return undefined;
  }
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

  const baseRequest: Omit<LlmCompletionRequest, 'responseFormat'> = {
    useCase: 'task_naming',
    maxTokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    userMessage: `Generate a task name for this coding task.\n\n${contextParts.join('\n')}`,
    timeoutMs: TIMEOUT_MS,
  };

  // Reason recorded from the last unusable attempt so the aggregate failure is
  // diagnosable from logs (finish_reason=length ⇒ truncated budget) instead of
  // a bare "empty name".
  let lastFailure = 'no attempt made';

  for (const mode of NAMING_MODES) {
    const responseFormat = namingResponseFormat(mode);
    try {
      const { text, finishReason } = await completeLlmDetailed(client, {
        ...baseRequest,
        ...(responseFormat ? { responseFormat } : {}),
      });
      const name = text ? parseTaskName(text) : null;
      if (name) {
        logTaskNaming(prompt, cwd, criteria, name);
        return name;
      }
      lastFailure = text === null
        ? `empty completion (mode=${mode}, finish_reason=${finishReason ?? 'unknown'})`
        : `unparseable completion (mode=${mode}, finish_reason=${finishReason ?? 'unknown'})`;
      // A client-level condition (breaker open) fails identically for every
      // mode. Stop rather than re-trip the breaker — and re-log — once per mode.
      if (finishReason === 'circuit_open') break;
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') throw err;
      lastFailure = `error (mode=${mode}): ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  console.warn(`[task-naming] No usable name after structured-output fallbacks — ${lastFailure}`);
  return null;
}
