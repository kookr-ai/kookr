import { createHash } from 'node:crypto';
import type { Anomaly } from './types.js';
import type {
  DeliveryTraceFilter,
  DeliveryTraceRecord,
  DeliveryTraceSnapshot,
  DeliveryTraceSuppressionReason,
  DeliveryTraceWebhookOutcome,
} from '../shared/contracts/delivery-trace.js';
import { DELIVERY_TRACE_SCHEMA_VERSION } from '../shared/contracts/delivery-trace.js';

const DEFAULT_MAX_DELIVERY_TRACE_RECORDS = 500;

export interface DeliveryTraceFindingInput {
  agentId: string;
  anomaly: Anomaly;
  fingerprint: string;
}

export interface DeliveryTraceRecorder {
  recordAdmitted(event: DeliveryTraceFindingInput): void;
  recordSuppressed(event: DeliveryTraceFindingInput, reason: DeliveryTraceSuppressionReason): void;
  recordWebhookAttempt(event: DeliveryTraceFindingInput, attempt: number): void;
  recordWebhookResult(event: DeliveryTraceFindingInput, input: {
    attempt: number;
    outcome: DeliveryTraceWebhookOutcome;
    httpStatus?: number;
    error?: string;
  }): void;
}

export interface DeliveryTraceReader {
  snapshot(filter?: DeliveryTraceFilter): DeliveryTraceSnapshot;
}

export class DeliveryTraceBuffer implements DeliveryTraceRecorder, DeliveryTraceReader {
  private readonly maxRecords: number;
  private readonly now: () => Date;
  private records: DeliveryTraceRecord[] = [];
  private totalRecorded = 0;

  constructor(opts: { maxRecords?: number; now?: () => Date } = {}) {
    this.maxRecords = Math.max(0, Math.floor(opts.maxRecords ?? DEFAULT_MAX_DELIVERY_TRACE_RECORDS));
    this.now = opts.now ?? (() => new Date());
  }

  recordAdmitted(event: DeliveryTraceFindingInput): void {
    this.append(event, { stage: 'admitted' });
  }

  recordSuppressed(event: DeliveryTraceFindingInput, reason: DeliveryTraceSuppressionReason): void {
    this.append(event, { stage: 'suppressed', reason });
  }

  recordWebhookAttempt(event: DeliveryTraceFindingInput, attempt: number): void {
    this.append(event, { stage: 'webhook_attempt', attempt });
  }

  recordWebhookResult(
    event: DeliveryTraceFindingInput,
    input: { attempt: number; outcome: DeliveryTraceWebhookOutcome; httpStatus?: number; error?: string },
  ): void {
    this.append(event, {
      stage: 'webhook_result',
      attempt: input.attempt,
      outcome: input.outcome,
      ...(input.httpStatus !== undefined ? { httpStatus: input.httpStatus } : {}),
      ...(input.error ? { error: input.error } : {}),
    });
  }

  snapshot(filter: DeliveryTraceFilter = {}): DeliveryTraceSnapshot {
    return {
      schemaVersion: DELIVERY_TRACE_SCHEMA_VERSION,
      maxRecords: this.maxRecords,
      totalRecorded: this.totalRecorded,
      records: this.records.filter((record) => matchesFilter(record, filter)),
    };
  }

  private append(
    event: DeliveryTraceFindingInput,
    fields: Pick<DeliveryTraceRecord, 'stage'> & Partial<DeliveryTraceRecord>,
  ): void {
    this.totalRecorded += 1;
    if (this.maxRecords === 0) return;

    const findingId = buildFindingId(event);
    const fingerprintHash = hashFingerprint(event.fingerprint);
    const record: DeliveryTraceRecord = {
      id: `delivery-trace-${this.totalRecorded}`,
      timestamp: this.now().toISOString(),
      findingId,
      correlationId: event.anomaly.eventId ?? findingId,
      agentId: event.agentId,
      fingerprintHash,
      anomalyType: event.anomaly.type,
      severity: event.anomaly.severity,
      ...(event.anomaly.eventId ? { eventId: event.anomaly.eventId } : {}),
      ...fields,
    };

    this.records.push(record);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
  }
}

function buildFindingId(event: DeliveryTraceFindingInput): string {
  return `${event.agentId}:${hashFingerprint(event.fingerprint)}`;
}

function hashFingerprint(fingerprint: string): string {
  return createHash('sha256').update(fingerprint).digest('hex');
}

function matchesFilter(record: DeliveryTraceRecord, filter: DeliveryTraceFilter): boolean {
  return (!filter.findingId || record.findingId === filter.findingId)
    && (!filter.correlationId || record.correlationId === filter.correlationId)
    && (!filter.agentId || record.agentId === filter.agentId)
    && (!filter.fingerprintHash || record.fingerprintHash === filter.fingerprintHash);
}
