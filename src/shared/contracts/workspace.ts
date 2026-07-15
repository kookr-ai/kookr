export type CleanupClassification =
  | 'merged'
  | 'patch_equivalent'
  | 'unique_commits'
  | 'generated_only'
  | 'dirty'
  | 'checked_out_elsewhere'
  | 'stale_worktree'
  | 'busy'
  | 'protected'
  | 'unknown';

export type RepoPolicy = 'known_policy' | 'unknown_policy';

export interface CleanupCapabilities {
  canSafeRemove: boolean;
  canRemovePathKeepBranch: boolean;
  canReviewedDiscard: boolean;
  requiresDirtyRecovery: boolean;
  blockedReason?: string;
  defaultActionLabel: string;
  riskSummary: string;
}

export interface CleanupDirtySummary {
  modified: number;
  added: number;
  deleted: number;
  renamed: number;
  untracked: number;
}

export interface CleanupCommitSummary {
  aheadCount: number;
  behindCount: number;
  lastCommitSha?: string;
  lastCommitAuthor?: string;
  lastCommitAt?: string;
  lastCommitSubject?: string;
}

export interface CleanupCandidateAssessment {
  projectId: string;
  currentProjectId?: string;
  worktreePath?: string;
  branch: string;
  protectedBranch?: boolean;
  classification: CleanupClassification;
  reasonCode: string;
  source: string;
  baselineRef?: string;
  baselineSha?: string;
  checkedAt?: string;
  observedAt: string;
  recoveryGuidance: string;
  capabilities: CleanupCapabilities;
  commitSummary?: CleanupCommitSummary;
  dirtySummary?: CleanupDirtySummary;
  enrichmentFailed?: true;
  headShortSha?: string;
}

export type AttemptType = 'preflight' | 'cleanup' | 'diagnostic';
export type AttemptStatus = 'running' | 'passed' | 'blocked' | 'timed_out' | 'cancelled' | 'superseded' | 'completed';
export type AttemptDisposition =
  | 'passed'
  | 'blocked'
  | 'path_removed_branch_retained'
  | 'prune_failed'
  | 'branch_delete_failed'
  | 'completed'
  | 'manual_intervention_required';

export interface WorkspaceAttemptRecord {
  attemptId: string;
  type: AttemptType;
  projectId: string;
  worktreePath?: string;
  branch?: string;
  baselineRef?: string;
  baselineSha?: string;
  reasonCode: string;
  source: string;
  observedAt: string;
  startedAt: string;
  status: AttemptStatus;
  finishedAt?: string;
  lastProgressAt?: string;
  timeoutAt?: string;
  disposition: AttemptDisposition;
  evidenceSummary: string;
  stderrSummary?: string;
  correlatedTaskId?: string;
  correlatedSessionId?: string;
  requestedDeleteBranch?: boolean;
  requestedDiscardDirtyState?: boolean;
  reviewFingerprint?: string;
  sweepRunId?: string;
}

export interface WorktreeLease {
  worktreePath: string;
  ownerId: string;
  acquiredAt: string;
  lastHeartbeatAt: string;
}

export interface CleanupFileSample {
  path: string;
  status: string;
}

export interface CleanupCandidateDetail {
  projectId: string;
  worktreePath: string;
  branch: string;
  protectedBranch?: boolean;
  classification: CleanupClassification;
  reasonCode: string;
  branchRefOid?: string;
  headOid?: string;
  baselineOid?: string;
  fingerprint: string;
  dirtySummary?: CleanupDirtySummary;
  dirtyFilesSample?: CleanupFileSample[];
  commitSummary?: CleanupCommitSummary;
  capabilities: CleanupCapabilities;
}

export type CleanupResultDisposition =
  | 'completed'
  | 'path_removed_branch_retained'
  | 'prune_failed'
  | 'branch_delete_failed';

export type CleanupRetainedReason = 'ref_changed' | 'user_requested_keep_branch';
export type CleanupErrorKind = 'prune_failed' | 'branch_delete_failed' | 'manual_intervention_required';

export interface CleanupResultSummary {
  branch: string;
  disposition: CleanupResultDisposition;
  pathRemoved: boolean;
  branchRemoved: boolean;
  retainedReason?: CleanupRetainedReason;
  errorKind?: CleanupErrorKind;
  recoveryRef?: string;
}

export interface CleanupDiagnosticLaunch {
  worktreePath: string;
  taskId: string;
  queued: boolean;
}

export interface WorkspaceView {
  projectId: string;
  displayName: string;
  policy: RepoPolicy;
  repoPath?: string;
  candidates: CleanupCandidateAssessment[];
  recentAttempts: WorkspaceAttemptRecord[];
  activeLeases: WorktreeLease[];
}

