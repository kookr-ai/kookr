import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { DeliveryTraceBuffer } from './delivery-trace.js';
import type { Anomaly } from './types.js';
import { DELIVERY_TRACE_SCHEMA_VERSION } from '../shared/contracts/delivery-trace.js';

const FIXED_TIME = new Date('2026-06-13T10:00:00.000Z');

function anomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    agentId: 'agent-1',
    type: 'permission_blocked',
    severity: 'warning',
    explanation: 'blocked',
    detectedAt: FIXED_TIME,
    ...overrides,
  };
}

function fingerprintHash(fingerprint: string): string {
  return createHash('sha256').update(fingerprint).digest('hex');
}

function findingInput(
  overrides: {
    agentId?: string;
    fingerprint?: string;
    anomaly?: Partial<Anomaly>;
  } = {},
) {
  const agentId = overrides.agentId ?? 'agent-1';
  return {
    agentId,
    fingerprint: overrides.fingerprint ?? 'permission_blocked::blocked',
    anomaly: anomaly({ agentId, ...overrides.anomaly }),
  };
}

describe('DeliveryTraceBuffer', () => {
  test('records admitted events and returns them from snapshot', () => {
    let t = 0;
    const buffer = new DeliveryTraceBuffer({
      maxRecords: 10,
      now: () => new Date(FIXED_TIME.getTime() + t++ * 1000),
    });

    const input = findingInput({ anomaly: { eventId: 'evt-1' } });
    buffer.recordAdmitted(input);

    const hash = fingerprintHash(input.fingerprint);
    const snap = buffer.snapshot();

    expect(snap).toEqual({
      schemaVersion: DELIVERY_TRACE_SCHEMA_VERSION,
      maxRecords: 10,
      totalRecorded: 1,
      records: [
        {
          id: 'delivery-trace-1',
          timestamp: FIXED_TIME.toISOString(),
          findingId: `agent-1:${hash}`,
          correlationId: 'evt-1',
          agentId: 'agent-1',
          fingerprintHash: hash,
          anomalyType: 'permission_blocked',
          severity: 'warning',
          eventId: 'evt-1',
          stage: 'admitted',
        },
      ],
    });
  });

  test('evicts oldest records when maxRecords is exceeded', () => {
    let t = 0;
    const buffer = new DeliveryTraceBuffer({
      maxRecords: 2,
      now: () => new Date(FIXED_TIME.getTime() + t++ * 1000),
    });

    buffer.recordAdmitted(findingInput({ agentId: 'a', fingerprint: 'fp-a' }));
    buffer.recordSuppressed(findingInput({ agentId: 'b', fingerprint: 'fp-b' }), 'queue_dedupe');
    buffer.recordWebhookAttempt(findingInput({ agentId: 'c', fingerprint: 'fp-c' }), 1);

    const snap = buffer.snapshot();
    expect(snap.maxRecords).toBe(2);
    expect(snap.totalRecorded).toBe(3);
    expect(snap.records).toHaveLength(2);
    expect(snap.records.map((r) => r.agentId)).toEqual(['b', 'c']);
    expect(snap.records.map((r) => r.stage)).toEqual(['suppressed', 'webhook_attempt']);
    expect(snap.records[0]?.reason).toBe('queue_dedupe');
    expect(snap.records[1]?.attempt).toBe(1);
  });

  test('maxRecords === 0 is a no-op for storage but still counts totalRecorded', () => {
    const buffer = new DeliveryTraceBuffer({
      maxRecords: 0,
      now: () => FIXED_TIME,
    });

    buffer.recordAdmitted(findingInput());
    buffer.recordWebhookResult(findingInput(), {
      attempt: 1,
      outcome: 'success',
      httpStatus: 200,
    });

    expect(buffer.snapshot()).toEqual({
      schemaVersion: DELIVERY_TRACE_SCHEMA_VERSION,
      maxRecords: 0,
      totalRecorded: 2,
      records: [],
    });
  });

  test('snapshot filters by findingId, correlationId, agentId, and fingerprintHash', () => {
    let t = 0;
    const buffer = new DeliveryTraceBuffer({
      maxRecords: 10,
      now: () => new Date(FIXED_TIME.getTime() + t++ * 1000),
    });

    const alpha = findingInput({
      agentId: 'alpha',
      fingerprint: 'fp-alpha',
      anomaly: { eventId: 'corr-alpha' },
    });
    const beta = findingInput({
      agentId: 'beta',
      fingerprint: 'fp-beta',
      anomaly: { eventId: 'corr-beta' },
    });
    const gamma = findingInput({
      agentId: 'gamma',
      fingerprint: 'fp-gamma',
      // no eventId → correlationId falls back to findingId
    });

    buffer.recordAdmitted(alpha);
    buffer.recordSuppressed(beta, 'webhook_disabled');
    buffer.recordWebhookResult(gamma, {
      attempt: 3,
      outcome: 'failure',
      httpStatus: 502,
      error: 'upstream timeout',
    });

    const alphaHash = fingerprintHash('fp-alpha');
    const alphaFindingId = `alpha:${alphaHash}`;
    const gammaHash = fingerprintHash('fp-gamma');
    const gammaFindingId = `gamma:${gammaHash}`;

    expect(buffer.snapshot({ agentId: 'beta' }).records.map((r) => r.agentId)).toEqual(['beta']);
    expect(buffer.snapshot({ correlationId: 'corr-alpha' }).records).toEqual([
      expect.objectContaining({ agentId: 'alpha', correlationId: 'corr-alpha' }),
    ]);
    expect(buffer.snapshot({ findingId: alphaFindingId }).records).toEqual([
      expect.objectContaining({ findingId: alphaFindingId, stage: 'admitted' }),
    ]);
    expect(buffer.snapshot({ fingerprintHash: gammaHash }).records).toEqual([
      expect.objectContaining({
        agentId: 'gamma',
        correlationId: gammaFindingId,
        fingerprintHash: gammaHash,
        stage: 'webhook_result',
        outcome: 'failure',
        attempt: 3,
        httpStatus: 502,
        error: 'upstream timeout',
      }),
    ]);
    // Empty filter returns all retained records
    expect(buffer.snapshot({}).records).toHaveLength(3);
    // Non-matching filter returns none
    expect(buffer.snapshot({ agentId: 'missing' }).records).toEqual([]);
  });

  test('floors negative maxRecords to 0 and defaults when omitted', () => {
    const zeroed = new DeliveryTraceBuffer({ maxRecords: -3, now: () => FIXED_TIME });
    zeroed.recordAdmitted(findingInput());
    expect(zeroed.snapshot().maxRecords).toBe(0);
    expect(zeroed.snapshot().records).toEqual([]);

    const def = new DeliveryTraceBuffer({ now: () => FIXED_TIME });
    def.recordAdmitted(findingInput());
    expect(def.snapshot().maxRecords).toBe(500);
    expect(def.snapshot().records).toHaveLength(1);
  });
});
