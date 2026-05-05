/**
 * ContributionWorkspaceQuery — projects workspace data for the UI.
 *
 * This is a read-only query that assembles the workspace view from
 * the underlying services. It does not invent a separate decision model.
 */

import type {
  WorkspaceView,
  CleanupCandidateAssessment,
} from '../../core/workspace-types.js';
import type { RepoPolicyResolver } from '../../core/repo-policy-resolver.js';
import type { WorktreeLeaseService } from '../../core/worktree-lease-service.js';
import type { WorkspaceAttemptRepository } from '../../core/workspace-attempt-repository.js';
import { inspectCleanupCandidates } from './cleanup-inspector.js';
import { projectDisplayName } from '../../core/project-identity.js';

export interface WorkspaceQueryDeps {
  policyResolver: RepoPolicyResolver;
  leaseService: WorktreeLeaseService;
  attemptRepository: WorkspaceAttemptRepository;
}

/**
 * Build the full workspace view for a project.
 *
 * @param projectId - Kookr project identifier
 * @param repoPath - Path to the main repository checkout
 * @param deps - Service dependencies
 */
export async function getWorkspaceView(
  projectId: string,
  repoPath: string,
  deps: WorkspaceQueryDeps,
): Promise<WorkspaceView> {
  const { policyResolver, leaseService, attemptRepository } = deps;

  const policy = policyResolver.getPolicy(projectId);

  // Inspect cleanup candidates (read-only)
  let candidates: CleanupCandidateAssessment[] = [];
  try {
    candidates = await inspectCleanupCandidates(repoPath, projectId, {
      policyResolver,
      leaseService,
    });
  } catch (err) {
    console.warn(`[workspace] Failed to inspect candidates for ${projectId}:`, err);
  }

  // Get recent attempts
  const recentAttempts = attemptRepository.listByProject(projectId, 10);

  // Scope leases to the currently inspected project candidates.
  const candidatePaths = new Set(candidates.map((candidate) => candidate.worktreePath).filter(Boolean));
  const activeLeases = leaseService.listActiveLeases()
    .filter((lease) => candidatePaths.has(lease.worktreePath));

  return {
    projectId,
    displayName: projectDisplayName(projectId),
    policy,
    repoPath,
    candidates,
    recentAttempts,
    activeLeases,
  };
}
