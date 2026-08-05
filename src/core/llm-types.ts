/**
 * Provider-neutral LLM client types.
 */

import type {
  HelperLlmDiagnosticsCounters,
  HelperLlmDiagnosticsSnapshot,
  HelperLlmFailureCategory,
  HelperLlmPausedProvider,
  HelperLlmProviderAttemptBudget,
  HelperLlmProviderDiagnostics,
  HelperLlmUseCaseDiagnostics,
  HelperLlmUseCaseProviderDiagnostics,
  LlmUseCase,
} from '../shared/contracts/diagnostic.js';

export type {
  HelperLlmDiagnosticsCounters,
  HelperLlmDiagnosticsSnapshot,
  HelperLlmFailureCategory,
  HelperLlmPausedProvider,
  HelperLlmProviderAttemptBudget,
  HelperLlmProviderDiagnostics,
  HelperLlmUseCaseDiagnostics,
  HelperLlmUseCaseProviderDiagnostics,
  LlmUseCase,
};

/** OpenAI-style function tool for structured tool-call output. */
export interface LlmFunctionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export type LlmToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

export interface LlmJsonSchemaResponseFormat {
  type: 'json_schema';
  jsonSchema: {
    name: string;
    schema: Record<string, unknown>;
  };
}

export interface LlmJsonObjectResponseFormat {
  type: 'json_object';
}

export type LlmResponseFormat = LlmJsonSchemaResponseFormat | LlmJsonObjectResponseFormat;

export interface LlmCompletionRequest {
  maxTokens: number;
  system?: string;
  userMessage: string;
  /** Diagnostics tag for Kookr's own helper-LLM call sites. */
  useCase?: LlmUseCase;
  /**
   * Optional structured output hint. Providers that don't support a given
   * mode may ignore it or reject the request (callers should fall back).
   */
  responseFormat?: LlmResponseFormat;
  /**
   * Optional OpenAI-style tools. Used by structured-output fallbacks that
   * force a single function call instead of response_format json_schema.
   * Providers without tool support ignore this field.
   */
  tools?: LlmFunctionTool[];
  toolChoice?: LlmToolChoice;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type LlmProviderFailureCategory = HelperLlmFailureCategory;

export const LLM_PROVIDER_FAILURE_CATEGORIES: readonly LlmProviderFailureCategory[] = [
  'network_timeout',
  'auth',
  'server_5xx',
  'malformed_response',
  'other',
];

export function isLlmProviderFailureCategory(value: unknown): value is LlmProviderFailureCategory {
  return typeof value === 'string'
    && (LLM_PROVIDER_FAILURE_CATEGORIES as readonly string[]).includes(value);
}

export function classifyLlmProviderHttpStatus(status: number): LlmProviderFailureCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500 && status <= 599) return 'server_5xx';
  return 'other';
}

export interface LlmProviderFailureRecord {
  provider: string;
  model: string;
  category: LlmProviderFailureCategory;
  message: string;
}

export interface LlmCompletionAuditResult {
  text: string | null;
  failures: LlmProviderFailureRecord[];
  failureCategory: LlmProviderFailureCategory | null;
}

/**
 * Completion text plus the provider's finish reason. Surfaced so callers can
 * tell an empty/unparseable completion caused by a truncated budget
 * (`finishReason === 'length'`) apart from a genuine `stop`, which is otherwise
 * indistinguishable once `complete()` collapses both to `null` (issue #1555:
 * reasoning tokens on Nemotron consumed the whole 30-token namer budget, so the
 * model finished with `length` before emitting any JSON and every call logged a
 * bare "empty name").
 */
export interface LlmCompletionDetail {
  /** Text content (or tool-call arguments), trimmed; null when empty. */
  text: string | null;
  /** Provider finish reason, e.g. 'stop' | 'length' | 'tool_calls'; null if unreported. */
  finishReason: string | null;
}

export interface LlmClient {
  /** Returns the text content of the first message, or null on failure. */
  complete(request: LlmCompletionRequest): Promise<string | null>;
  /**
   * Like {@link complete}, but also reports the provider finish reason so
   * empty/truncated completions are diagnosable. Optional: callers should fall
   * back to {@link complete} (via `completeLlmDetailed`) when unimplemented.
   */
  completeDetailed?(request: LlmCompletionRequest): Promise<LlmCompletionDetail>;
  /** Returns completion text plus categorized provider-failure details. */
  completeWithFailureAudit?(request: LlmCompletionRequest): Promise<LlmCompletionAuditResult>;
  /** Human-readable provider name for logging (e.g. "groq", "anthropic"). */
  readonly provider: string;
  /** Model ID used by this client (e.g. "meta-llama/llama-4-scout-17b-16e-instruct"). */
  readonly model: string;
}
