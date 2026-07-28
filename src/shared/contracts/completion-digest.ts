export interface CompletionDigest {
  bullets: string[];
  filesChanged: string[];
  testSummary?: string;
  branch?: string;
  commits?: string[];
  prUrls?: string[];
  /**
   * Merge commit SHA of the task's delivered PR, when it merged (issue #1596).
   * Distinct from `commits` (the branch's own commits): this is the commit on
   * the base branch, the containment key the per-schedule ROI rollup tests
   * against the last smoke-gate-passed prod SHA to tell `merged` from
   * `live-verified` delivery.
   */
  mergeCommit?: string;
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
