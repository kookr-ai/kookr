import type { PersistenceHealthSnapshot } from './persistence-health.js';

export type DiagnosticSeverity = 'warning' | 'critical';

export interface DiagnosticFinding {
  checkId: string;
  title: string;
  description: string;
  severity: DiagnosticSeverity;
  observed: number;
  threshold: number;
  scope: string;
}

export type HelperLlmFailureCategory =
  | 'network_timeout'
  | 'auth'
  | 'server_5xx'
  | 'malformed_response'
  | 'other';

export type LlmUseCase =
  | 'agent_speech_summary'
  | 'criteria_verdict'
  | 'finding_evidence_review'
  | 'response_suggestion'
  | 'task_naming'
  | 'task_speech_summary'
  | 'unspecified';

export interface HelperLlmDiagnosticsCounters {
  requestCount: number;
  successCount: number;
  failureCount: number;
  nullResponseCount: number;
  errorCount: number;
  abortedCount: number;
  totalLatencyMs: number;
  averageLatencyMs: number;
  maxLatencyMs: number;
  failureCategories: Partial<Record<HelperLlmFailureCategory, number>>;
}

export type HelperLlmUseCaseDiagnostics = HelperLlmDiagnosticsCounters & {
  useCase: LlmUseCase;
};

export type HelperLlmProviderDiagnostics = HelperLlmDiagnosticsCounters & {
  provider: string;
  model: string;
};

export type HelperLlmUseCaseProviderDiagnostics = HelperLlmDiagnosticsCounters & {
  useCase: LlmUseCase;
  provider: string;
  model: string;
};

/** Provider/model currently skipped by FallbackLlmClient after an auth failure. */
export interface HelperLlmPausedProvider {
  provider: string;
  model: string;
  reason: 'auth';
  pausedAt: number;
  pausedUntil: number;
  remainingMs: number;
  skipCount: number;
  lastMessage: string;
}

/**
 * Secret-free helper-LLM pause row for GET `/api/health` (issue #2641).
 * One row per paused provider. `pausedUntil` is ISO-8601. Never includes
 * API keys or raw provider error bodies.
 */
export interface HelperLlmHealthPausedEntry {
  provider: string;
  model: string;
  category: HelperLlmFailureCategory;
  pausedUntil: string;
}

/** Slim helper-LLM pause / storm view published on GET `/api/health`. */
export interface HelperLlmHealthSnapshot {
  paused: HelperLlmHealthPausedEntry[];
  stormsSuppressed: number;
}

/** Process-wide helper-LLM provider-attempt budget (issue #2083). */
export interface HelperLlmProviderAttemptBudget {
  /** Max network attempts allowed inside the sliding window (`0` = disabled). */
  limit: number;
  /** Sliding-window size in ms. */
  windowMs: number;
  /** Attempts already recorded inside the current window. */
  attemptsInWindow: number;
}

export interface HelperLlmDiagnosticsSnapshot {
  schemaVersion: 'helper-llm-diagnostics.v1';
  generatedAt: number;
  totals: HelperLlmDiagnosticsCounters;
  byUseCase: HelperLlmUseCaseDiagnostics[];
  byProvider: HelperLlmProviderDiagnostics[];
  byUseCaseProvider: HelperLlmUseCaseProviderDiagnostics[];
  /** Providers currently in the auth-failure cool-down window. */
  pausedProviders: HelperLlmPausedProvider[];
  /**
   * Lifetime count of provider network attempts refused because the process-wide
   * attempt budget was exhausted (free-tier 429 / cascade thrash suppression).
   */
  stormsSuppressed: number;
  /** Live view of the process-wide provider-attempt budget window. */
  providerAttemptBudget: HelperLlmProviderAttemptBudget;
}

export interface DiagnosticReport {
  timestamp: number;
  findings: DiagnosticFinding[];
  helperLlm?: HelperLlmDiagnosticsSnapshot;
  persistenceHealth?: PersistenceHealthSnapshot;
}
