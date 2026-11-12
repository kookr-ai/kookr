import type { LucyTurnEnd } from './lucy-turn.js';
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

/** Provider/model currently skipped by FallbackLlmClient after an auth, HTTP 402 Payment Required, or HTTP 410 Gone failure. */
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
  /** Providers currently in the auth / HTTP 402 Payment Required / HTTP 410 Gone cool-down window. */
  pausedProviders: HelperLlmPausedProvider[];
  /**
   * Lifetime count of provider network attempts refused because the process-wide
   * attempt budget was exhausted (free-tier 429 / cascade thrash suppression).
   */
  stormsSuppressed: number;
  /** Live view of the process-wide provider-attempt budget window. */
  providerAttemptBudget: HelperLlmProviderAttemptBudget;
}

/**
 * Counters for Lucy's operator conversation (`POST /api/lucy/turn`) since the server
 * started. Kept apart from {@link HelperLlmDiagnosticsSnapshot}: another model, another
 * price, and a person waiting on the answer.
 */
export interface LucyOperatorDiagnosticsSnapshot {
  schemaVersion: 'lucy-operator-diagnostics.v1';
  generatedAt: number;
  /** Finished turns, however they ended. */
  turns: number;
  /** Turns per ending: `answered`, `step_cap`, `time_cap`, `token_cap`, `aborted`, `error`. */
  byEnd: Partial<Record<LucyTurnEnd, number>>;
  /** Model calls over all turns (a turn makes one to four). */
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** What the provider charged over all turns, in US dollars. Counts only turns where it reported a price. */
  costUsd: number;
  turnsWithCost: number;
  averageTurnMs: number;
  maxTurnMs: number;
  /** Average time to the first piece of her reply; null when no turn produced text. */
  averageFirstTextMs: number | null;
}

export interface DiagnosticReport {
  timestamp: number;
  findings: DiagnosticFinding[];
  helperLlm?: HelperLlmDiagnosticsSnapshot;
  /** Present once the operator conversation has been used or is enabled; absent on older servers. */
  lucyOperator?: LucyOperatorDiagnosticsSnapshot;
  persistenceHealth?: PersistenceHealthSnapshot;
}
