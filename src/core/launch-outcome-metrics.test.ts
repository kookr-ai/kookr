import { afterEach, describe, expect, it } from 'vitest';
import {
  LaunchOutcomeMetrics,
  PASTE_READINESS_TIMEOUT_REASON,
  bindLaunchOutcomeMetrics,
  classifyLaunchFailureReason,
  emptyLaunchOutcomeMetricsSnapshot,
  recordBoundLaunchOutcome,
} from './launch-outcome-metrics.js';

afterEach(() => {
  bindLaunchOutcomeMetrics(undefined);
});

describe('LaunchOutcomeMetrics', () => {
  it('tracks success/failure rates per agent type', () => {
    const metrics = new LaunchOutcomeMetrics();
    metrics.record({ agentType: 'grok-build', outcome: 'success' });
    metrics.record({ agentType: 'grok-build', outcome: 'failure', reason: 'handshake_timeout' });
    metrics.record({ agentType: 'grok-build', outcome: 'failure', reason: 'handshake_timeout' });
    metrics.record({ agentType: 'claude-code', outcome: 'success' });
    metrics.record({ agentType: 'claude-code', outcome: 'success' });

    const snap = metrics.snapshot();
    expect(snap.schemaVersion).toBe('launch-outcome-metrics.v1');
    expect(snap.totalAttempts).toBe(5);
    expect(snap.totalSuccesses).toBe(3);
    expect(snap.totalFailures).toBe(2);
    expect(snap.byAgentType).toEqual([
      {
        agentType: 'grok-build',
        attempts: 3,
        successes: 1,
        failures: 2,
        failureRate: 2 / 3,
        lastFailureReason: 'handshake_timeout',
      },
      {
        agentType: 'claude-code',
        attempts: 2,
        successes: 2,
        failures: 0,
        failureRate: 0,
      },
    ]);
  });

  it('ignores blank agent types and truncates long failure reasons', () => {
    const metrics = new LaunchOutcomeMetrics();
    metrics.record({ agentType: '   ', outcome: 'failure' });
    metrics.record({
      agentType: 'grok-build',
      outcome: 'failure',
      reason: 'x'.repeat(500),
    });
    const [row] = metrics.snapshot().byAgentType;
    expect(row.agentType).toBe('grok-build');
    expect(row.lastFailureReason).toHaveLength(200);
  });

  it('empty snapshot is stable for the diagnostics fallback', () => {
    expect(emptyLaunchOutcomeMetricsSnapshot()).toEqual({
      schemaVersion: 'launch-outcome-metrics.v1',
      totalAttempts: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      byAgentType: [],
    });
  });
});

describe('classifyLaunchFailureReason', () => {
  it('maps known launch error messages', () => {
    expect(
      classifyLaunchFailureReason(
        new Error('[grok-build-adapter] Grok did not acknowledge the initial prompt within 10000ms'),
      ),
    ).toBe('handshake_timeout');
    expect(
      classifyLaunchFailureReason(
        new Error('Initial prompt submission was not confirmed for session s1 after 3 confirmation attempt(s)'),
      ),
    ).toBe('handshake_timeout');
    expect(
      classifyLaunchFailureReason(new Error('agent-boot did not complete within 30s')),
    ).toBe('agent_boot_timeout');
    expect(classifyLaunchFailureReason(new Error('Grok authentication expired'))).toBe('launch_refused');
    expect(classifyLaunchFailureReason(new Error('disk full'))).toBe('launch_error');
    expect(
      classifyLaunchFailureReason(
        new Error('[agent-launch] paste-readiness wait timed out for s1 after 8000ms; delivering anyway'),
      ),
    ).toBe(PASTE_READINESS_TIMEOUT_REASON);
  });
});

describe('paste_readiness_timeout launch-outcome samples (issue #3310)', () => {
  it('snapshots the reason so GET /api/diagnostics/launch-outcomes can show it', () => {
    const metrics = new LaunchOutcomeMetrics();
    metrics.record({
      agentType: 'claude-code',
      outcome: 'failure',
      reason: PASTE_READINESS_TIMEOUT_REASON,
    });
    expect(metrics.snapshot().byAgentType[0]).toEqual({
      agentType: 'claude-code',
      attempts: 1,
      successes: 0,
      failures: 1,
      failureRate: 1,
      lastFailureReason: 'paste_readiness_timeout',
    });
  });

  it('records through the process bind used by the paste-readiness wait', () => {
    const metrics = new LaunchOutcomeMetrics();
    bindLaunchOutcomeMetrics(metrics);
    recordBoundLaunchOutcome({
      agentType: 'claude-code',
      outcome: 'failure',
      reason: PASTE_READINESS_TIMEOUT_REASON,
    });
    expect(metrics.snapshot().byAgentType[0]?.lastFailureReason).toBe(
      PASTE_READINESS_TIMEOUT_REASON,
    );
  });

  it('is a no-op when nothing is bound', () => {
    expect(() =>
      recordBoundLaunchOutcome({
        agentType: 'claude-code',
        outcome: 'failure',
        reason: PASTE_READINESS_TIMEOUT_REASON,
      }),
    ).not.toThrow();
  });
});
