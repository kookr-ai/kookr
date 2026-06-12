/**
 * Provider-neutral LLM client types.
 */

import type {
  HelperLlmDiagnosticsCounters,
  HelperLlmDiagnosticsSnapshot,
  HelperLlmFailureCategory,
  HelperLlmProviderDiagnostics,
  HelperLlmUseCaseDiagnostics,
  HelperLlmUseCaseProviderDiagnostics,
  LlmUseCase,
} from '../shared/contracts/diagnostic.js';

export type {
  HelperLlmDiagnosticsCounters,
  HelperLlmDiagnosticsSnapshot,
  HelperLlmFailureCategory,
  HelperLlmProviderDiagnostics,
  HelperLlmUseCaseDiagnostics,
  HelperLlmUseCaseProviderDiagnostics,
  LlmUseCase,
};

export interface LlmCompletionRequest {
  maxTokens: number;
  system?: string;
  userMessage: string;
  /** Diagnostics tag for Kookr's own helper-LLM call sites. */
  useCase?: LlmUseCase;
  /** Optional structured output hint. Providers that don't support it silently ignore it. */
  responseFormat?: {
    type: 'json_schema';
    jsonSchema: {
      name: string;
      schema: Record<string, unknown>;
    };
  };
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

export interface LlmClient {
  /** Returns the text content of the first message, or null on failure. */
  complete(request: LlmCompletionRequest): Promise<string | null>;
  /** Returns completion text plus categorized provider-failure details. */
  completeWithFailureAudit?(request: LlmCompletionRequest): Promise<LlmCompletionAuditResult>;
  /** Human-readable provider name for logging (e.g. "groq", "anthropic"). */
  readonly provider: string;
  /** Model ID used by this client (e.g. "meta-llama/llama-4-scout-17b-16e-instruct"). */
  readonly model: string;
}
