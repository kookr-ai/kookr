import type { AgentEvent } from './agent-events.js';

export type AnomalyType =
  | 'needs_input'
  | 'permission_blocked'
  | 'repeated_error'
  | 'merge_conflict'
  | 'stale_agent'
  | 'hook_disconnected'
  | 'hook_missing'
  | 'tmux_unresponsive'
  | 'api_error'
  | 'budget_exceeded';

export type AnomalySeverity = 'info' | 'warning' | 'critical';

export type AnomalyConfidence = 'high' | 'medium' | 'low';

export interface Anomaly {
  agentId: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  explanation: string;
  detectedAt: Date;
  count?: number;
  subType?: 'stop' | 'ask_user_question';
  confidence?: AnomalyConfidence;
}

export type FindingEvidenceObservationSource = 'event' | 'watchdog_tick';

export type FindingEvidenceVerdict =
  | 'pending'
  | 'supports_finding'
  | 'transient_too_fast'
  | 'possible_false_positive'
  | 'resolved';

export interface FindingEvidenceObservation {
  sampledAt: string;
  ageMs: number;
  source: FindingEvidenceObservationSource;
  anomalyStillPresent: boolean;
  lastEventType: AgentEvent['type'] | null;
  eventCount: number;
  lastEventSeq?: number;
  paneHash?: string;
  paneChangedSincePrevious?: boolean;
  paneExcerpt?: string;
}

export interface FindingEvidenceAuditRecord {
  id: string;
  agentId: string;
  anomalyType: AnomalyType;
  anomalySubType?: Anomaly['subType'];
  explanation: string;
  detectedAt: string;
  updatedAt: string;
  status: 'active' | 'resolved';
  verdict: FindingEvidenceVerdict;
  observations: FindingEvidenceObservation[];
  notes: string[];
}

export interface PersistedAnomaly {
  agentId: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  explanation: string;
  detectedAt: string;
  count?: number;
  subType?: 'stop' | 'ask_user_question';
}

export interface LegacyPersistedSnooze {
  taskId: string;
  anomaly: PersistedAnomaly;
  expiresAt: number;
  reason?: string;
}

export interface PersistedSnooze {
  taskId: string;
  agentId?: string;
  kind: 'finding' | 'task';
  anomaly?: PersistedAnomaly;
  expiresAt: number;
  createdAt: number;
  expiredPendingRestore?: boolean;
  reason?: string;
}
