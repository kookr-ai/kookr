/**
 * Shared DTOs for the Contribution Workspace (Phase 1a).
 *
 * These types are the single source of truth for cleanup classification,
 * assessment evidence, and attempt records. Both UI display and future
 * mutation paths consume these same objects.
 */

// --- Cleanup Classification ---

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

export function isCleanupRemovableClassification(classification: CleanupClassification): boolean {
  return classification === 'merged' || classification === 'patch_equivalent';
}

// --- Repo Policy ---

export type RepoPolicy = 'known_policy' | 'unknown_policy';

export interface BaselineResolution {
  policy: RepoPolicy;
  baselineRef?: string;
  baselineSha?: string;
  checkedAt?: string;
}

export interface CleanupCapabilities {
  canSafeRemove: boolean;
  canRemovePathKeepBranch: boolean;
  canReviewedDiscard: boolean;
  requiresDirtyRecovery: boolean;
  blockedReason?: string;
  defaultActionLabel: string;
  riskSummary: string;
}

// --- Cleanup Candidate Assessment ---

export interface CleanupCandidateAssessment {
  projectId: string;
  worktreePath?: string;
  branch: string;
  classification: CleanupClassification;
  reasonCode: string;
  source: string;
  baselineRef?: string;
  baselineSha?: string;
  checkedAt?: string;
  observedAt: string;
  recoveryGuidance: string;
  capabilities: CleanupCapabilities;
  /** List-level enrichment: commit age + ahead/behind vs baseline. */
  commitSummary?: CleanupCommitSummary;
  /** List-level enrichment: uncommitted-change counts by category. */
  dirtySummary?: CleanupDirtySummary;
  /** Set to true when any enrichment subprocess errored or timed out.
   *  The subprocess name, exit code, and stderr are recorded in the
   *  server warn log, not on the assessment itself. */
  enrichmentFailed?: true;
  /** Short HEAD sha (7 chars) for detached-HEAD worktrees. Lets the UI
   *  show a non-empty row instead of collapsing the row to a dash. */
  headShortSha?: string;
}

// --- Attempt Records ---

export type AttemptType = 'preflight' | 'cleanup' | 'diagnostic';

export type AttemptStatus =
  | 'running'
  | 'passed'
  | 'blocked'
  | 'timed_out'
  | 'cancelled'
  | 'superseded'
  | 'completed';

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
  /** Cross-project sweep run ID — groups attempts from a single sweep invocation. */
  sweepRunId?: string;
}

// --- Start Work Handoff ---

export interface StartWorkHandoff {
  handoffId: string;
  projectId: string;
  taskId: string;
  sessionId?: string;
  launchedAt: string;
  prompt: string;
  playbookId?: string;
}

// --- Worktree Lease ---

export interface WorktreeLease {
  worktreePath: string;
  ownerId: string;
  acquiredAt: string;
  lastHeartbeatAt: string;
}

export interface CleanupDirtySummary {
  modified: number;
  added: number;
  deleted: number;
  renamed: number;
  untracked: number;
}

export interface CleanupFileSample {
  path: string;
  status: string;
}

export interface CleanupCommitSummary {
  aheadCount: number;
  behindCount: number;
  lastCommitSha?: string;
  lastCommitAuthor?: string;
  lastCommitAt?: string;
  lastCommitSubject?: string;
}

export interface CleanupCandidateDetail {
  projectId: string;
  worktreePath: string;
  branch: string;
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

// --- Cleanup Result Summary (sent to UI after cleanup) ---

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

// --- Workspace View (projected for UI) ---

export interface WorkspaceView {
  projectId: string;
  displayName: string;
  policy: RepoPolicy;
  repoPath?: string;
  candidates: CleanupCandidateAssessment[];
  recentAttempts: WorkspaceAttemptRecord[];
  activeLeases: WorktreeLease[];
}
