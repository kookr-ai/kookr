// Anomaly detection output
export type AnomalyType =
  | 'needs_input'
  | 'permission_blocked'
  | 'repeated_error'
  | 'merge_conflict'
  | 'stale_agent'
  | 'hook_disconnected'
  | 'hook_missing'
  | 'hook_parse_degraded'
  | 'tmux_unresponsive'
  | 'api_error'
  | 'budget_exceeded';

/**
 * Runtime list of every {@link AnomalyType}. Use this where the union must be
 * enumerated at runtime (e.g. the docs drift guard in `anomaly-types.test.ts`,
 * which checks that `docs/reference/findings.md` documents every type).
 *
 * The two compile-time guards below keep this array in lockstep with the
 * `AnomalyType` union:
 * - `satisfies readonly AnomalyType[]` rejects typos or extra entries.
 * - the `_AssertNever` alias rejects any union member missing from the array.
 */
export const ANOMALY_TYPES = [
  'needs_input',
  'permission_blocked',
  'repeated_error',
  'merge_conflict',
  'stale_agent',
  'hook_disconnected',
  'hook_missing',
  'hook_parse_degraded',
  'tmux_unresponsive',
  'api_error',
  'budget_exceeded',
] as const satisfies readonly AnomalyType[];

// Fails to compile if a member is added to AnomalyType but not to ANOMALY_TYPES.
type _AssertNever<T extends never> = T;
type _AnomalyTypesExhaustive = _AssertNever<
  Exclude<AnomalyType, (typeof ANOMALY_TYPES)[number]>
>;

export type AnomalySeverity = 'info' | 'warning' | 'critical';

/**
 * Confidence level for shadow-detection verdicts. Only used by shadow strategies -
 * the real detector's anomalies are implicitly high-confidence.
 */
export type AnomalyConfidence = 'high' | 'medium' | 'low';

export interface Anomaly {
  agentId: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  explanation: string;
  detectedAt: Date;
  count?: number;
  /** Discriminates needs_input sub-types (stop vs explicit ask_user_question). */
  subType?: 'stop' | 'ask_user_question';
  /** Shadow-only: strategy confidence for offline precision analysis. */
  confidence?: AnomalyConfidence;
  /**
   * End-to-end correlation id (#705). Minted when the triggering hook event is
   * ingested ({@link mintEventId} in `hook-ingestion.ts`) and threaded unchanged
   * into the finding so operators have a single lineage id tying a hook event →
   * the detector that fired → this finding → the emitted alert. Stable across
   * durable replay and WebSocket reconnect — never regenerated downstream.
   * Absent on findings not derived from a hook event (e.g. watchdog-only
   * liveness verdicts). Kept in sync with `shared/contracts/anomalies.ts`.
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

/** Serialized anomaly for persistence - detectedAt is ISO string, not Date. */
export interface PersistedAnomaly {
  agentId: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  explanation: string;
  detectedAt: string;
  count?: number;
  subType?: 'stop' | 'ask_user_question';
}

/** Persisted snooze state - stored in the task file envelope. */
export interface LegacyPersistedSnooze {
  taskId: string;
  anomaly: PersistedAnomaly;
  expiresAt: number; // ms since epoch
  reason?: string;
}

export interface PersistedSnooze {
  taskId: string;
  agentId?: string;
  kind: 'finding' | 'task';
  anomaly?: PersistedAnomaly;
  expiresAt: number; // ms since epoch
  createdAt: number; // ms since epoch
  expiredPendingRestore?: boolean;
  reason?: string;
}
