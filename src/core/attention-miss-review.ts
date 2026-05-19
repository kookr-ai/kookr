import { createHmac } from 'node:crypto';
import type { InteractionEvent } from './interaction-log.js';
import type { FrictionFinding, ReflectionReport } from './friction-analyzer.js';
import type { TaskStatus } from './task-status.js';

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

export interface InteractionMissSeedOptions {
  lookbackMs: number;
  taskIdForAgent: (agentId: string) => string | null;
}

export interface FrictionMissSeedOptions {
  lookbackMs: number;
  target: { taskId: string | null; agentId: string };
}

export type AttentionMissTerminalActivity = 'none' | 'recent' | 'active';
export type AttentionMissDetectorOpportunity = 'none' | 'low' | 'present';
export type AttentionMissTaskAgeBucket = 'new' | 'established' | 'long_running';
export type AttentionMissRecentFindingState = 'none' | 'recent_resolved' | 'recent_snoozed' | 'recent_skipped';

export interface AttentionMissSamplingWindow {
  taskId: string | null;
  agentId: string;
  taskState: TaskStatus;
  windowStart: string;
  windowEnd: string;
  terminalActivity: AttentionMissTerminalActivity;
  detectorOpportunity: AttentionMissDetectorOpportunity;
  taskAgeBucket: AttentionMissTaskAgeBucket;
  recentFindingState: AttentionMissRecentFindingState;
  activeFinding: boolean;
}

export interface AttentionMissSamplingCounters {
  eligible: number;
  sampled: number;
  reviewable: number;
  unreviewable: number;
  reviewed: number;
  miss_confirmed: number;
}

export interface AttentionMissSamplingResult {
  counters: AttentionMissSamplingCounters;
  strata: Record<string, AttentionMissSamplingCounters>;
  seeds: AttentionMissSeedV1[];
}

export interface AttentionMissSamplingOptions {
  maxSamples: number;
  maxPerStratum: number;
  reviewedCandidateIds?: ReadonlySet<string>;
  missConfirmedCandidateIds?: ReadonlySet<string>;
}

const AMBIGUOUS_OPERATOR_MESSAGE = /^(ok|okay|yes|no|done|thanks|status|what|why|how|when|where|is|are|can|could|should|will)\b/i;

