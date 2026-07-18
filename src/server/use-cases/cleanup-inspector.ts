/**
 * CleanupInspector — maps raw git facts + lease state into shared
 * CleanupCandidateAssessment DTOs.
 *
 * This is a read-only inspector in Phase 1a. It does not perform
 * any destructive operations. Classification is deterministic from
 * the inputs: git state, lease state, and baseline resolution.
 */

import type {
  BaselineResolution,
  CleanupCandidateAssessment,
  CleanupCommitSummary,
  CleanupDirtySummary,
} from '../../core/workspace-types.js';
import { existsSync } from 'node:fs';
import type { RepoPolicyResolver } from '../../core/repo-policy-resolver.js';
import type { WorktreeLeaseService } from '../../core/worktree-lease-service.js';
import { gitIn } from '../../core/git-helpers.js';
import { getProjectId } from '../../core/project-identity.js';
import { isProtectedWorktreePath } from '../../adapters/worktree-marker.js';
import { isProtectedBranch, samePath } from '../../adapters/worktree-safety.js';
import { deriveCleanupCapabilities } from '../../core/workspace-cleanup-policy.js';
import { resolveWorktreeMergeStatus } from '../../core/worktree-merge-status.js';
import { parsePorcelainStatus, runCommitEnrichment } from './cleanup-enrichment.js';

interface GitWorktreeInfo {
  worktree: string;
  HEAD?: string;
  branch?: string;
  detached?: boolean;
  bare?: boolean;
  locked?: boolean;
  prunable?: boolean;
}

/** Parse `git worktree list --porcelain` output into structured info. */
function parseWorktreeList(output: string): GitWorktreeInfo[] {
  const entries: GitWorktreeInfo[] = [];
  let current: Partial<GitWorktreeInfo> = {};

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.worktree) entries.push(current as GitWorktreeInfo);
      current = { worktree: line.slice('worktree '.length) };
    } else if (line.startsWith('HEAD ')) {
      current.HEAD = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      // "refs/heads/my-branch" → "my-branch"
      const ref = line.slice('branch '.length);
      current.branch = ref.replace('refs/heads/', '');
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line.startsWith('locked')) {
      current.locked = true;
    } else if (line.startsWith('prunable')) {
      current.prunable = true;
    } else if (line === '' && current.worktree) {
      entries.push(current as GitWorktreeInfo);
      current = {};
    }
  }
  if (current.worktree) entries.push(current as GitWorktreeInfo);

  return entries;
}

export interface CleanupInspectorDeps {
  policyResolver: RepoPolicyResolver;
  leaseService: WorktreeLeaseService;
}

/**
 * Inspect all worktrees for a repository and classify each candidate.
 *
 * @param repoPath - Path to the main repository (not a worktree)
 * @param projectId - Kookr project identifier
 * @param deps - Policy resolver and lease service
 */
export async function inspectCleanupCandidates(
  repoPath: string,
  projectId: string,
  deps: CleanupInspectorDeps,
): Promise<CleanupCandidateAssessment[]> {
  const { policyResolver, leaseService } = deps;
  const observedAt = new Date().toISOString();

  // Get worktree list
  const rawList = await gitIn(repoPath, 'worktree', 'list', '--porcelain');
  if (rawList === null) {
    return [];
  }

  const worktrees = parseWorktreeList(rawList);
  if (worktrees.length === 0) return [];

  // A bare repository has no primary checkout: every non-bare entry is linked.
  // Only a registry without a bare entry can identify its first non-bare entry
  // as the ordinary repository checkout.
  const primaryPath = worktrees.some((wt) => wt.bare)
    ? undefined
    : worktrees.find((wt) => !wt.bare)?.worktree;
  const candidates = worktrees.filter((wt) => (
    !wt.bare && (!primaryPath || !samePath(wt.worktree, primaryPath))
  ));

  const currentProjectId = await getProjectId(repoPath);
  if (currentProjectId !== projectId) {
    return candidates
      .filter((wt) => !wt.bare)
      .map((wt) => classifyProjectRepointedCandidate(wt, projectId, currentProjectId, observedAt));
  }

  // Resolve baseline for classification only after the current repo still
  // matches the stored project. A repointed origin makes baseline logic unsafe.
  const baseline = await policyResolver.resolveBaseline(projectId, repoPath);

  const assessments: CleanupCandidateAssessment[] = [];

  for (const wt of candidates) {
    if (wt.bare) continue;

    const assessment = await classifyCandidate(
      wt, repoPath, projectId, baseline, leaseService, observedAt, worktrees,
    );
    assessments.push(assessment);
  }

  return assessments;
}

