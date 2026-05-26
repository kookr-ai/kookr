import { createHmac } from 'node:crypto';

export const ATTENTION_MISS_SEED_SCHEMA_VERSION = 'attention-miss-seed.v1';
export const ATTENTION_MISS_REVIEW_INPUT_SCHEMA_VERSION = 'attention-miss-review-input.v1';
export const ATTENTION_MISS_REVIEW_SCHEMA_VERSION = 'attention-miss-review.v1';
export const ATTENTION_MISS_REVIEW_INVALID_ATTEMPT_SCHEMA_VERSION = 'attention-miss-review-invalid-attempt.v1';
export const ATTENTION_MISS_REVIEW_PROMPT_VERSION = 'attention-miss-review-prompt.v1';

export const ATTENTION_MISS_REASONS = [
  'operator_intervention_without_finding',
  'friction_detection_gap',
  'friction_repeated_correction',
  'stratified_non_finding_window',
] as const;
export const ATTENTION_MISS_SOURCES = ['interaction_log', 'friction_analyzer', 'sampling_frame'] as const;
export const ATTENTION_MISS_CONFIDENCES = ['low', 'medium', 'high'] as const;
export const ATTENTION_MISS_PRIOR_FINDING_STATES = ['none', 'active_in_lookback', 'resolved_in_lookback', 'unknown'] as const;
export const ATTENTION_MISS_REVIEW_VERDICTS = ['miss_confirmed', 'no_miss', 'unclear'] as const;
export const ATTENTION_MISS_REVIEW_FAILURE_KINDS = [
  'empty_output',
  'malformed_json',
  'invalid_shape',
  'candidate_mismatch',
  'invalid_verdict',
  'invalid_confidence',
  'invalid_evidence_refs',
  'invalid_semantics',
  'invalid_rationale',
] as const;

export type AttentionMissReason = typeof ATTENTION_MISS_REASONS[number];
export type AttentionMissSource = typeof ATTENTION_MISS_SOURCES[number];
export type AttentionMissConfidence = typeof ATTENTION_MISS_CONFIDENCES[number];
export type AttentionMissPriorFindingState = typeof ATTENTION_MISS_PRIOR_FINDING_STATES[number];
export type AttentionMissReviewVerdict = typeof ATTENTION_MISS_REVIEW_VERDICTS[number];
export type AttentionMissReviewFailureKind = typeof ATTENTION_MISS_REVIEW_FAILURE_KINDS[number];

export interface AttentionMissSeedV1 {
  schemaVersion: typeof ATTENTION_MISS_SEED_SCHEMA_VERSION;
  seedId: string;
  target: {
    taskId: string | null;
    agentId: string;
  };
  source: AttentionMissSource;
  timestamp: string;
  eventSeq?: number;
  reason: AttentionMissReason;
  confidence: AttentionMissConfidence;
  reviewable: boolean;
  lookback: {
    durationMs: number;
    startedAt: string;
    endedAt: string;
    priorFindingState: AttentionMissPriorFindingState;
  };
  correlation: {
    taskScoped: boolean;
    eventCount: number;
  };
  notes: string[];
}

export interface AttentionMissReviewInputV1 {
  schemaVersion: typeof ATTENTION_MISS_REVIEW_INPUT_SCHEMA_VERSION;
  candidateId: string;
  candidateKind: 'false_negative';
  seed: AttentionMissSeedV1;
  evidenceRefs: string[];
  versions: {
    inputBuilder: typeof ATTENTION_MISS_REVIEW_INPUT_SCHEMA_VERSION;
    prompt: typeof ATTENTION_MISS_REVIEW_PROMPT_VERSION;
    appGitSha?: string;
  };
}

export interface AttentionMissReviewV1 {
  schemaVersion: typeof ATTENTION_MISS_REVIEW_SCHEMA_VERSION;
  candidateId: string;
  verdict: AttentionMissReviewVerdict;
  confidence: AttentionMissConfidence;
  evidenceRefs: string[];
  rationale: string;
  reviewedAt: string;
  reviewer: {
    provider: string;
    model: string;
    promptVersion: typeof ATTENTION_MISS_REVIEW_PROMPT_VERSION;
  };
}

export interface AttentionMissReviewInvalidAttemptV1 {
  schemaVersion: typeof ATTENTION_MISS_REVIEW_INVALID_ATTEMPT_SCHEMA_VERSION;
  candidateId: string;
  attemptedAt: string;
  reviewer: {
    provider: string;
    model: string;
    promptVersion: typeof ATTENTION_MISS_REVIEW_PROMPT_VERSION;
  };
  failureKind: AttentionMissReviewFailureKind;
  rawOutputHash: string;
  error: string;
}

export type AttentionMissReviewParseResult =
  | { status: 'valid'; review: AttentionMissReviewV1 }
  | { status: 'invalid_attempt'; attempt: AttentionMissReviewInvalidAttemptV1 };

export function stableSeedId(...parts: string[]): string {
  return `miss-${createHmac('sha256', Buffer.alloc(32, 0)).update(parts.join('\0')).digest('hex').slice(0, 16)}`;
}
