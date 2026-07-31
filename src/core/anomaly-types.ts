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
 * Publish/merge state reconciliation verdict (#1148).
 *
 * `classifyPublishMergeReconciliation` in `anomaly-detector.ts` classifies a
 * would-be publish/merge `needs_input` blocker into one of these before
 * `reconcilePublishMergeBlocker` returns it to the caller:
 * - `connector-failure-but-publishable`: a GitHub connector/integration call
 *   (e.g. an MCP `create_branch`) failed, but normal local `git`/`gh`
 *   credentials can still publish — suppressed, not a real blocker.
 * - `pr-green-mergeable`: the tracked PR is green and mergeable and the task
 *   authorizes merge-after-implementation — a structured merge-ready signal,
 *   not an operator question.
 * - `real-blocker`: neither reconciling condition applies; the operator
 *   blocker stands.
 */
export type ReconciliationClassification =
  | 'connector-failure-but-publishable'
  | 'pr-green-mergeable'
  | 'real-blocker';

/**
 * Reason code accompanying a {@link ReconciliationClassification}, one per
 * branch of `classifyPublishMergeReconciliation` in `anomaly-detector.ts`.
 */
export type PublishMergeReconciliationReasonCode =
  | 'pr_green_mergeable_auto_merge_authorized'
  | 'connector_failed_local_credentials_ok'
  | 'connector_failed_local_credentials_unavailable'
  | 'no_reconciling_evidence';

/**
 * Evidence a caller gathers (local git/gh credentials, tracked PR
 * mergeability/check state, task merge authorization) before asking
 * `classifyPublishMergeReconciliation` to classify a would-be publish/merge
 * blocker. Gathering this evidence requires live git/gh/GitHub I/O, which is
 * outside this package's pure-detector layer, so callers with that access
 * (e.g. the agent lifecycle / reconciliation service) build it and pass it
 * into `evaluateAnomalies`/`detectAnomalies`.
 */
export interface PublishMergeReconciliationEvidence {
  /** A connector/integration failure (e.g. GitHub MCP create_branch) was observed. */
  connectorFailureDetected: boolean;
  /** Raw evidence text for the connector failure, kept for dashboard/log explanation. */
  connectorFailureText?: string;
  /** Normal git/gh credentials in this worktree can publish (e.g. `git push --dry-run` / `gh auth status` succeeded). */
  localCredentialsCanPublish: boolean;
  /** The tracked PR reports GitHub `mergeable: MERGEABLE` and all checks completed successfully. */
  prGreenAndMergeable: boolean;
  /** The task/continuation envelope authorizes merging automatically once green. */
  mergeAfterImplementation: boolean;
}

/**
 * Reconciliation context attached to an emitted finding so the dashboard and
 * logs can explain why a publish/merge blocker was suppressed, replaced with
 * a merge-ready signal, or left in place as a real blocker (#1148).
 */
export interface AnomalyReconciliation {
  classification: ReconciliationClassification;
  reasonCode: PublishMergeReconciliationReasonCode;
  evidence: PublishMergeReconciliationEvidence;
}

/**
 * Confidence level for shadow-detection verdicts. Only used by shadow strategies -
 * the real detector's anomalies are implicitly high-confidence.
 */
export type AnomalyConfidence = 'high' | 'medium' | 'low';

export interface FindingTranscriptExcerpt {
  excerpt: string;
  truncated: boolean;
  readAtOffset: number;
}

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
  /** Optional transcript-derived context attached to active findings behind a feature flag. */
  transcriptContext?: {
    lastAssistantMessage: FindingTranscriptExcerpt;
  };
  /**
   * Publish/merge state reconciliation context (#1148). Present when this
   * finding's would-be publish/merge blocker was run through
   * `reconcilePublishMergeBlocker` — either because it was replaced with a
   * merge-ready signal (`pr-green-mergeable`) or because it survived
   * reconciliation as a genuine blocker (`real-blocker`). Absent when
   * reconciliation was not applicable (no publish/merge evidence supplied,
   * or the finding is unrelated to publish/merge).
   */
  reconciliation?: AnomalyReconciliation;
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