/**
 * Inspect and classify one worktree path.
 *
 * Bulk cleanup uses this for per-candidate revalidation. It preserves the
 * same branch-checked-out-elsewhere and project-repointing guards as the full
 * inspector without reclassifying every worktree for every deletion.
 */
export async function inspectCleanupCandidate(
  repoPath: string,
  projectId: string,
  worktreePath: string,
  deps: CleanupInspectorDeps,
): Promise<CleanupCandidateAssessment | undefined> {
  const { policyResolver, leaseService } = deps;
  const observedAt = new Date().toISOString();

  const rawList = await gitIn(repoPath, 'worktree', 'list', '--porcelain');
  if (rawList === null) {
    return undefined;
  }

  const worktrees = parseWorktreeList(rawList);
  const primaryPath = worktrees.some((item) => item.bare)
    ? undefined
    : worktrees.find((item) => !item.bare)?.worktree;
  const wt = worktrees.find((item) => (
    !item.bare
    && samePath(item.worktree, worktreePath)
    && (!primaryPath || !samePath(item.worktree, primaryPath))
  ));
  if (!wt || wt.bare) {
    return undefined;
  }

  const currentProjectId = await getProjectId(repoPath);
  if (currentProjectId !== projectId) {
    return classifyProjectRepointedCandidate(wt, projectId, currentProjectId, observedAt);
  }

  const baseline = await policyResolver.resolveBaseline(projectId, repoPath);
  return classifyCandidate(wt, repoPath, projectId, baseline, leaseService, observedAt, worktrees);
}

function classifyProjectRepointedCandidate(
  wt: GitWorktreeInfo,
  projectId: string,
  currentProjectId: string,
  observedAt: string,
): CleanupCandidateAssessment {
  return {
    projectId,
    currentProjectId,
    worktreePath: wt.worktree,
    branch: wt.branch ?? `(detached at ${wt.HEAD?.slice(0, 8) ?? 'unknown'})`,
    protectedBranch: isProtectedBranch(wt.branch),
    classification: 'unknown',
    reasonCode: 'project_repointed',
    source: 'cleanup_inspector',
    observedAt,
    recoveryGuidance: `Stored projectId ${projectId} no longer matches current origin ${currentProjectId}. Relaunch or confirm the project before cleanup.`,
    capabilities: deriveCleanupCapabilities({ classification: 'unknown', reasonCode: 'project_repointed' }),
    headShortSha: wt.branch ? undefined : wt.HEAD?.slice(0, 7),
  };
}

