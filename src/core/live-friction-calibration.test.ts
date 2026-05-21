import { describe, expect, test } from 'vitest';
import { AttentionQueue } from './attention-queue.js';
import { buildLiveFrictionCalibrationSnapshot } from './live-friction-calibration.js';
import type { InteractionEvent } from './interaction-log.js';
import type { Anomaly } from './types.js';

function event(overrides: InteractionEvent): InteractionEvent {
  return overrides;
}

function anomaly(type: Anomaly['type'], severity: Anomaly['severity']): Anomaly {
  return {
    type,
    severity,
    confidence: 'high',
    explanation: type,
    agentId: `${type}-agent`,
    detectedAt: new Date('2026-05-21T12:00:00.000Z'),
  };
}

describe('buildLiveFrictionCalibrationSnapshot', () => {
  test('reports skipped and false-positive findings as diagnostics-only down-weight candidates', () => {
    const events: InteractionEvent[] = [
      event({ type: 'finding_skipped', agentId: 'a1', anomalyType: 'needs_input', timestamp: '2026-05-21T12:01:00.000Z' }),
      event({ type: 'finding_resolved', agentId: 'a1', anomalyType: 'needs_input', method: 'skip', durationMs: 10_000, timestamp: '2026-05-21T12:01:00.000Z' }),
      event({ type: 'finding_skipped', agentId: 'a2', anomalyType: 'needs_input', timestamp: '2026-05-21T12:02:00.000Z' }),
      event({ type: 'finding_resolved', agentId: 'a2', anomalyType: 'needs_input', method: 'skip', durationMs: 15_000, timestamp: '2026-05-21T12:02:00.000Z' }),
      event({ type: 'finding_feedback', agentId: 'a3', anomalyType: 'permission_blocked', verdict: 'false_positive', explanation: 'already handled', timestamp: '2026-05-21T12:03:00.000Z' }),
      event({ type: 'finding_resolved', agentId: 'a3', anomalyType: 'permission_blocked', method: 'false_positive', durationMs: 0, timestamp: '2026-05-21T12:03:00.000Z' }),
    ];

    const snapshot = buildLiveFrictionCalibrationSnapshot(events, [
      { agentId: 'a4', anomalyType: 'needs_input' },
    ], undefined, new Date('2026-05-21T12:04:00.000Z'));

    expect(snapshot).toMatchObject({
      schemaVersion: 'live-friction-calibration.v1',
      mode: 'diagnostics_only',
      routingMutationAllowed: false,
      generatedAt: '2026-05-21T12:04:00.000Z',
      interactionCount: 6,
      activeFindingCount: 1,
    });
    expect(snapshot.signals.map((signal) => signal.kind)).toEqual([
      'skipped_finding',
      'false_positive_feedback',
    ]);
    expect(snapshot.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'down-weight:needs_input',
        target: 'needs_input',
        direction: 'down_weight_candidate',
        affectedActiveAgentIds: ['a4'],
        wouldMutateQueue: false,
      }),
      expect.objectContaining({
        id: 'false-positive:permission_blocked',
        target: 'permission_blocked',
        direction: 'down_weight_candidate',
        wouldMutateQueue: false,
      }),
    ]));
  });

  test('reports repeated direct interventions without findings as a coverage-gap candidate', () => {
    const events: InteractionEvent[] = [
      event({ type: 'agent_launched', agentId: 'a1', taskPrompt: 'one', timestamp: '2026-05-21T12:00:00.000Z' }),
      event({ type: 'user_input', agentId: 'a1', content: 'are you stuck?', timestamp: '2026-05-21T12:01:00.000Z' }),
      event({ type: 'agent_launched', agentId: 'a2', taskPrompt: 'two', timestamp: '2026-05-21T12:02:00.000Z' }),
      event({ type: 'user_input', agentId: 'a2', content: 'please report status', timestamp: '2026-05-21T12:03:00.000Z' }),
    ];

    const snapshot = buildLiveFrictionCalibrationSnapshot(events);

    expect(snapshot.signals).toEqual([
      expect.objectContaining({
        kind: 'direct_intervention_without_finding',
        target: 'unclassified_intervention',
        count: 2,
        agentCount: 2,
      }),
    ]);
    expect(snapshot.recommendations).toEqual([
      expect.objectContaining({
        id: 'coverage-gap:direct-intervention',
        direction: 'coverage_gap_candidate',
        wouldMutateQueue: false,
      }),
    ]);
  });

  test('does not count ordinary responses to active findings as missed-finding interventions', () => {
    const events: InteractionEvent[] = [
      event({ type: 'user_input', agentId: 'a1', content: 'continue', timestamp: '2026-05-21T12:01:00.000Z' }),
      event({ type: 'finding_resolved', agentId: 'a1', anomalyType: 'needs_input', method: 'input', durationMs: 10_000, timestamp: '2026-05-21T12:01:00.000Z' }),
      event({ type: 'user_input', agentId: 'a2', content: 'approve', timestamp: '2026-05-21T12:02:00.000Z' }),
      event({ type: 'finding_resolved', agentId: 'a2', anomalyType: 'permission_blocked', method: 'input', durationMs: 15_000, timestamp: '2026-05-21T12:02:00.000Z' }),
    ];

    const snapshot = buildLiveFrictionCalibrationSnapshot(events);

    expect(snapshot.signals).not.toContainEqual(expect.objectContaining({
      kind: 'direct_intervention_without_finding',
    }));
    expect(snapshot.recommendations).not.toContainEqual(expect.objectContaining({
      id: 'coverage-gap:direct-intervention',
    }));
  });

  test('counts later same-agent input after a resolved finding as a direct intervention', () => {
    const events: InteractionEvent[] = [
      event({ type: 'user_input', agentId: 'a1', content: 'continue', timestamp: '2026-05-21T12:01:00.000Z' }),
      event({ type: 'finding_resolved', agentId: 'a1', anomalyType: 'needs_input', method: 'input', durationMs: 10_000, timestamp: '2026-05-21T12:01:00.000Z' }),
      event({ type: 'user_input', agentId: 'a1', content: 'are you still stuck?', timestamp: '2026-05-21T12:05:00.000Z' }),
      event({ type: 'user_input', agentId: 'a2', content: 'status please', timestamp: '2026-05-21T12:06:00.000Z' }),
    ];

    const snapshot = buildLiveFrictionCalibrationSnapshot(events);

    expect(snapshot.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'direct_intervention_without_finding',
        count: 2,
      }),
    ]));
    expect(snapshot.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'coverage-gap:direct-intervention',
      }),
    ]));
  });

  test('reports repeated snoozes as diagnostics-only defer candidates', () => {
    const events: InteractionEvent[] = [
      event({ type: 'finding_snoozed', agentId: 'a1', anomalyType: 'needs_input', durationMs: 5 * 60_000, timestamp: '2026-05-21T12:01:00.000Z' }),
      event({ type: 'finding_resolved', agentId: 'a1', anomalyType: 'needs_input', method: 'snooze', durationMs: 10_000, timestamp: '2026-05-21T12:01:00.000Z' }),
      event({ type: 'finding_snoozed', agentId: 'a2', anomalyType: 'needs_input', durationMs: 10 * 60_000, timestamp: '2026-05-21T12:02:00.000Z' }),
      event({ type: 'finding_resolved', agentId: 'a2', anomalyType: 'needs_input', method: 'snooze', durationMs: 20_000, timestamp: '2026-05-21T12:02:00.000Z' }),
    ];

    const snapshot = buildLiveFrictionCalibrationSnapshot(events, [
      { agentId: 'a3', anomalyType: 'needs_input' },
    ]);

    expect(snapshot.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'snoozed_finding',
        target: 'needs_input',
        count: 2,
        agentCount: 2,
        evidence: expect.arrayContaining([
          'needs_input snoozed on a1 for 5min',
          'needs_input snoozed on a2 for 10min',
        ]),
      }),
    ]));
    expect(snapshot.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'defer:needs_input',
        direction: 'defer_candidate',
        affectedActiveAgentIds: ['a3'],
        evidence: expect.arrayContaining([
          'Snoozed on a1 for 5min',
          'Snoozed on a2 for 10min',
        ]),
        wouldMutateQueue: false,
      }),
    ]));
  });

  test('can inspect active queue context without reordering or suppressing findings', () => {
    const queue = new AttentionQueue();
    queue.enqueue('info-agent', anomaly('needs_input', 'info'));
    queue.enqueue('warning-agent', anomaly('permission_blocked', 'warning'));
    queue.skip('warning-agent');

    const before = queue.getAll().map((entry) => entry.agentId);
    const inspected = queue.inspectActive().map((entry) => ({
      agentId: entry.agentId,
      anomalyType: entry.anomaly.type,
    }));
    const snapshot = buildLiveFrictionCalibrationSnapshot([], inspected);
    const after = queue.getAll().map((entry) => entry.agentId);

    expect(snapshot.routingMutationAllowed).toBe(false);
    expect(snapshot.activeFindingCount).toBe(2);
    expect(after).toEqual(before);
  });
});
