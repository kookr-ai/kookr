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
  /**
   * End-to-end correlation id (#705). Minted when the triggering hook event is
   * ingested ({@link mintEventId} in `hook-ingestion.ts`) and threaded unchanged
   * into the finding so operators have a single lineage id tying a hook event →
   * the detector that fired → this finding → the emitted alert. Stable across
   * durable replay and WebSocket reconnect — it is never regenerated downstream.
   * Absent on findings not derived from a hook event (e.g. watchdog-only
   * liveness verdicts).
   */
  eventId?: string;
  /** Descendant active finding ids linked to this likely root; active finding ids are agent ids. */
  relatedFindingIds?: string[];
  /** Likely root finding id when this finding is a descendant symptom; active finding ids are agent ids. */
  rootCauseFindingId?: string;
  /** True when this finding is the highest-priority ancestor finding for related descendants. */
  likelyRootCause?: boolean;
  /** Human-readable basis for why the active findings were linked. */
  causalityReason?: string;
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