async function classifyCandidate(
  wt: GitWorktreeInfo,
  repoPath: string,
  projectId: string,
  baseline: Pick<BaselineResolution, 'baselineRef' | 'baselineSha' | 'checkedAt'>,
  leaseService: WorktreeLeaseService,
  observedAt: string,
  allWorktrees: GitWorktreeInfo[],
): Promise<CleanupCandidateAssessment> {
  const base: Omit<CleanupCandidateAssessment, 'classification' | 'reasonCode' | 'recoveryGuidance' | 'capabilities'> = {
    projectId,
    worktreePath: wt.worktree,
    branch: wt.branch ?? `(detached at ${wt.HEAD?.slice(0, 8) ?? 'unknown'})`,
    protectedBranch: isProtectedBranch(wt.branch),
    source: 'cleanup_inspector',
    baselineRef: baseline.baselineRef,
    baselineSha: baseline.baselineSha,
    checkedAt: baseline.checkedAt,
    observedAt,
  };

  // Check lease state first — busy takes priority
  if (leaseService.isLeased(wt.worktree)) {
    return {
      ...base,
      classification: 'busy',
      reasonCode: 'active_lease',
      recoveryGuidance: 'Worktree is actively used by a Kookr task. Wait for the task to complete.',
      capabilities: deriveCleanupCapabilities({ classification: 'busy', reasonCode: 'active_lease' }),
    };
  }

  if (isProtectedWorktreePath(wt.worktree)) {
    return {
      ...base,
      classification: 'protected',
      reasonCode: 'protected_worktree',
      recoveryGuidance: 'This worktree is protected and cannot be removed from the workspace.',
      capabilities: deriveCleanupCapabilities({ classification: 'protected', reasonCode: 'protected_worktree' }),
    };
  }

  if (wt.locked || wt.prunable) {
    const reasonCode = wt.locked ? 'locked_worktree' : 'prunable_worktree';
    return {
      ...base,
      classification: 'stale_worktree',
      reasonCode,
      recoveryGuidance: wt.locked
        ? 'Inspect the worktree lock and unlock it only if no live process is using it; then run git worktree prune.'
        : 'Run git worktree prune to remove stale worktree registry entries.',
      capabilities: deriveCleanupCapabilities({ classification: 'stale_worktree', reasonCode }),
    };
  }

  // No branch info (detached HEAD) → unknown.
  // Run dirty enrichment so a detached-HEAD worktree with uncommitted
  // state is not silently rendered as empty in the list. There is no
  // symbolic branch, so commit enrichment (ahead/behind, last commit)
  // is intentionally skipped.
  if (!wt.branch) {
    const dirty = await checkDirty(wt.worktree);
    if (dirty.reason === 'status_failed') {
      const reasonCode = existsSync(wt.worktree) ? 'status_failed' : 'missing_worktree_path';
      return {
        ...base,
        classification: 'stale_worktree',
        reasonCode,
        recoveryGuidance: reasonCode === 'missing_worktree_path'
          ? 'Run git worktree prune to remove this missing worktree registry entry.'
          : 'Inspect why git status failed for this worktree before cleanup.',
        capabilities: deriveCleanupCapabilities({ classification: 'stale_worktree', reasonCode }),
        headShortSha: wt.HEAD?.slice(0, 7),
      };
    }
    return {
      ...base,
      classification: 'unknown',
      reasonCode: 'detached_head',
      recoveryGuidance: 'Worktree has a detached HEAD. Inspect manually.',
      capabilities: deriveCleanupCapabilities({ classification: 'unknown', reasonCode: 'detached_head' }),
      dirtySummary: dirty.summary,
      enrichmentFailed: dirty.reason === 'status_failed' ? true : undefined,
      headShortSha: wt.HEAD?.slice(0, 7),
    };
  }

  // Check if branch is checked out elsewhere (in-memory lookup, no extra git spawn)
  const checkedOutElsewhere = allWorktrees.some(
    (other) => other.worktree !== wt.worktree && other.branch === wt.branch,
  );
  if (checkedOutElsewhere) {
    return {
      ...base,
      classification: 'checked_out_elsewhere',
      reasonCode: 'branch_checked_out',
      recoveryGuidance: 'Branch is checked out in another worktree. Switch branches there first.',
      capabilities: deriveCleanupCapabilities({ classification: 'checked_out_elsewhere', reasonCode: 'branch_checked_out' }),
    };
  }

  // Check for dirty state (uncommitted changes + untracked files).
  // This single `git status` call also populates the dirtySummary we
  // attach to the assessment — we never re-run status for enrichment.
  const dirty = await checkDirty(wt.worktree);
  if (dirty.reason) {
    if (dirty.reason === 'status_failed') {
      const reasonCode = existsSync(wt.worktree) ? 'status_failed' : 'missing_worktree_path';
      return {
        ...base,
        classification: 'stale_worktree',
        reasonCode,
        recoveryGuidance: reasonCode === 'missing_worktree_path'
          ? 'Run git worktree prune to remove this missing worktree registry entry.'
          : 'Inspect why git status failed for this worktree before cleanup.',
        capabilities: deriveCleanupCapabilities({ classification: 'stale_worktree', reasonCode }),
      };
    }
    if (dirty.reason === 'generated_artifacts') {
      return {
        ...base,
        classification: 'generated_only',
        reasonCode: dirty.reason,
        recoveryGuidance: 'Delete the generated artifact directory or refresh after the branch includes the ignore rule.',
        capabilities: deriveCleanupCapabilities({ classification: 'generated_only', reasonCode: dirty.reason }),
        dirtySummary: dirty.summary,
      };
    }
    const commitSummary = await maybeEnrichCommits(repoPath, wt.worktree, wt.branch, baseline.baselineRef);
    return {
      ...base,
      classification: 'dirty',
      reasonCode: dirty.reason,
      recoveryGuidance: 'Worktree has uncommitted or untracked changes. Commit or discard them first.',
      capabilities: deriveCleanupCapabilities({ classification: 'dirty', reasonCode: dirty.reason }),
      dirtySummary: dirty.summary,
      commitSummary: commitSummary.summary,
      enrichmentFailed: dirty.reason === 'status_failed' || commitSummary.failed
        ? true
        : undefined,
    };
  }

  // If no baseline ref resolved, we can't determine merge status → unknown.
  // The worktree is clean (dirty.reason was null) so no dirtySummary
  // is attached — the UI renders the clean case without a dirty
  // indicator.
  if (!baseline.baselineRef) {
    return {
      ...base,
      classification: 'unknown',
      reasonCode: 'no_baseline',
      recoveryGuidance: 'Repository baseline is unknown. Configure a repo profile to enable classification.',
      capabilities: deriveCleanupCapabilities({ classification: 'unknown', reasonCode: 'no_baseline' }),
      dirtySummary: dirty.summary,
    };
  }

  // Check merge status against the same shared logic used by the completion
  // dialog. The resolver already supplied the configured baseline when one is
  // present, so this call does not replace explicit repo policy.
  const mergeResult = await resolveWorktreeMergeStatus(repoPath, wt.branch, {
    baselineRef: baseline.baselineRef,
  });
  // The explicit baseline makes this branch unreachable in the current
  // resolver, but keep the guard as a fail-closed boundary if that contract
  // changes or a future implementation cannot resolve the ref.
  if (!mergeResult) {
    return {
      ...base,
      classification: 'unknown',
      reasonCode: 'no_baseline',
      recoveryGuidance: 'Repository baseline is unknown. Configure a repo profile to enable classification.',
      capabilities: deriveCleanupCapabilities({ classification: 'unknown', reasonCode: 'no_baseline' }),
      dirtySummary: dirty.summary,
    };
  }
  const commitSummary = await maybeEnrichCommits(repoPath, wt.worktree, wt.branch, baseline.baselineRef);
  return {
    ...base,
    classification: mergeResult.classification,
    reasonCode: mergeResult.reasonCode,
    recoveryGuidance: mergeResult.recoveryGuidance,
    capabilities: deriveCleanupCapabilities({
      classification: mergeResult.classification,
      reasonCode: mergeResult.reasonCode,
    }),
    dirtySummary: dirty.summary,
    commitSummary: commitSummary.summary,
    enrichmentFailed: commitSummary.failed ? true : undefined,
  };
}

