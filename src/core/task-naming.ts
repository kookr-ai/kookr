import { basename } from 'node:path';
import { ATTEMPT_BUDGET_EXHAUSTED_FINISH_REASON, classifyLlmProviderFailure, completeLlmDetailed } from './llm-client.js';
import type {
  LlmClient,
  LlmCompletionDetail,
  LlmCompletionRequest,
  LlmProviderFailureCategory,
  LlmResponseFormat,
} from './llm-client.js';
import { firstMeaningfulPromptLine, stripPromptOpeners } from '../shared/task-name-display.js';
import { logTaskNaming } from './training-data-logger.js';

export { presentTaskName, stripPromptOpeners } from '../shared/task-name-display.js';

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
 * Uses the first meaningful prompt line (leading markdown/list markers
 * stripped, whitespace collapsed), truncated to {@link MAX_NAME_LENGTH};
 * for a blank prompt, falls back to the cwd basename.
 *
 * Junk first lines are skipped rather than taken literally (issue #1556):
 * the worktree-guardrail preamble is stripped up front, and lone/leading JSON
 * braces-brackets never become the name — so a JSON spawn payload pasted as the
 * prompt no longer yields a name of `"{"`, and a guardrail-prefixed prompt no
 * longer yields the boilerplate first line.
 */
export function deterministicTaskName(prompt: string, cwd?: string): string {
  const collapsed = stripPromptOpeners(firstMeaningfulPromptLine(prompt));
  if (collapsed.length === 0) {
    const dir = cwd ? basename(cwd) : '';
    return dir ? `Task in ${dir}` : 'Unnamed task';
  }
  if (collapsed.length <= MAX_NAME_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}…`;
}

/**
 * When a JSON spawn payload is pasted in as the prompt (a CLI caller sending
 * the whole `{prompt, cwd, name, …}` body as the prompt string — issue #1556,
 * task a5a89a9a), lift the embedded `name` field so the task is named with the
 * caller's intended name instead of the payload's first brace. Returns the
 * trimmed name when the prompt parses as a JSON object carrying a non-empty
 * string `name`; otherwise undefined (ordinary prose prompts are untouched).
 */
export function extractEmbeddedTaskName(prompt: string): string | undefined {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  if (!('name' in parsed)) return undefined;
  const name = (parsed as { name: unknown }).name;
  if (typeof name !== 'string') return undefined;
  const cleaned = name.trim().replace(/\s+/g, ' ');
  if (cleaned.length === 0) return undefined;
  return cleaned.length <= MAX_NAME_LENGTH
    ? cleaned
    : `${cleaned.slice(0, MAX_NAME_LENGTH - 1).trimEnd()}…`;
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

/**
 * Why a naming call produced no name (issue #3980), so the namer health signal
 * (#3616) counts only evidence about the provider:
 * - `failed` — a provider answered with nothing usable (empty or unparseable),
 *   or failed for good (`auth`: 401/402/403/410, or skipped while paused after
 *   such a failure). Counts toward "Task namer failing".
 * - `transient` — every attempt that reached a provider failed with a timeout,
 *   a 429, a 5xx or an unclassified error. Not counted: it says the provider
 *   was briefly unreachable, not that it is dead.
 * - `skipped` — no provider was contacted (circuit breaker open, or the
 *   process-wide helper-LLM attempt budget spent). Not counted.
 */
export type TaskNamingFailure = 'failed' | 'transient' | 'skipped';

export type TaskNamingResult =
  | { name: string }
  | { name: null; failure: TaskNamingFailure };

/** Severity order: one `failed` attempt outweighs any number of the others. */
const FAILURE_RANK: Record<TaskNamingFailure, number> = { skipped: 0, transient: 1, failed: 2 };

function worseFailure(a: TaskNamingFailure | undefined, b: TaskNamingFailure): TaskNamingFailure {
  return a !== undefined && FAILURE_RANK[a] >= FAILURE_RANK[b] ? a : b;
}

function failureForCategory(category: LlmProviderFailureCategory): TaskNamingFailure {
  // A malformed response is the provider answering with garbage, and auth is
  // a dead or deprecated provider; the other categories can clear by retrying.
  return category === 'auth' || category === 'malformed_response' ? 'failed' : 'transient';
}

/** Classify one attempt that returned no usable name. */
function failureForDetail(detail: LlmCompletionDetail): TaskNamingFailure {
  if (detail.text !== null) return 'failed';
  if (detail.finishReason === 'circuit_open' || detail.finishReason === ATTEMPT_BUDGET_EXHAUSTED_FINISH_REASON) {
    return 'skipped';
  }
  if (detail.failureCategory) return failureForCategory(detail.failureCategory);
  return 'failed';
}

/**
 * The namer health outcome for one naming call, or null when the call says
 * nothing about the provider and must not be recorded (issue #3980).
 */
export function taskNamerOutcomeOf(result: TaskNamingResult): 'success' | 'failure' | null {
  if (result.name !== null) return 'success';
  return result.failure === 'failed' ? 'failure' : null;
}

/** Generates a short task name via an LLM. Returns null on any failure. */
export async function generateTaskName(
  client: LlmClient,
  prompt: string,
  cwd: string,
  criteria?: string,
): Promise<string | null> {
  return (await generateTaskNameDetailed(client, prompt, cwd, criteria)).name;
}

/**
 * Like {@link generateTaskName}, but says why no name came back (issue #3980),
 * so the caller can record namer health from provider evidence only.
 */
export async function generateTaskNameDetailed(
  client: LlmClient,
  prompt: string,
  cwd: string,
  criteria?: string,
): Promise<TaskNamingResult> {
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
  let failure: TaskNamingFailure | undefined;

  for (const mode of NAMING_MODES) {
    const responseFormat = namingResponseFormat(mode);
    try {
      const detail = await completeLlmDetailed(client, {
        ...baseRequest,
        ...(responseFormat ? { responseFormat } : {}),
      });
      const { text, finishReason } = detail;
      const name = text ? parseTaskName(text) : null;
      if (name) {
        logTaskNaming(prompt, cwd, criteria, name);
        return { name };
      }
      failure = worseFailure(failure, failureForDetail(detail));
      lastFailure = text === null
        ? `empty completion (mode=${mode}, finish_reason=${finishReason ?? 'unknown'}${
          detail.failureCategory ? `, category=${detail.failureCategory}` : ''})`
        : `unparseable completion (mode=${mode}, finish_reason=${finishReason ?? 'unknown'})`;
      // A client-level condition (breaker open, attempt budget spent) fails
      // identically for every mode. Stop rather than re-trip it — and re-log —
      // once per mode.
      if (finishReason === 'circuit_open' || finishReason === ATTEMPT_BUDGET_EXHAUSTED_FINISH_REASON) break;
      // A dead provider (auth) rejects the remaining modes the same way.
      if (detail.failureCategory === 'auth') break;
    } catch (err) {
      if ((err as { name?: string } | null)?.name === 'AbortError') throw err;
      lastFailure = `error (mode=${mode}): ${err instanceof Error ? err.message : String(err)}`;
      const category = classifyLlmProviderFailure(err);
      failure = worseFailure(failure, failureForCategory(category));
      // A permanent/cooldown-class provider failure (the 'auth' category, which
      // covers 401/402/403/410 Gone) fails identically for every mode: they share
      // one client, so a dead or deprecated provider will reject the remaining
      // modes the same way. Stop after the first — like a returned circuit_open
      // — instead of paying two more dead round-trips per spawn (issue #2960).
      // Transient failures (network/timeout/429/5xx ⇒ non-auth category) keep
      // the per-mode retry.
      if (category === 'auth') break;
    }
  }

  console.warn(`[task-naming] No usable name after structured-output fallbacks — ${lastFailure}`);
  return { name: null, failure: failure ?? 'failed' };
}
