import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkspaceAttemptRepository } from '../../core/workspace-attempt-repository.js';
import type { RepoPolicyResolver } from '../../core/repo-policy-resolver.js';
import type { WorktreeLeaseService } from '../../core/worktree-lease-service.js';
import type {
  CleanupCandidateAssessment,
  CleanupResultSummary,
} from '../../core/workspace-types.js';
import { deriveCleanupCapabilitiesForCandidate } from '../../core/workspace-cleanup-policy.js';
import { inspectCleanupCandidates } from './cleanup-inspector.js';
import { hydrateCleanupCandidateDetail } from './workspace-cleanup-detail-query.js';

const execFile = promisify(execFileCb);

export interface WorkspaceCleanupDeps {
  policyResolver: RepoPolicyResolver;
  leaseService: WorktreeLeaseService;
  attemptRepository: WorkspaceAttemptRepository;
}

export interface WorkspaceCleanupInput {
  projectId: string;
  repoPath: string;
  worktreePath: string;
  branch?: string;
  deleteBranch?: boolean;
  riskAccepted?: boolean;
  discardDirtyState?: boolean;
  reviewFingerprint?: string;
  /** Optional abort signal; when aborted, in-flight git subprocesses receive SIGTERM. */
  signal?: AbortSignal;
  /** Optional cross-project sweep run ID stamped on the attempt record. */
  sweepRunId?: string;
}

export interface WorkspaceCleanupResult {
  attemptId: string;
  summary: CleanupResultSummary;
}

export interface WorkspaceBulkCleanupInput {
  projectId: string;
  repoPath: string;
  /**
   * Optional filter on which candidates to delete. Defaults to
   * `canSafeRemove` (merged + patch_equivalent). The cross-project
   * sweep passes `canSweepRemove` (merged only).
   */
  classificationFilter?: (candidate: CleanupCandidateAssessment) => boolean;
  signal?: AbortSignal;
  sweepRunId?: string;
}

export interface WorkspaceBulkCleanupResult {
  summaries: CleanupResultSummary[];
}

export async function cleanupSafeWorkspaceCandidates(
  deps: WorkspaceCleanupDeps,
  input: WorkspaceBulkCleanupInput,
): Promise<WorkspaceBulkCleanupResult> {
  const candidates = await inspectCleanupCandidates(input.repoPath, input.projectId, {
    policyResolver: deps.policyResolver,
    leaseService: deps.leaseService,
  });

  const filter = input.classificationFilter
    ?? ((candidate) => deriveCleanupCapabilitiesForCandidate(candidate).canSafeRemove);

  const safeCandidates = candidates.filter((candidate) => (
    !!candidate.worktreePath && filter(candidate)
  ));

  const summaries: CleanupResultSummary[] = [];
  for (const candidate of safeCandidates) {
    if (!candidate.worktreePath) continue;
    if (input.signal?.aborted) break;

    try {
      const result = await cleanupWorkspaceCandidate(deps, {
        projectId: input.projectId,
        repoPath: input.repoPath,
        worktreePath: candidate.worktreePath,
        branch: candidate.branch,
        deleteBranch: true,
        signal: input.signal,
        sweepRunId: input.sweepRunId,
      });
      summaries.push(result.summary);
    } catch {
      // Individual attempt records already capture the failure or block reason.
    }
  }

  return { summaries };
}