async function maybeEnrichCommits(
  repoPath: string,
  worktreePath: string | undefined,
  branch: string | undefined,
  baselineRef: string | undefined,
): Promise<{ summary?: CleanupCommitSummary; failed: boolean }> {
  if (!worktreePath || !branch || !baselineRef) {
    return { failed: false };
  }
  const outcome = await runCommitEnrichment({ repoPath, worktreePath, branch, baselineRef });
  if (outcome.kind === 'ok') {
    return { summary: outcome.value, failed: false };
  }
  return { failed: true };
}

interface DirtyCheckResult {
  /** Classification reason code, or null when the worktree is clean. */
  reason: string | null;
  /** Parsed dirty-file summary. Undefined when the worktree is clean or
   *  when the status call failed. */
  summary?: CleanupDirtySummary;
}

/**
 * Check if a worktree has uncommitted changes or untracked files.
 * Returns the classification reason and a structured dirty-file
 * summary reused by the list-row subtext — no second `git status` call
 * is needed downstream.
 */
async function checkDirty(worktreePath: string): Promise<DirtyCheckResult> {
  const status = await gitIn(worktreePath, 'status', '--porcelain');
  if (status === null) return { reason: 'status_failed' };
  if (status.length === 0) return { reason: null };
  const parsed = parsePorcelainStatus(status);
  if (isGeneratedArtifactStatus(status)) {
    return { reason: 'generated_artifacts', summary: parsed.summary };
  }
  return { reason: 'uncommitted_changes', summary: parsed.summary };
}

function isGeneratedArtifactStatus(rawStatus: string): boolean {
  const lines = rawStatus.split('\n').filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every((line) => {
    const status = line.slice(0, 2);
    const path = line.slice(3).trim();
    return status === '??' && (path === 'graphify-out/' || path === 'graphify-out' || path.startsWith('graphify-out/'));
  });
}
