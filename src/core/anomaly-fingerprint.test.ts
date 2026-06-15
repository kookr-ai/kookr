import { describe, expect, test } from 'vitest';
import { anomalyFingerprint, stableAnomalyExplanation } from './anomaly-fingerprint.js';
import type { Anomaly } from './types.js';

const FIXED_TIME = new Date('2026-01-01T00:00:00Z');

function anomaly(overrides: Partial<Anomaly> & Pick<Anomaly, 'type' | 'explanation'>): Anomaly {
  return {
    agentId: 'agent-1',
    type: overrides.type,
    severity: 'warning',
    explanation: overrides.explanation,
    detectedAt: FIXED_TIME,
    ...overrides,
  };
}

describe('anomalyFingerprint', () => {
  test('returns golden fingerprints for representative detector and watchdog anomalies', () => {
    const cases: Array<{ anomaly: Anomaly; fingerprint: string }> = [
      {
        anomaly: anomaly({
          type: 'needs_input',
          subType: 'stop',
          severity: 'info',
          explanation: 'Agent is waiting for input. Last message: "Ready for next task"',
        }),
        fingerprint: 'needs_input:stop:Agent is waiting for input. Last message: "Ready for next task"',
      },
      {
        anomaly: anomaly({
          type: 'needs_input',
          subType: 'ask_user_question',
          explanation: 'Agent is asking a question via AskUserQuestion tool',
        }),
        fingerprint: 'needs_input:ask_user_question:Agent is asking a question via AskUserQuestion tool',
      },
      {
        anomaly: anomaly({
          type: 'permission_blocked',
          explanation: 'Agent is blocked on permission for tool: Bash',
        }),
        fingerprint: 'permission_blocked::Agent is blocked on permission for tool: Bash',
      },
      {
        anomaly: anomaly({
          type: 'repeated_error',
          explanation: 'Same error repeated 3 times: "ECONNRESET"',
          count: 3,
        }),
        fingerprint: 'repeated_error::Same error repeated: "ECONNRESET"',
      },
      {
        anomaly: anomaly({
          type: 'budget_exceeded',
          severity: 'critical',
          explanation: 'Task cost $12.00 exceeds 2x threshold ($10.00). Reactive alert - may overshoot by one turn.',
        }),
        fingerprint: 'budget_exceeded::Task cost $12.00 exceeds 2x threshold ($10.00). Reactive alert - may overshoot by one turn.',
      },
      {
        anomaly: anomaly({
          type: 'hook_disconnected',
          explanation: 'No hook events for 90s.',
        }),
        fingerprint: 'hook_disconnected::',
      },
    ];

    expect(cases.map(({ anomaly: input }) => anomalyFingerprint(input))).toEqual(
      cases.map(({ fingerprint }) => fingerprint),
    );
  });

  test('is stable across volatile anomaly metadata', () => {
    const first = anomaly({
      agentId: 'session-a',
      type: 'permission_blocked',
      explanation: 'Agent is blocked on permission for tool: Edit',
      detectedAt: new Date('2026-01-01T00:00:00Z'),
      confidence: 'medium',
      eventId: 'event-a',
      relatedFindingIds: ['child-a'],
    });
    const second = anomaly({
      agentId: 'session-b',
      type: 'permission_blocked',
      explanation: 'Agent is blocked on permission for tool: Edit',
      detectedAt: new Date('2026-01-01T00:05:00Z'),
      confidence: 'high',
      eventId: 'event-b',
      relatedFindingIds: ['child-b'],
      transcriptContext: {
        lastAssistantMessage: {
          excerpt: 'Different volatile transcript context',
          truncated: false,
          readAtOffset: 42,
        },
      },
    });

    expect(anomalyFingerprint(second)).toBe(anomalyFingerprint(first));
  });

  test('is sensitive to anomaly type, subtype, and stable explanation', () => {
    const stop = anomaly({
      type: 'needs_input',
      subType: 'stop',
      severity: 'info',
      explanation: 'Agent is waiting for input. Last message: "Done"',
    });
    const askUserQuestion = anomaly({
      type: 'needs_input',
      subType: 'ask_user_question',
      explanation: 'Agent is asking a question via AskUserQuestion tool',
    });
    const blockedEdit = anomaly({
      type: 'permission_blocked',
      explanation: 'Agent is blocked on permission for tool: Edit',
    });
    const blockedBash = anomaly({
      type: 'permission_blocked',
      explanation: 'Agent is blocked on permission for tool: Bash',
    });
    const apiErrorWithSameExplanation = anomaly({
      type: 'api_error',
      explanation: blockedBash.explanation,
    });

    expect(anomalyFingerprint(askUserQuestion)).not.toBe(anomalyFingerprint(stop));
    expect(anomalyFingerprint(blockedBash)).not.toBe(anomalyFingerprint(blockedEdit));
    expect(anomalyFingerprint(apiErrorWithSameExplanation)).not.toBe(anomalyFingerprint(blockedBash));
  });

  test('normalizes repeated-error counts without collapsing distinct messages', () => {
    const threeResets = anomaly({
      type: 'repeated_error',
      explanation: 'Same error repeated 3 times: "ECONNRESET"',
      count: 3,
    });
    const fiveResets = anomaly({
      type: 'repeated_error',
      explanation: 'Same error repeated 5 times: "ECONNRESET"',
      count: 5,
    });
    const threeTimeouts = anomaly({
      type: 'repeated_error',
      explanation: 'Same error repeated 3 times: "ETIMEDOUT"',
      count: 3,
    });

    expect(anomalyFingerprint(fiveResets)).toBe(anomalyFingerprint(threeResets));
    expect(anomalyFingerprint(threeTimeouts)).not.toBe(anomalyFingerprint(threeResets));
  });
});

describe('stableAnomalyExplanation', () => {
  test('removes only the volatile repeated-error count prefix', () => {
    expect(stableAnomalyExplanation({
      type: 'repeated_error',
      explanation: 'Same error repeated 3 times: "ECONNRESET"',
    })).toBe('Same error repeated: "ECONNRESET"');

    expect(stableAnomalyExplanation({
      type: 'repeated_error',
      explanation: 'Same error repeated 15 times: "ECONNRESET"',
    })).toBe('Same error repeated: "ECONNRESET"');
  });

  test('blanks stale-agent and hook-disconnected explanations', () => {
    expect(stableAnomalyExplanation({
      type: 'stale_agent',
      explanation: 'No activity for 10s - agent may be stuck or disconnected',
    })).toBe('');

    expect(stableAnomalyExplanation({
      type: 'hook_disconnected',
      explanation: 'No hook events received for 90s',
    })).toBe('');
  });

  test('preserves casing and whitespace for other anomaly explanations', () => {
    expect(stableAnomalyExplanation({
      type: 'permission_blocked',
      explanation: ' Agent is blocked on permission for tool: Bash ',
    })).toBe(' Agent is blocked on permission for tool: Bash ');
  });
});
