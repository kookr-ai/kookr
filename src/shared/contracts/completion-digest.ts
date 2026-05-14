export interface CompletionDigest {
  bullets: string[];
  filesChanged: string[];
  testSummary?: string;
  branch?: string;
  commits?: string[];
  prUrls?: string[];
  verificationCommands?: string[];
  tokenUsage?: CompletionTokenUsage;
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
