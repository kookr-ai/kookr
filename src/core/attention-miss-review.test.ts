import { describe, expect, test } from 'vitest';
import type { InteractionEvent } from './interaction-log.js';
import type { ReflectionReport } from './friction-analyzer.js';
import {
  buildAttentionMissSeedsFromFrictionReport,
  buildAttentionMissSeedsFromInteractionEvents,
  sampleAttentionMissWindows,
  type AttentionMissSamplingWindow,
} from './attention-miss-review.js';

const T0 = '2026-05-19T10:00:00.000Z';

describe('attention miss review seeds', () => {
  test('normalizes operator interventions with task correlation and lookback metadata', () => {
    const events: InteractionEvent[] = [
      { type: 'agent_launched', agentId: 'agent-1', taskPrompt: 'build', timestamp: '2026-05-19T09:59:00.000Z' },
      { type: 'user_input', agentId: 'agent-1', content: 'The tests are looping, inspect the last failure', timestamp: T0 },
    ];

    const seeds = buildAttentionMissSeedsFromInteractionEvents(events, {
      lookbackMs: 5 * 60_000,
      taskIdForAgent: (agentId) => agentId === 'agent-1' ? 'task-1' : null,
    });

    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({
      schemaVersion: 'attention-miss-seed.v1',
      target: { taskId: 'task-1', agentId: 'agent-1' },
      source: 'interaction_log',
      eventSeq: 2,
      reason: 'operator_intervention_without_finding',
      confidence: 'high',
      reviewable: true,
      lookback: {
        durationMs: 300_000,
        startedAt: '2026-05-19T09:55:00.000Z',
        endedAt: T0,
        priorFindingState: 'none',
      },
      correlation: { taskScoped: true, eventCount: 2 },
    });
  });

  test('keeps ambiguous operator messages low confidence without task correlation', () => {
    const seeds = buildAttentionMissSeedsFromInteractionEvents([
      { type: 'user_input', agentId: 'agent-1', content: 'status?', timestamp: T0 },
    ], {
      lookbackMs: 60_000,
      taskIdForAgent: () => null,
    });

    expect(seeds[0]).toMatchObject({
      target: { taskId: null, agentId: 'agent-1' },
      confidence: 'low',
      reviewable: false,
      correlation: { taskScoped: false },
      notes: ['operator message is ambiguous', 'missing task correlation'],
    });
  });

  test('records prior finding state inside the lookback window', () => {
    const seeds = buildAttentionMissSeedsFromInteractionEvents([
      { type: 'finding_resolved', agentId: 'agent-1', anomalyType: 'needs_input', method: 'auto_clear', durationMs: 10_000, timestamp: '2026-05-19T09:59:30.000Z' },
      { type: 'user_input', agentId: 'agent-1', content: 'please continue', timestamp: T0 },
    ], {
      lookbackMs: 60_000,
      taskIdForAgent: () => 'task-1',
    });

    expect(seeds[0]).toMatchObject({
      confidence: 'low',
      reviewable: false,
      lookback: { priorFindingState: 'resolved_in_lookback' },
    });
  });

  test('normalizes detection-gap friction findings into false-negative seeds', () => {
    const report: ReflectionReport = {
      sessionStart: '2026-05-19T09:00:00.000Z',
      sessionEnd: T0,
      agentCount: 1,
      totalInterventions: 1,
      anomalyBreakdown: {},
      findings: [
        {
          name: 'Intervention without finding',
          category: 'detection_gap',
          evidence: ['User sent "continue" to agent-1 (no active finding)'],
          frequency: 1,
          suggestedFix: 'Detector may be missing a pattern',
        },
      ],
    };

    const seeds = buildAttentionMissSeedsFromFrictionReport(report, {
      lookbackMs: 10 * 60_000,
      target: { taskId: 'task-1', agentId: 'agent-1' },
    });

    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({
      source: 'friction_analyzer',
      reason: 'friction_detection_gap',
      confidence: 'medium',
      reviewable: true,
      correlation: { taskScoped: true, eventCount: 1 },
    });
  });
});

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