// --- Sweep Report (disk-aware diagnosis, RFC sweep-worktree-ux PR 2) ---

/**
 * Which of the four report buckets a worktree row belongs to. Buckets cover
 * all ten {@link CleanupClassification} values plus the two removal outcomes.
 *
 * - `removed` — sweep reclaimed the path (any removed-disposition summary).
 * - `removal_failed` — the `git worktree remove` itself failed; still on disk.
 * - `probably_safe` — clean `unique_commits`, stale (>threshold). Path removal
 *   keeps the branch and all commits. Pre-selected for PR 3 bulk remove unless
 *   `hasSensitiveIgnored`.
 * - `needs_call` — dirty, generated_only, clean-but-recent, non-prunable stale.
 * - `blocked` — busy / protected / checked_out_elsewhere / unknown; collapsed
 *   to a count, non-actionable.
 */
export type SweepReportBucket =
  | 'removed'
  | 'removal_failed'
  | 'probably_safe'
  | 'needs_call'
  | 'blocked';

export interface SweepReportRow {
  projectId: string;
  worktreePath: string;
  branch: string;
  classification: CleanupClassification;
  reasonCode: string;
  bucket: SweepReportBucket;
  /**
   * On-disk footprint (upper bound) in bytes from `du -sk`. `null` means the
   * measurement failed or timed out ("size unknown"); the row stays actionable.
   * Labeled an upper bound because `du` counts hardlinked/CAS package-store
   * content at full size — per-worktree sizes sharing a store must NOT be
   * summed as additive freed disk.
   */
  footprintBytes: number | null;
  /**
   * Git-index mtime (ms since epoch) — the "last touched" staleness signal
   * (`.git/worktrees/<id>/index`). `null` when unreadable; a missing or
   * future-dated value forces the row to `needs_call` (fail safe).
   */
  lastTouchedMs: number | null;
  /** One-line plain-language reason shown in the row. */
  reason: string;
  /** Removal disposition for `removed` / `removal_failed` rows. */
  disposition?: AttemptDisposition;
  /**
   * Probably-safe only: worktree holds gitignored files NOT matched by the
   * known-regenerable allowlist (e.g. `.env`, a local dev DB). Such rows get
   * the strongest confirm wording and are not pre-selected in PR 3's bulk.
   */
  hasSensitiveIgnored?: boolean;
  /** Probably-safe only: sample of sensitive gitignored paths. */
  ignoredSample?: string[];
  /**
   * Probably-safe only: optimistic-concurrency fingerprint captured at report
   * time via `hydrateCleanupCandidateDetail`. Optional so a PR 3 revert needs
   * no PR 2 shape change; PR 3's bulk carries it back for re-validation.
   */
  fingerprint?: string;
}

export interface SweepReportBucketSummary {
  count: number;
  /** Sum of KNOWN footprints only (upper bound); null-footprint rows excluded. */
  footprintBytesUpperBound: number;
  /** Rows whose footprint is unknown (`du` failed) — so the headline is not silently understated. */
  unknownFootprintCount: number;
}

/**
 * A project whose classification timed out (or errored) before it could be
 * analyzed. `notAnalyzedCount` is the cheap `git worktree list` count captured
 * BEFORE the timeout guard, so the loud banner shows a real N.
 */
export interface SweepReportNotAnalyzed {
  projectId: string;
  code: 'timeout' | 'error';
  notAnalyzedCount: number;
}

export interface SweepReport {
  runId: string;
  generatedAt: string;
  /** Staleness threshold in days used to bucket probably-safe (default 14). */
  thresholdDays: number;
  rows: SweepReportRow[];
  buckets: Record<SweepReportBucket, SweepReportBucketSummary>;
  /** Projects that could not be analyzed — loud "not analyzed — N worktrees" banner. */
  notAnalyzed: SweepReportNotAnalyzed[];
  /**
   * True when this report was reconstructed from the attempt ledger on
   * reconnect (Removed / removal-failed buckets only; live buckets are not
   * persisted). Lets the UI note the report is a partial post-hoc view.
   */
  reconstructedFromLedger?: boolean;
}

// --- Probably-safe bulk reclaim (RFC sweep-worktree-ux PR 3) ---

/**
 * One selected Probably-safe row the client asks the server to reclaim
 * (remove path, keep branch). Carries only what the keep-branch bulk needs:
 * the project + worktree + branch identity and the report-time `fingerprint`
 * captured in PR 2. `CleanupCandidateAssessment` has no `repoPath`, so the
 * server re-resolves the repo path per row via the same `resolveRepoPath` the
 * sweep uses.
 */
export interface WorkspaceBulkRemoveRow {
  projectId: string;
  worktreePath: string;
  branch: string;
  /** Report-time optimistic-concurrency fingerprint; re-validated at bulk time. */
  fingerprint?: string;
}
