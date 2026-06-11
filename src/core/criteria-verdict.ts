import type { AgentEvent } from './types.js';
import type { LlmClient } from './llm-types.js';
import type {
  CriteriaCompletionVerdict,
  CriteriaVerdictItem,
  CriteriaVerdictSource,
  CriteriaVerdictStatus,
} from '../shared/contracts/completion-digest.js';
import { redactSecrets } from './redact-secrets.js';

const MAX_EVENT_CHARS = 12_000;
const MAX_TEXT_FIELD_CHARS = 1_000;

export interface CriteriaVerdictEvaluationInput {
  criteria: string | undefined;
  events: AgentEvent[];
  llmClient: LlmClient | null;
  now?: () => Date;
}

export function splitCriteria(criteria: string | undefined): string[] {
  const trimmed = criteria?.trim();
  if (!trimmed) return [];

  const lineItems = trimmed
    .split(/\r?\n/)
    .map((line) => normalizeCriteriaLine(line))
    .filter(Boolean);
  if (lineItems.length > 1) return unique(lineItems);

  const semicolonItems = trimmed
    .split(/;\s+/)
    .map((item) => normalizeCriteriaLine(item))
    .filter(Boolean);
  return unique(semicolonItems);
}

export function buildCriteriaVerdictRequest(criteriaItems: string[], events: AgentEvent[]): { system: string; userMessage: string } {
  const projectedEvents = projectEvents(events);
  return {
    system: [
      'You evaluate whether an AI coding agent satisfied explicit completion criteria.',
      'Return JSON only. Judge each criterion independently as pass, fail, or unknown.',
      'Use unknown when the event window lacks enough evidence. Do not infer from optimism or intent.',
    ].join(' '),
    userMessage: JSON.stringify({
      instructions: 'For each criterion, return {"criterion": string, "verdict": "pass"|"fail"|"unknown", "reason": string}. Keep reasons under 160 characters.',
      criteria: criteriaItems,
      eventWindow: projectedEvents,
      outputSchema: {
        items: [{ criterion: 'same criterion text', verdict: 'pass|fail|unknown', reason: 'short evidence-based reason' }],
      },
    }),
  };
}

