import { describe, expect, test, vi } from 'vitest';
import { FindingEvidenceAuditor } from './finding-evidence-audit.js';
import type { AgentEvent, Anomaly } from './types.js';

function anomaly(type: Anomaly['type'], detectedAt = new Date('2026-05-18T10:00:00.000Z')): Anomaly {
  return {
    agentId: 'agent-1',
    type,
    severity: 'warning',
    explanation: `Agent has ${type}`,
    detectedAt,
  };
}

function stop(seq = 1): AgentEvent {
  return { type: 'stop', sessionId: 's1', lastMessage: 'Waiting', eventSeq: seq };
}

describe('FindingEvidenceAuditor', () => {
  test('captures initial and watchdog observations for a supported finding', () => {
    const auditor = new FindingEvidenceAuditor({ supportAgeMs: 5_000 });
    const a = anomaly('needs_input');

    auditor.observe('agent-1', a, [stop(1)], {
      source: 'event',
      now: new Date('2026-05-18T10:00:00.000Z'),
    });
    auditor.observe('agent-1', a, [stop(1)], {
      source: 'watchdog_tick',
      paneText: 'Claude is waiting for your input',
      now: new Date('2026-05-18T10:00:06.000Z'),
    });

    const [record] = auditor.getRecords();
    expect(record.status).toBe('active');
    expect(record.verdict).toBe('supports_finding');
    expect(record.observations).toHaveLength(2);
    expect(record.observations[1].paneHash).toBeDefined();
    expect(record.notes).toContain('Multiple observations still support the surfaced finding.');
  });

  test('marks quick resolution as transient timing instead of durable false positive', () => {
    const auditor = new FindingEvidenceAuditor({ transientGraceMs: 3_000 });
    const a = anomaly('needs_input');

    auditor.observe('agent-1', a, [stop(1)], {
      source: 'event',
      now: new Date('2026-05-18T10:00:00.000Z'),
    });
    auditor.observe('agent-1', null, [
      stop(1),
      { type: 'tool_use', sessionId: 's1', toolName: 'Bash', eventSeq: 2 },
    ], {
      source: 'event',
      now: new Date('2026-05-18T10:00:02.000Z'),
    });

    const [record] = auditor.getRecords();
    expect(record.status).toBe('resolved');
    expect(record.verdict).toBe('transient_too_fast');
    expect(record.observations.at(-1)?.anomalyStillPresent).toBe(false);
  });

  test('flags active finding evidence as suspicious when pane and events keep moving', () => {
    const auditor = new FindingEvidenceAuditor({ supportAgeMs: 5_000 });
    const a = anomaly('permission_blocked');
    const events: AgentEvent[] = [{ type: 'permission_request', sessionId: 's1', toolName: 'Bash', eventSeq: 1 }];

    auditor.observe('agent-1', a, events, {
      source: 'event',
      paneText: 'Permission requested',
      now: new Date('2026-05-18T10:00:00.000Z'),
    });
    auditor.observe('agent-1', a, [
      ...events,
      { type: 'tool_use', sessionId: 's1', toolName: 'Read', eventSeq: 2 },
    ], {
      source: 'watchdog_tick',
      paneText: 'Streaming new output after permission prompt',
      now: new Date('2026-05-18T10:00:08.000Z'),
    });

    const [record] = auditor.getRecords();
    expect(record.verdict).toBe('possible_false_positive');
    expect(record.observations[1].paneChangedSincePrevious).toBe(true);
    expect(record.notes.join('\n')).toContain('Latest event (tool_use) no longer matches permission_blocked');
    expect(record.notes.join('\n')).toContain('Terminal pane changed while the finding was active');
  });

  test('trailing overlay events do not make a valid finding suspicious', () => {
    const auditor = new FindingEvidenceAuditor({ supportAgeMs: 5_000 });
    const a = anomaly('permission_blocked');

    auditor.observe('agent-1', a, [
      { type: 'permission_request', sessionId: 's1', toolName: 'Bash', eventSeq: 1 },
      { type: 'notification', sessionId: 's1', notificationType: 'auth_success', message: 'ok', eventSeq: 2 },
    ], {
      source: 'watchdog_tick',
      paneText: 'Permission still pending',
      now: new Date('2026-05-18T10:00:08.000Z'),
    });

    const [record] = auditor.getRecords();
    expect(record.verdict).toBe('supports_finding');
    expect(record.observations[0].lastEventType).toBe('permission_request');
    expect(record.notes.join('\n')).not.toContain('no longer matches');
  });

  test('resolves replaced findings before tracking the next active finding', () => {
    const auditor = new FindingEvidenceAuditor({ transientGraceMs: 3_000 });
    const first = anomaly('permission_blocked');
    const second = {
      ...anomaly('needs_input', new Date('2026-05-18T10:00:02.000Z')),
      subType: 'stop' as const,
      explanation: 'Agent is waiting',
    };

    auditor.observe('agent-1', first, [
      { type: 'permission_request', sessionId: 's1', toolName: 'Bash', eventSeq: 1 },
    ], {
      source: 'event',
      now: new Date('2026-05-18T10:00:00.000Z'),
    });
    auditor.observe('agent-1', second, [stop(2)], {
      source: 'event',
      now: new Date('2026-05-18T10:00:02.000Z'),
    });

    const records = auditor.getRecords();
    expect(records).toHaveLength(2);
    expect(records[0].status).toBe('resolved');
    expect(records[0].verdict).toBe('transient_too_fast');
    expect(records[0].observations.at(-1)?.anomalyStillPresent).toBe(false);
    expect(records[1].status).toBe('active');
    expect(records[1].anomalyType).toBe('needs_input');
  });

  test('groups dynamic watchdog explanations into one active audit record', () => {
    const auditor = new FindingEvidenceAuditor({ supportAgeMs: 5_000 });

    auditor.observe('agent-1', {
      ...anomaly('stale_agent'),
      explanation: 'Agent has not produced output for 60 seconds.',
    }, [], {
      source: 'watchdog_tick',
      paneText: 'same pane',
      now: new Date('2026-05-18T10:00:00.000Z'),
    });
    auditor.observe('agent-1', {
      ...anomaly('stale_agent'),
      explanation: 'Agent has not produced output for 65 seconds.',
    }, [], {
      source: 'watchdog_tick',
      paneText: 'same pane',
      now: new Date('2026-05-18T10:00:05.000Z'),
    });

    const records = auditor.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('active');
    expect(records[0].observations).toHaveLength(2);
    expect(records[0].verdict).toBe('supports_finding');
  });

  test('does not support a finding solely from near-simultaneous duplicate samples', () => {
    const auditor = new FindingEvidenceAuditor({ supportAgeMs: 5_000 });
    const a = anomaly('stale_agent');

    auditor.observe('agent-1', a, [], {
      source: 'watchdog_tick',
      paneText: 'same pane',
      now: new Date('2026-05-18T10:00:00.000Z'),
    });
    auditor.observe('agent-1', a, [], {
      source: 'watchdog_tick',
      paneText: 'same pane',
      now: new Date('2026-05-18T10:00:00.001Z'),
    });

    const [record] = auditor.getRecords();
    expect(record.observations).toHaveLength(2);
    expect(record.verdict).toBe('pending');
  });

  test('returns review candidates sorted by update time and bounded by limit', () => {
    const auditor = new FindingEvidenceAuditor();
    for (const [agentId, type, startedAt, resolvedAt] of [
      ['agent-1', 'needs_input', '2026-05-18T10:00:00.000Z', '2026-05-18T10:00:05.000Z'],
      ['agent-2', 'permission_blocked', '2026-05-18T10:01:00.000Z', '2026-05-18T10:01:05.000Z'],
      ['agent-3', 'needs_input', '2026-05-18T10:02:00.000Z', null],
    ] as const) {
      const event = type === 'permission_blocked'
        ? { type: 'permission_request' as const, sessionId: 's1', toolName: 'Bash' }
        : stop();
      auditor.observe(agentId, { ...anomaly(type, new Date(startedAt)), agentId }, [event], {
        source: 'event',
        now: new Date(startedAt),
      });
      if (resolvedAt) {
        auditor.observe(agentId, null, [{ type: 'tool_use', sessionId: 's1', toolName: 'Read' }], {
          source: 'event',
          now: new Date(resolvedAt),
        });
      }
    }

    const candidates = auditor.getReviewCandidates(2);
    expect(candidates.map((record) => record.agentId)).toEqual(['agent-3', 'agent-2']);
  });

  test('bounds retained records', () => {
    const auditor = new FindingEvidenceAuditor({ maxRecords: 2 });
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 3; i++) {
        const now = new Date(Date.UTC(2026, 4, 18, 10, 0, i));
        auditor.observe(`agent-${i}`, { ...anomaly('needs_input', now), agentId: `agent-${i}` }, [stop(i)], {
          source: 'event',
          now,
        });
      }
      expect(auditor.getRecords()).toHaveLength(2);
      expect(auditor.getRecords().map((r) => r.agentId)).toEqual(['agent-1', 'agent-2']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps resolved records within the observation cap', () => {
    const auditor = new FindingEvidenceAuditor({
      maxObservationsPerRecord: 2,
      supportAgeMs: 1,
    });
    const a = anomaly('needs_input');

    for (let i = 0; i < 3; i++) {
      auditor.observe('agent-1', a, [stop(i + 1)], {
        source: 'watchdog_tick',
        paneText: `pane ${i}`,
        now: new Date(Date.UTC(2026, 4, 18, 10, 0, i)),
      });
    }
    auditor.observe('agent-1', null, [{ type: 'tool_use', sessionId: 's1', toolName: 'Read', eventSeq: 4 }], {
      source: 'event',
      now: new Date('2026-05-18T10:00:04.000Z'),
    });

    const [record] = auditor.getRecords();
    expect(record.status).toBe('resolved');
    expect(record.observations).toHaveLength(2);
    expect(record.observations.at(-1)?.anomalyStillPresent).toBe(false);
  });
});