export function buildAttentionMissSeedsFromInteractionEvents(
  events: InteractionEvent[],
  options: InteractionMissSeedOptions,
): AttentionMissSeedV1[] {
  const sorted = [...events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const seeds: AttentionMissSeedV1[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const event = sorted[index]!;
    if (event.type !== 'user_input') continue;

    const taskId = options.taskIdForAgent(event.agentId);
    const lookback = priorFindingState(sorted, event.agentId, event.timestamp, options.lookbackMs);
    const ambiguous = AMBIGUOUS_OPERATOR_MESSAGE.test(event.content.trim());
    const taskScoped = taskId !== null;
    const confidence: AttentionMissConfidence = !taskScoped || lookback.priorFindingState !== 'none'
      ? 'low'
      : ambiguous
        ? 'medium'
        : 'high';
    const reviewable = taskScoped && lookback.priorFindingState === 'none';
    seeds.push({
      schemaVersion: ATTENTION_MISS_SEED_SCHEMA_VERSION,
      seedId: stableSeedId('interaction', event.agentId, event.timestamp, String(index + 1)),
      target: { taskId, agentId: event.agentId },
      source: 'interaction_log',
      timestamp: event.timestamp,
      eventSeq: index + 1,
      reason: 'operator_intervention_without_finding',
      confidence,
      reviewable,
      lookback,
      correlation: { taskScoped, eventCount: sorted.length },
      notes: [
        ...(ambiguous ? ['operator message is ambiguous'] : []),
        ...(taskScoped ? [] : ['missing task correlation']),
      ],
    });
  }
  return seeds;
}

export function buildAttentionMissSeedsFromFrictionReport(
  report: ReflectionReport,
  options: FrictionMissSeedOptions,
): AttentionMissSeedV1[] {
  return report.findings
    .filter(isMissRelevantFrictionFinding)
    .map((finding, index) => {
      // Empty reports normally have no findings and never reach this branch.
      // Keep malformed reports deterministic instead of stamping "now".
      const endedAt = report.sessionEnd || new Date(0).toISOString();
      const startedAt = new Date(Math.max(0, Date.parse(endedAt) - options.lookbackMs)).toISOString();
      const taskScoped = options.target.taskId !== null;
      return {
        schemaVersion: ATTENTION_MISS_SEED_SCHEMA_VERSION,
        seedId: stableSeedId('friction', options.target.agentId, endedAt, finding.name, String(index)),
        target: options.target,
        source: 'friction_analyzer',
        timestamp: endedAt,
        reason: finding.category === 'detection_gap' ? 'friction_detection_gap' : 'friction_repeated_correction',
        confidence: taskScoped && finding.category === 'detection_gap' ? 'medium' : 'low',
        reviewable: taskScoped && finding.category === 'detection_gap',
        lookback: {
          durationMs: options.lookbackMs,
          startedAt,
          endedAt,
          priorFindingState: 'unknown',
        },
        correlation: { taskScoped, eventCount: finding.frequency },
        notes: finding.evidence.slice(0, 3),
      } satisfies AttentionMissSeedV1;
    });
}

export function sampleAttentionMissWindows(
  windows: AttentionMissSamplingWindow[],
  options: AttentionMissSamplingOptions,
): AttentionMissSamplingResult {
  const counters = emptyAttentionMissSamplingCounters();
  const strata: Record<string, AttentionMissSamplingCounters> = {};
  const byStratum = new Map<string, AttentionMissSamplingWindow[]>();

  for (const window of windows) {
    if (window.activeFinding) continue;
    counters.eligible += 1;
    const key = stratumKey(window);
    byStratum.set(key, [...(byStratum.get(key) ?? []), window]);
    strata[key] = strata[key] ?? emptyAttentionMissSamplingCounters();
    strata[key].eligible += 1;
  }

  const seeds: AttentionMissSeedV1[] = [];
  for (const [key, stratumWindows] of [...byStratum.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const ordered = stratumWindows.sort((a, b) => a.windowStart.localeCompare(b.windowStart) || a.agentId.localeCompare(b.agentId));
    for (const window of ordered.slice(0, Math.max(0, options.maxPerStratum))) {
      if (seeds.length >= Math.max(0, options.maxSamples)) break;
      const seed = seedFromSamplingWindow(window);
      seeds.push(seed);
      counters.sampled += 1;
      strata[key]!.sampled += 1;
      const targetCounters = seed.reviewable ? 'reviewable' : 'unreviewable';
      counters[targetCounters] += 1;
      strata[key]![targetCounters] += 1;
      if (options.reviewedCandidateIds?.has(seed.seedId)) {
        counters.reviewed += 1;
        strata[key]!.reviewed += 1;
      }
      if (options.missConfirmedCandidateIds?.has(seed.seedId)) {
        counters.miss_confirmed += 1;
        strata[key]!.miss_confirmed += 1;
      }
    }
  }

  return { counters, strata, seeds };
}

function priorFindingState(
  events: InteractionEvent[],
  agentId: string,
  timestamp: string,
  lookbackMs: number,
): AttentionMissSeedV1['lookback'] {
  const endedAtMs = Date.parse(timestamp);
  const startedAtMs = Math.max(0, endedAtMs - lookbackMs);
  const relevant = events.filter((event) => {
    if (!('agentId' in event) || event.agentId !== agentId) return false;
    const eventMs = Date.parse(event.timestamp);
    return eventMs >= startedAtMs && eventMs < endedAtMs;
  });
  let priorFindingState: AttentionMissPriorFindingState = 'none';
  for (const event of relevant) {
    if (event.type === 'finding_snoozed' || event.type === 'finding_skipped') priorFindingState = 'active_in_lookback';
    if (event.type === 'finding_resolved' && priorFindingState === 'none') priorFindingState = 'resolved_in_lookback';
  }
  return {
    durationMs: lookbackMs,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: new Date(endedAtMs).toISOString(),
    priorFindingState,
  };
}

function isMissRelevantFrictionFinding(finding: FrictionFinding): boolean {
  return finding.category === 'detection_gap' || finding.category === 'repeated_correction';
}

function seedFromSamplingWindow(window: AttentionMissSamplingWindow): AttentionMissSeedV1 {
  const taskScoped = window.taskId !== null;
  const reviewable = taskScoped && window.detectorOpportunity !== 'none' && window.recentFindingState === 'none';
  return {
    schemaVersion: ATTENTION_MISS_SEED_SCHEMA_VERSION,
    seedId: stableSeedId('window', window.taskId ?? 'no-task', window.agentId, window.windowStart, window.windowEnd),
    target: { taskId: window.taskId, agentId: window.agentId },
    source: 'sampling_frame',
    timestamp: window.windowEnd,
    reason: 'stratified_non_finding_window',
    confidence: reviewable && window.detectorOpportunity === 'present' ? 'medium' : 'low',
    reviewable,
    lookback: {
      durationMs: Math.max(0, Date.parse(window.windowEnd) - Date.parse(window.windowStart)),
      startedAt: window.windowStart,
      endedAt: window.windowEnd,
      priorFindingState: window.recentFindingState === 'none' ? 'none' : 'resolved_in_lookback',
    },
    correlation: { taskScoped, eventCount: window.terminalActivity === 'none' ? 0 : 1 },
    notes: [
      `taskState=${window.taskState}`,
      `terminalActivity=${window.terminalActivity}`,
      `detectorOpportunity=${window.detectorOpportunity}`,
      `taskAge=${window.taskAgeBucket}`,
      `recentFinding=${window.recentFindingState}`,
    ],
  };
}

function stratumKey(window: AttentionMissSamplingWindow): string {
  return [
    window.taskState,
    window.terminalActivity,
    window.detectorOpportunity,
    window.taskAgeBucket,
    window.recentFindingState,
  ].join('|');
}

export function emptyAttentionMissSamplingCounters(): AttentionMissSamplingCounters {
  return {
    eligible: 0,
    sampled: 0,
    reviewable: 0,
    unreviewable: 0,
    reviewed: 0,
    miss_confirmed: 0,
  };
}

function stableSeedId(...parts: string[]): string {
  return `miss-${createHmac('sha256', Buffer.alloc(32, 0)).update(parts.join('\0')).digest('hex').slice(0, 16)}`;
}
