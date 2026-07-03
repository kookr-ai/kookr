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
import { inspectCleanupCandidate, inspectCleanupCandidates } from './cleanup-inspector.js';
import { hydrateCleanupCandidateDetail } from './workspace-cleanup-detail-query.js';

const execFile = promisify(execFileCb);
const NESTED_GIT_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_WORK_TREE',
] as const;

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
   * sweep passes `canSweepRemove`, which uses the same safe classifications.
   */
  classificationFilter?: (candidate: CleanupCandidateAssessment) => boolean;
  signal?: AbortSignal;
  sweepRunId?: string;
}

export interface WorkspaceBulkCleanupResult {
  summaries: CleanupResultSummary[];
  /**
   * Candidates the sweep attempted to remove (merged / patch_equivalent). Used
   * by the disk-aware report to source the "removal failed — still on disk"
   * rows as `safeCandidates − summaries`. Free — `inspectCleanupCandidates`
   * already classifies every worktree.
   */
  safeCandidates: CleanupCandidateAssessment[];
  /**
   * Every other classified candidate the sweep did NOT attempt to remove — the
   * diagnosis surface (probably-safe / needs-your-call / blocked buckets).
   */
  nonRemoved: CleanupCandidateAssessment[];
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
  const nonRemoved = candidates.filter((candidate) => (
    !!candidate.worktreePath && !filter(candidate)
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

  return { summaries, safeCandidates, nonRemoved };
}

/**
 * One selected Probably-safe row for a bulk keep-branch reclaim. Carries the
 * projectId/worktreePath/branch identity plus the report-time `fingerprint`;
 * the repo path is resolved by the injected `resolveRepoPath` (per RFC PR 3:
 * `CleanupCandidateAssessment` has no `repoPath`).
 */
export interface BulkRemoveProbablySafeRow {
  projectId: string;
  worktreePath: string;
  branch: string;
  fingerprint?: string;
}

/** Per-row progress emitted during a bulk reclaim (RFC PR 3). */
export interface BulkRemoveProgressEvent {
  runId: string;
  /** 1-based, over the selected rows. */
  index: number;
  total: number;
  projectId: string;
  worktreePath: string;
  status: 'running' | 'done' | 'failed' | 'skipped';
  /** Present on a `done` row: the keep-branch summary (never `branchRemoved`). */
  result?: CleanupResultSummary;
}

export interface BulkRemoveProbablySafeInput {
  rows: readonly BulkRemoveProbablySafeRow[];
  runId: string;
  /** Same per-project repo-path resolver the sweep uses. */
  resolveRepoPath: (projectId: string) => Promise<string>;
  signal?: AbortSignal;
  onProgress?: (event: BulkRemoveProgressEvent) => void;
}

export interface BulkRemoveRowResult {
  projectId: string;
  worktreePath: string;
  branch: string;
  status: 'done' | 'failed' | 'skipped';
  disposition?: CleanupResultSummary['disposition'];
  /** Always false — the keep-branch bulk never deletes a branch. */
  branchRemoved: boolean;
  reason?: string;
}

export interface BulkRemoveProbablySafeResult {
  runId: string;
  rows: BulkRemoveRowResult[];
}

/**
 * Bulk reclaim of Probably-safe worktrees: remove each selected path, KEEP the
 * branch (RFC sweep-worktree-ux PR 3, the RFC's one destructive-adjacent
 * surface).
 *
 * This function DELIBERATELY has no `deleteBranch` parameter — it hardcodes
 * keep-branch (`deleteBranch: false`) internally so that the landmine in
 * {@link cleanupWorkspaceCandidate}'s `deleteBranch ?? true` default can never
 * be reintroduced here by a later edit. Each row still routes through the
 * per-candidate {@link cleanupWorkspaceCandidate} for its revalidation,
 * capability gating, dirty-recovery guard, and fingerprint re-validation — no
 * new deletion primitive, just a keep-branch caller. A row whose worktree
 * changed between report and bulk (busy lease acquired, ref moved, path already
 * removed by a second actor) is re-validated and skipped; the carried
 * `fingerprint` is a staleness gate, not a mutex.
 */
export async function bulkRemoveProbablySafeCandidates(
  deps: WorkspaceCleanupDeps,
  input: BulkRemoveProbablySafeInput,
): Promise<BulkRemoveProbablySafeResult> {
  const total = input.rows.length;
  const rows: BulkRemoveRowResult[] = [];
  const repoPathCache = new Map<string, string | null>();

  const resolveCached = async (projectId: string): Promise<string | null> => {
    if (repoPathCache.has(projectId)) return repoPathCache.get(projectId) ?? null;
    try {
      const repoPath = await input.resolveRepoPath(projectId);
      repoPathCache.set(projectId, repoPath);
      return repoPath;
    } catch {
      repoPathCache.set(projectId, null);
      return null;
    }
  };

  for (let offset = 0; offset < input.rows.length; offset++) {
    if (input.signal?.aborted) break;
    const row = input.rows[offset]!;
    const index = offset + 1;
    const emit = (status: BulkRemoveProgressEvent['status'], summary?: CleanupResultSummary): void => {
      input.onProgress?.({
        runId: input.runId,
        index,
        total,
        projectId: row.projectId,
        worktreePath: row.worktreePath,
        status,
        ...(summary ? { result: summary } : {}),
      });
    };

    emit('running');

    const base = { projectId: row.projectId, worktreePath: row.worktreePath, branch: row.branch };
    const repoPath = await resolveCached(row.projectId);
    if (!repoPath) {
      rows.push({ ...base, status: 'skipped', branchRemoved: false, reason: 'repo path could not be resolved' });
      emit('skipped');
      continue;
    }

    try {
      const { summary } = await cleanupWorkspaceCandidate(deps, {
        ...base,
        repoPath,
        // keep-branch is hardcoded; see the doc comment on why there is no
        // deleteBranch param on this bulk function.
        deleteBranch: false,
        reviewFingerprint: row.fingerprint,
        signal: input.signal,
        sweepRunId: input.runId,
      });
      const status = summary.pathRemoved ? 'done' : 'skipped';
      rows.push({
        ...base,
        status,
        disposition: summary.disposition,
        branchRemoved: summary.branchRemoved,
        reason: summary.pathRemoved ? undefined : 'not removed',
      });
      emit(status, summary.pathRemoved ? summary : undefined);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      rows.push({ ...base, status: 'skipped', branchRemoved: false, reason });
      emit('skipped');
    }
  }

  return { runId: input.runId, rows };
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

  const candidate = await inspectCleanupCandidate(input.repoPath, input.projectId, input.worktreePath, {
    policyResolver: deps.policyResolver,
    leaseService: deps.leaseService,
  });

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
    const { stdout, stderr } = await execFile('git', ['-C', repoPath, ...args], { signal, env: gitExecEnv() });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    const stderr = err && typeof err === 'object' && 'stderr' in err
      ? String((err as { stderr?: string }).stderr ?? '')
      : err instanceof Error ? err.message : String(err);
    return { ok: false, stdout: '', stderr: stderr.trim() };
  }
}

function gitExecEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of NESTED_GIT_ENV_VARS) {
    delete env[name];
  }
  return env;
}