export async function cleanupWorkspaceCandidate(
  deps: WorkspaceCleanupDeps,
  input: WorkspaceCleanupInput,
): Promise<WorkspaceCleanupResult> {
  const deleteBranch = input.deleteBranch ?? true;
  const discardDirtyState = input.discardDirtyState ?? false;
  const attempt = deps.attemptRepository.createAttempt({
    type: 'cleanup',
    projectId: input.projectId,
    worktreePath: input.worktreePath,
    branch: input.branch,
    reasonCode: 'cleanup_requested',
    source: input.sweepRunId ? 'cross_project_sweep' : 'workspace_ui',
    evidenceSummary: `Requested workspace cleanup for ${input.worktreePath}`,
    requestedDeleteBranch: deleteBranch,
    requestedDiscardDirtyState: discardDirtyState,
    reviewFingerprint: input.reviewFingerprint,
    sweepRunId: input.sweepRunId,
  });

  const candidate = (await inspectCleanupCandidates(input.repoPath, input.projectId, {
    policyResolver: deps.policyResolver,
    leaseService: deps.leaseService,
  })).find((item) => item.worktreePath === input.worktreePath);

  if (!candidate || !candidate.worktreePath) {
    deps.attemptRepository.blockAttempt(attempt.attemptId, 'Cleanup candidate could not be revalidated');
    throw new Error('Cleanup candidate could not be revalidated');
  }

  if (input.branch && input.branch !== candidate.branch) {
    deps.attemptRepository.blockAttempt(attempt.attemptId, 'Cleanup candidate changed; refresh and review again');
    throw new Error('Cleanup candidate changed; refresh and review again');
  }

  const capabilities = deriveCleanupCapabilitiesForCandidate(candidate);
  const isDirtyCleanup = candidate.classification === 'dirty';

  if (!deleteBranch && !capabilities.canRemovePathKeepBranch) {
    if (!(isDirtyCleanup && discardDirtyState)) {
      const message = capabilities.blockedReason ?? `Cleanup is not authorized for ${candidate.classification}`;
      deps.attemptRepository.blockAttempt(attempt.attemptId, message);
      throw new Error(message);
    }
  }

  if (isDirtyCleanup && !discardDirtyState) {
    deps.attemptRepository.blockAttempt(attempt.attemptId, 'Dirty cleanup requires an explicit reviewed discard request');
    throw new Error('Dirty cleanup requires an explicit reviewed discard request');
  }

  if (!isDirtyCleanup && discardDirtyState) {
    deps.attemptRepository.blockAttempt(attempt.attemptId, 'Discarding dirty state is only valid for dirty cleanup candidates');
    throw new Error('Discarding dirty state is only valid for dirty cleanup candidates');
  }

  if (deleteBranch && capabilities.canSafeRemove === false && candidate.classification !== 'unique_commits' && !isDirtyCleanup) {
    const message = capabilities.blockedReason ?? `Cleanup is not authorized for ${candidate.classification}`;
    deps.attemptRepository.blockAttempt(attempt.attemptId, message);
    throw new Error(message);
  }

  if (candidate.classification === 'unique_commits') {
    if (!input.reviewFingerprint) {
      deps.attemptRepository.blockAttempt(attempt.attemptId, 'Unique-commit cleanup requires a fresh review fingerprint');
      throw new Error('Unique-commit cleanup requires a fresh review fingerprint');
    }
    if (deleteBranch && !input.riskAccepted) {
      deps.attemptRepository.blockAttempt(attempt.attemptId, 'Deleting a unique-commit branch requires explicit risk acceptance');
      throw new Error('Deleting a unique-commit branch requires explicit risk acceptance');
    }
  }

  const detail = await hydrateCleanupCandidateDetail(input.repoPath, candidate);
  if (input.reviewFingerprint && input.reviewFingerprint !== detail.fingerprint) {
    deps.attemptRepository.blockAttempt(attempt.attemptId, 'Cleanup review is stale; refresh candidate detail and review again');
    throw new Error('Cleanup review is stale; refresh candidate detail and review again');
  }

  let recoveryRef: string | undefined;
  if (isDirtyCleanup) {
    if (!input.reviewFingerprint) {
      deps.attemptRepository.blockAttempt(attempt.attemptId, 'Dirty cleanup requires a fresh review fingerprint');
      throw new Error('Dirty cleanup requires a fresh review fingerprint');
    }

    const aheadCount = detail.commitSummary?.aheadCount;
    if (deleteBranch && aheadCount === undefined) {
      deps.attemptRepository.blockAttempt(attempt.attemptId, 'Dirty branch deletion requires baseline commit comparison');
      throw new Error('Dirty branch deletion requires baseline commit comparison');
    }
    if (deleteBranch && (aheadCount ?? 0) > 0 && !input.riskAccepted) {
      deps.attemptRepository.blockAttempt(attempt.attemptId, 'Deleting a dirty branch with local-only commits requires explicit risk acceptance');
      throw new Error('Deleting a dirty branch with local-only commits requires explicit risk acceptance');
    }

    recoveryRef = await createDirtyRecoveryArtifact(input.repoPath, candidate.worktreePath);
    if (!recoveryRef) {
      deps.attemptRepository.blockAttempt(attempt.attemptId, 'Failed to create dirty cleanup recovery stash');
      throw new Error('Failed to create dirty cleanup recovery stash');
    }
  }

  const removeResult = await runGit(input.repoPath, ['worktree', 'remove', candidate.worktreePath], input.signal);
  if (!removeResult.ok) {
    deps.attemptRepository.updateAttempt(attempt.attemptId, {
      status: 'completed',
      disposition: 'manual_intervention_required',
      finishedAt: new Date().toISOString(),
      evidenceSummary: `Failed to remove worktree ${candidate.worktreePath}`,
      stderrSummary: removeResult.stderr,
    });
    throw new Error(removeResult.stderr || 'Failed to remove worktree');
  }

  const pruneResult = await runGit(input.repoPath, ['worktree', 'prune'], input.signal);
  if (!pruneResult.ok) {
    return {
      attemptId: attempt.attemptId,
      summary: completeWithSummary(
        deps.attemptRepository,
        attempt.attemptId,
        candidate.branch,
        {
          branch: candidate.branch,
          disposition: 'prune_failed',
          pathRemoved: true,
          branchRemoved: false,
          errorKind: 'prune_failed',
          recoveryRef,
        },
        `Removed ${candidate.worktreePath} but git worktree prune failed${recoveryRef ? ` after creating recovery ${recoveryRef}` : ''}`,
      ),
    };
  }

  if (!deleteBranch) {
    return {
      attemptId: attempt.attemptId,
      summary: completeWithSummary(
        deps.attemptRepository,
        attempt.attemptId,
        candidate.branch,
        {
          branch: candidate.branch,
          disposition: 'path_removed_branch_retained',
          pathRemoved: true,
          branchRemoved: false,
          retainedReason: 'user_requested_keep_branch',
          recoveryRef,
        },
        `Removed ${candidate.worktreePath}; retained ${candidate.branch} because the user chose keep-branch cleanup${recoveryRef ? ` after creating recovery ${recoveryRef}` : ''}`,
      ),
    };
  }

  if (!detail.branchRefOid) {
    return {
      attemptId: attempt.attemptId,
      summary: completeWithSummary(
        deps.attemptRepository,
        attempt.attemptId,
        candidate.branch,
        {
          branch: candidate.branch,
          disposition: 'path_removed_branch_retained',
          pathRemoved: true,
          branchRemoved: false,
          retainedReason: 'ref_changed',
          recoveryRef,
        },
        `Removed ${candidate.worktreePath}; retained ${candidate.branch} because its ref changed${recoveryRef ? ` after creating recovery ${recoveryRef}` : ''}`,
      ),
    };
  }

  const currentRef = await runGit(input.repoPath, ['rev-parse', '--verify', `refs/heads/${candidate.branch}`], input.signal);
  if (!currentRef.ok || currentRef.stdout.trim() !== detail.branchRefOid) {
    return {
      attemptId: attempt.attemptId,
      summary: completeWithSummary(
        deps.attemptRepository,
        attempt.attemptId,
        candidate.branch,
        {
          branch: candidate.branch,
          disposition: 'path_removed_branch_retained',
          pathRemoved: true,
          branchRemoved: false,
          retainedReason: 'ref_changed',
          recoveryRef,
        },
        `Removed ${candidate.worktreePath}; retained ${candidate.branch} because its ref changed${recoveryRef ? ` after creating recovery ${recoveryRef}` : ''}`,
      ),
    };
  }

  const deleteRef = await runGit(
    input.repoPath,
    ['update-ref', '-d', `refs/heads/${candidate.branch}`, detail.branchRefOid],
    input.signal,
  );
  if (!deleteRef.ok) {
    return {
      attemptId: attempt.attemptId,
      summary: completeWithSummary(
        deps.attemptRepository,
        attempt.attemptId,
        candidate.branch,
        {
          branch: candidate.branch,
          disposition: 'branch_delete_failed',
          pathRemoved: true,
          branchRemoved: false,
          errorKind: 'branch_delete_failed',
          recoveryRef,
        },
        `Removed ${candidate.worktreePath}; failed to delete branch ${candidate.branch}${recoveryRef ? ` after creating recovery ${recoveryRef}` : ''}`,
      ),
    };
  }

  return {
    attemptId: attempt.attemptId,
    summary: completeWithSummary(
      deps.attemptRepository,
      attempt.attemptId,
      candidate.branch,
      {
        branch: candidate.branch,
        disposition: 'completed',
        pathRemoved: true,
        branchRemoved: true,
        recoveryRef,
      },
      `Removed ${candidate.worktreePath} and deleted branch ${candidate.branch}${recoveryRef ? ` after creating recovery ${recoveryRef}` : ''}`,
    ),
  };
}