export async function evaluateCriteriaVerdict(input: CriteriaVerdictEvaluationInput): Promise<CriteriaCompletionVerdict | undefined> {
  const items = splitCriteria(input.criteria);
  if (items.length === 0) return undefined;

  const now = input.now ?? (() => new Date());
  if (input.events.length === 0) {
    return unknownVerdict(items, 'no-event-window', now(), 'Completion criteria could not be checked because no completion event window was available.');
  }
  if (!input.llmClient) {
    return unknownVerdict(items, 'llm-unavailable', now(), 'Completion criteria could not be checked because no helper LLM is configured.');
  }

  const request = buildCriteriaVerdictRequest(items, input.events);
  try {
    const raw = await input.llmClient.complete({
      ...request,
      maxTokens: 900,
      timeoutMs: 20_000,
      responseFormat: {
        type: 'json_schema',
        jsonSchema: {
          name: 'criteria_completion_verdict',
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['items'],
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['criterion', 'verdict', 'reason'],
                  properties: {
                    criterion: { type: 'string' },
                    verdict: { type: 'string', enum: ['pass', 'fail', 'unknown'] },
                    reason: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!raw) {
      return unknownVerdict(items, 'llm-error', now(), 'Helper LLM returned no criteria verdict.', input.llmClient);
    }
    return parseCriteriaVerdictResponse(raw, items, {
      evaluatedAt: now(),
      provider: input.llmClient.provider,
      model: input.llmClient.model,
    });
  } catch (err) {
    return unknownVerdict(
      items,
      'llm-error',
      now(),
      err instanceof Error ? err.message : String(err),
      input.llmClient,
    );
  }
}

export function parseCriteriaVerdictResponse(
  raw: string,
  criteriaItems: string[],
  meta: { evaluatedAt: Date; provider?: string; model?: string },
): CriteriaCompletionVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch (err) {
    return unknownVerdict(
      criteriaItems,
      'parse-error',
      meta.evaluatedAt,
      err instanceof Error ? err.message : String(err),
      meta,
    );
  }

  const rawItems = Array.isArray((parsed as { items?: unknown } | null)?.items)
    ? (parsed as { items: unknown[] }).items
    : [];
  const byCriterion = new Map<string, CriteriaVerdictItem>();
  rawItems.forEach((item, index) => {
    const shaped = item as { criterion?: unknown; verdict?: unknown; reason?: unknown } | null;
    const criterion = typeof shaped?.criterion === 'string' ? shaped.criterion.trim() : criteriaItems[index] ?? '';
    if (!criterion) return;
    const verdict = normalizeVerdict(shaped?.verdict);
    const reason = typeof shaped?.reason === 'string' && shaped.reason.trim()
      ? truncate(shaped.reason.trim(), 180)
      : 'No reason provided.';
    byCriterion.set(criterion, { criterion, verdict, reason });
  });

  const verdictItems = criteriaItems.map((criterion) => {
    const exact = byCriterion.get(criterion);
    if (exact) return exact;
    return { criterion, verdict: 'unknown' as const, reason: 'Helper LLM did not return a verdict for this criterion.' };
  });

  return withSummary({
    items: verdictItems,
    source: 'llm',
    evaluatedAt: meta.evaluatedAt.toISOString(),
    ...(meta.provider ? { provider: meta.provider } : {}),
    ...(meta.model ? { model: meta.model } : {}),
  });
}

function unknownVerdict(
  criteriaItems: string[],
  source: CriteriaVerdictSource,
  evaluatedAt: Date,
  reason: string,
  client?: { provider?: string; model?: string } | null,
): CriteriaCompletionVerdict {
  return withSummary({
    items: criteriaItems.map((criterion) => ({
      criterion,
      verdict: 'unknown',
      reason: truncate(reason, 180),
    })),
    source,
    evaluatedAt: evaluatedAt.toISOString(),
    ...(client?.provider ? { provider: client.provider } : {}),
    ...(client?.model ? { model: client.model } : {}),
    ...(source === 'llm-error' || source === 'parse-error' ? { error: truncate(reason, 240) } : {}),
  });
}

function withSummary(verdict: Omit<CriteriaCompletionVerdict, 'summary'>): CriteriaCompletionVerdict {
  const summary = { pass: 0, fail: 0, unknown: 0 };
  for (const item of verdict.items) {
    summary[item.verdict] += 1;
  }
  return { ...verdict, summary };
}

function normalizeCriteriaLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*+]\s+/, '')
    .replace(/^\[[ xX]\]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .trim();
}

function projectEvents(events: AgentEvent[]): Array<Record<string, unknown>> {
  let used = 0;
  const projected: Array<Record<string, unknown>> = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    const item = projectEvent(event);
    const serialized = JSON.stringify(item);
    if (used + serialized.length > MAX_EVENT_CHARS) break;
    used += serialized.length;
    projected.unshift(item);
  }
  return projected;
}

function projectEvent(event: AgentEvent): Record<string, unknown> {
  switch (event.type) {
    case 'tool_use':
      return {
        type: event.type,
        toolName: event.toolName,
        toolInput: truncateUnknown(event.toolInput),
      };
    case 'tool_result':
      return {
        type: event.type,
        toolName: event.toolName,
        toolResponse: truncateUnknown(event.toolResponse),
      };
    case 'tool_error':
      return {
        type: event.type,
        toolName: event.toolName,
        error: truncate(event.error, MAX_TEXT_FIELD_CHARS),
      };
    case 'stop':
    case 'stop_failure':
      return {
        type: event.type,
        lastMessage: truncate(event.lastMessage, MAX_TEXT_FIELD_CHARS),
      };
    case 'subagent_stop':
      return {
        type: event.type,
        agentType: event.agentType,
        lastMessage: truncate(event.lastMessage, MAX_TEXT_FIELD_CHARS),
      };
    case 'notification':
      return {
        type: event.type,
        notificationType: event.notificationType,
        message: truncate(event.message, MAX_TEXT_FIELD_CHARS),
      };
    default:
      return { type: event.type };
  }
}

function truncateUnknown(value: unknown): unknown {
  if (typeof value === 'string') return truncate(redactSecrets(value), MAX_TEXT_FIELD_CHARS);
  if (value === null || value === undefined) return value;
  return truncate(redactSecrets(JSON.stringify(value)), MAX_TEXT_FIELD_CHARS);
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function normalizeVerdict(value: unknown): CriteriaVerdictStatus {
  return value === 'pass' || value === 'fail' || value === 'unknown' ? value : 'unknown';
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}...`;
}
