import { describe, expect, test } from 'vitest';
import {
  sampleAttentionMissWindows,
  type AttentionMissSamplingWindow,
} from './attention-miss-review.js';

const T0 = '2026-05-19T10:00:00.000Z';

describe('attention miss window sampling', () => {
  test('samples non-finding task windows across strata and counts diagnostics separately', () => {
    const windows: AttentionMissSamplingWindow[] = [
      window({ taskId: 'task-1', agentId: 'agent-1', taskState: 'inProgress', detectorOpportunity: 'present', terminalActivity: 'active' }),
      window({ taskId: 'task-2', agentId: 'agent-2', taskState: 'pending', detectorOpportunity: 'low', terminalActivity: 'recent' }),
      window({ taskId: null, agentId: 'agent-3', taskState: 'inProgress', detectorOpportunity: 'present', terminalActivity: 'active', recentFindingState: 'recent_resolved' }),
      window({ taskId: 'task-5', agentId: 'agent-5', taskState: 'inProgress', detectorOpportunity: 'present', terminalActivity: 'active', recentFindingState: 'recent_snoozed' }),
      window({ taskId: 'task-4', agentId: 'agent-4', taskState: 'inProgress', detectorOpportunity: 'present', terminalActivity: 'active', activeFinding: true }),
    ];

    const result = sampleAttentionMissWindows(windows, {
      maxSamples: 10,
      maxPerStratum: 1,
      reviewedCandidateIds: new Set(),
      missConfirmedCandidateIds: new Set(),
    });

    expect(result.counters).toEqual({
      eligible: 4,
      sampled: 4,
      reviewable: 2,
      unreviewable: 2,
      reviewed: 0,
      miss_confirmed: 0,
    });
    expect(Object.keys(result.strata)).toEqual([
      'inProgress|active|present|established|none',
      'pending|recent|low|established|none',
      'inProgress|active|present|established|recent_resolved',
      'inProgress|active|present|established|recent_snoozed',
    ]);
    expect(result.seeds.map((seed) => seed.reason)).toEqual([
      'stratified_non_finding_window',
      'stratified_non_finding_window',
      'stratified_non_finding_window',
      'stratified_non_finding_window',
    ]);
  });

  test('tracks reviewed and miss_confirmed counters from reviewed seed ids', () => {
    const first = sampleAttentionMissWindows([
      window({ taskId: 'task-1', agentId: 'agent-1', taskState: 'inProgress', detectorOpportunity: 'present', terminalActivity: 'active' }),
    ], { maxSamples: 1, maxPerStratum: 1 });
    const seedId = first.seeds[0]!.seedId;

    const result = sampleAttentionMissWindows([
      window({ taskId: 'task-1', agentId: 'agent-1', taskState: 'inProgress', detectorOpportunity: 'present', terminalActivity: 'active' }),
    ], {
      maxSamples: 1,
      maxPerStratum: 1,
      reviewedCandidateIds: new Set([seedId]),
      missConfirmedCandidateIds: new Set([seedId]),
    });

    expect(result.counters.reviewed).toBe(1);
    expect(result.counters.miss_confirmed).toBe(1);
  });

  test('enforces sample and per-stratum caps', () => {
    const result = sampleAttentionMissWindows([
      window({ taskId: 'task-1', agentId: 'agent-1', taskState: 'inProgress', terminalActivity: 'active' }),
      window({ taskId: 'task-2', agentId: 'agent-2', taskState: 'inProgress', terminalActivity: 'active' }),
      window({ taskId: 'task-3', agentId: 'agent-3', taskState: 'pending', terminalActivity: 'recent', detectorOpportunity: 'low' }),
      window({ taskId: 'task-4', agentId: 'agent-4', taskState: 'open', terminalActivity: 'none', detectorOpportunity: 'none' }),
    ], {
      maxSamples: 2,
      maxPerStratum: 1,
    });

    expect(result.counters).toEqual({
      eligible: 4,
      sampled: 2,
      reviewable: 1,
      unreviewable: 1,
      reviewed: 0,
      miss_confirmed: 0,
    });
    expect(result.seeds.map((seed) => seed.target.agentId)).toEqual(['agent-1', 'agent-4']);
  });
});

function window(overrides: Partial<AttentionMissSamplingWindow>): AttentionMissSamplingWindow {
  return {
    taskId: 'task-1',
    agentId: 'agent-1',
    taskState: 'inProgress',
    windowStart: '2026-05-19T09:59:00.000Z',
    windowEnd: T0,
    terminalActivity: 'recent',
    detectorOpportunity: 'present',
    taskAgeBucket: 'established',
    recentFindingState: 'none',
    activeFinding: false,
    ...overrides,
  };
}