async function createDirtyRecoveryArtifact(repoPath: string, worktreePath: string): Promise<string | undefined> {
  const beforeStash = await runGit(repoPath, ['rev-parse', '--verify', 'refs/stash']);
  const recoveryMessage = `kookr workspace cleanup ${new Date().toISOString()} ${worktreePath}`;
  const stashPush = await runGit(worktreePath, ['stash', 'push', '--all', '-m', recoveryMessage]);
  if (!stashPush.ok) {
    return undefined;
  }

  const topEntry = await runGit(repoPath, ['stash', 'list', '-1', '--format=%H%x1f%gd%x1f%s']);
  if (!topEntry.ok || !topEntry.stdout.trim()) {
    return undefined;
  }

  const [stashSha, stashRef] = topEntry.stdout.trim().split('\u001f');
  if (!stashSha || !stashRef) {
    return undefined;
  }

  if (beforeStash.ok && beforeStash.stdout.trim() === stashSha) {
    return undefined;
  }

  return stashRef;
}

function completeWithSummary(
  attemptRepository: WorkspaceAttemptRepository,
  attemptId: string,
  branch: string,
  summary: CleanupResultSummary,
  evidenceSummary: string,
  stderrSummary?: string,
): CleanupResultSummary {
  attemptRepository.updateAttempt(attemptId, {
    status: 'completed',
    disposition: summary.disposition === 'completed' && summary.errorKind === 'manual_intervention_required'
      ? 'manual_intervention_required'
      : summary.disposition,
    finishedAt: new Date().toISOString(),
    evidenceSummary,
    stderrSummary,
  });
  return summary;
}

async function runGit(
  repoPath: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFile('git', ['-C', repoPath, ...args], { signal });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    const stderr = err && typeof err === 'object' && 'stderr' in err
      ? String((err as { stderr?: string }).stderr ?? '')
      : err instanceof Error ? err.message : String(err);
    return { ok: false, stdout: '', stderr: stderr.trim() };
  }
}
