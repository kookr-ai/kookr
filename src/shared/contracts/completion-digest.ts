export interface CompletionDigest {
  bullets: string[];
  filesChanged: string[];
  testSummary?: string;
  branch?: string;
  commits?: string[];
  prUrls?: string[];
  verificationCommands?: string[];
  tokenUsage?: CompletionTokenUsage;
  /** Advisory LLM-assisted check of user-provided completion criteria. */
  criteriaVerdict?: CriteriaCompletionVerdict;
}

export type CompletionTokenUsageQuality =
  | 'available'
  | 'unavailable'
  | 'unknown-pricing'
  | 'parse-error'
  | 'rollout-not-found'
  | 'rollout-abandoned';

export interface CompletionTokenUsage {
  source: 'transcript' | 'codex-rollout';
  quality: CompletionTokenUsageQuality;
  model?: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  reason?: string;
}

export type CriteriaVerdictStatus = 'pass' | 'fail' | 'unknown';

export type CriteriaVerdictSource =
  | 'llm'
  | 'llm-unavailable'
  | 'llm-error'
  | 'parse-error'
  | 'no-event-window';

export interface CriteriaVerdictItem {
  criterion: string;
  verdict: CriteriaVerdictStatus;
  reason: string;
}

export interface CriteriaCompletionVerdict {
  items: CriteriaVerdictItem[];
  summary: {
    pass: number;
    fail: number;
    unknown: number;
  };
  source: CriteriaVerdictSource;
  evaluatedAt: string;
  provider?: string;
  model?: string;
  error?: string;
}
