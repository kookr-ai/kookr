import type {
  CleanupCandidateAssessment,
  CleanupCapabilities,
  CleanupClassification,
} from './workspace-types.js';

interface CleanupPolicyFacts {
  classification: CleanupClassification;
  reasonCode: string;
}

export function deriveCleanupCapabilities(facts: CleanupPolicyFacts): CleanupCapabilities {
  switch (facts.classification) {
    case 'merged':
      return {
        canSafeRemove: true,
        canRemovePathKeepBranch: true,
        canReviewedDiscard: false,
        requiresDirtyRecovery: false,
        defaultActionLabel: 'Remove path and delete branch',
        riskSummary: 'Branch is fully merged into the baseline. Safe remove is authorized.',
      };
    case 'patch_equivalent':
      return {
        canSafeRemove: true,
        canRemovePathKeepBranch: true,
        canReviewedDiscard: false,
        requiresDirtyRecovery: false,
        defaultActionLabel: 'Remove path and delete branch',
        riskSummary: 'Branch adds no unique patches versus baseline. Safe remove is authorized.',
      };
    case 'unique_commits':
      return {
        canSafeRemove: false,
        canRemovePathKeepBranch: true,
        canReviewedDiscard: true,
        requiresDirtyRecovery: false,
        defaultActionLabel: 'Review cleanup options',
        riskSummary: 'Branch has local-only commits. Removing the path is allowed; deleting the branch requires reviewed risk acceptance.',
      };
    case 'generated_only':
      return blockedCapabilities(
        'Generated artifacts are not removed by branch cleanup. Delete the generated files or refresh after ignore rules apply.',
        'Only known generated artifacts are dirty. This is not meaningful source work, but Kookr leaves file deletion explicit.',
      );
    case 'dirty':
      return {
        canSafeRemove: false,
        canRemovePathKeepBranch: false,
        canReviewedDiscard: true,
        requiresDirtyRecovery: true,
        defaultActionLabel: 'Review recovery cleanup',
        riskSummary: 'This worktree has uncommitted state. Cleanup requires a reviewed recovery artifact before the path can be removed.',
      };
    case 'checked_out_elsewhere':
      return blockedCapabilities(
        'Branch is checked out in another worktree.',
        'Cleanup is blocked while the branch is active elsewhere.',
      );
    case 'stale_worktree':
      return blockedCapabilities(
        'Stale or inaccessible worktree entries require registry cleanup, not branch cleanup.',
        'Kookr could not inspect this worktree path. Prune stale worktree metadata only after confirming no live process owns it.',
      );
    case 'busy':
      return blockedCapabilities(
        'Worktree is leased by an active Kookr task.',
        'Cleanup is blocked while Kookr is actively using the worktree.',
      );
    case 'protected':
      return blockedCapabilities(
        'Protected worktrees cannot be removed from the workspace.',
        'Cleanup is blocked by worktree protection.',
      );
    case 'unknown':
      if (facts.reasonCode === 'detached_head') {
        return blockedCapabilities(
          'Detached HEAD cleanup is blocked in this rollout.',
          'Detached HEAD candidates are blocked until a rescue-ref flow exists.',
        );
      }
      return blockedCapabilities(
        'Unknown cleanup candidates are blocked in this rollout.',
        'Kookr cannot authorize cleanup for ambiguous workspace state.',
      );
  }
}

export function deriveCleanupCapabilitiesForCandidate(
  candidate: Pick<CleanupCandidateAssessment, 'classification' | 'reasonCode'>,
): CleanupCapabilities {
  return deriveCleanupCapabilities({
    classification: candidate.classification,
    reasonCode: candidate.reasonCode,
  });
}

/**
 * Classifications the cross-project sweep is authorized to remove.
 *
 * Tighter than canSafeRemove: excludes patch_equivalent because the
 * classifier cannot distinguish "squash-merged and still on baseline"
 * from "squash-merged then reverted" — both produce an empty
 * `git log --cherry-pick` output. See docs/rfc/rfc-cross-project-worktree-sweep.md.
 *
 * When revert-detection lands in the classifier, patch_equivalent can
 * be re-admitted by updating this constant alone.
 */
export const SWEEP_SAFE_CLASSIFICATIONS: readonly CleanupClassification[] = ['merged'] as const;

export function canSweepRemove(
  candidate: Pick<CleanupCandidateAssessment, 'classification' | 'reasonCode'>,
): boolean {
  const capabilities = deriveCleanupCapabilitiesForCandidate(candidate);
  if (!capabilities.canSafeRemove) return false;
  return SWEEP_SAFE_CLASSIFICATIONS.includes(candidate.classification);
}

function blockedCapabilities(blockedReason: string, riskSummary: string): CleanupCapabilities {
  return {
    canSafeRemove: false,
    canRemovePathKeepBranch: false,
    canReviewedDiscard: false,
    requiresDirtyRecovery: false,
    blockedReason,
    defaultActionLabel: 'Cleanup blocked',
    riskSummary,
  };
}
