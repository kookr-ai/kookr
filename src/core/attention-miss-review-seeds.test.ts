import { describe, expect, test } from 'vitest';
import type { InteractionEvent } from './interaction-log.js';
import type { ReflectionReport } from './friction-analyzer.js';
import {
  buildAttentionMissSeedsFromFrictionReport,
  buildAttentionMissSeedsFromInteractionEvents,
} from './attention-miss-review-seeds.js';

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
