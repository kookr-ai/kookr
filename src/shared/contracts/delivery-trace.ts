import type { AnomalySeverity, AnomalyType } from './anomalies.js';

export const DELIVERY_TRACE_SCHEMA_VERSION = 'delivery-trace.v1';

export type DeliveryTraceStage =
  | 'admitted'
  | 'suppressed'
  | 'webhook_attempt'
  | 'webhook_result';

export type DeliveryTraceSuppressionReason =
  | 'queue_dedupe'
  | 'queue_snoozed'
  | 'webhook_disabled'
  | 'below_min_severity'
  | 'webhook_dedupe';

export type DeliveryTraceWebhookOutcome = 'success' | 'failure';

export interface DeliveryTraceRecord {
  id: string;
  timestamp: string;
  findingId: string;
  correlationId: string;
  agentId: string;
  fingerprintHash: string;
  anomalyType?: AnomalyType;
  severity?: AnomalySeverity;
  eventId?: string;
  stage: DeliveryTraceStage;
  reason?: DeliveryTraceSuppressionReason;
  attempt?: number;
  httpStatus?: number;
  error?: string;
  outcome?: DeliveryTraceWebhookOutcome;
}

export interface DeliveryTraceFilter {
  findingId?: string;
  correlationId?: string;
  agentId?: string;
  fingerprintHash?: string;
}

export interface DeliveryTraceSnapshot {
  schemaVersion: typeof DELIVERY_TRACE_SCHEMA_VERSION;
  maxRecords: number;
  totalRecorded: number;
  records: DeliveryTraceRecord[];
}
