import type { TaskStatus } from './task-status.js';
import {
  ATTENTION_MISS_SEED_SCHEMA_VERSION,
  stableSeedId,
  type AttentionMissSeedV1,
} from './attention-miss-review-contracts.js';

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
