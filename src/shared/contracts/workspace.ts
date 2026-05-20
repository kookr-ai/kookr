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
