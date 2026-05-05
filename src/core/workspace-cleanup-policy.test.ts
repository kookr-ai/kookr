import { describe, expect, it } from 'vitest';
import {
  deriveCleanupCapabilities,
  canSweepRemove,
  SWEEP_SAFE_CLASSIFICATIONS,
} from './workspace-cleanup-policy.js';

describe('deriveCleanupCapabilities', () => {
  it('authorizes merged and patch-equivalent candidates for safe remove', () => {
    expect(deriveCleanupCapabilities({
      classification: 'merged',
      reasonCode: 'ancestor_of_baseline',
    }).canSafeRemove).toBe(true);

    const patchEquivalent = deriveCleanupCapabilities({
      classification: 'patch_equivalent',
      reasonCode: 'no_unique_patches',
    });
    expect(patchEquivalent.canSafeRemove).toBe(true);
    expect(patchEquivalent.canRemovePathKeepBranch).toBe(true);
    expect(patchEquivalent.blockedReason).toBeUndefined();
  });

  it('authorizes unique commits for reviewed delete and path-only cleanup', () => {
    const result = deriveCleanupCapabilities({
      classification: 'unique_commits',
      reasonCode: 'has_unique_commits',
    });

    expect(result.canSafeRemove).toBe(false);
    expect(result.canRemovePathKeepBranch).toBe(true);
    expect(result.canReviewedDiscard).toBe(true);
  });

  it('requires reviewed cleanup with recovery for dirty worktrees', () => {
    const result = deriveCleanupCapabilities({
      classification: 'dirty',
      reasonCode: 'uncommitted_changes',
    });

    expect(result.canSafeRemove).toBe(false);
    expect(result.canRemovePathKeepBranch).toBe(false);
    expect(result.canReviewedDiscard).toBe(true);
    expect(result.requiresDirtyRecovery).toBe(true);
    expect(result.blockedReason).toBeUndefined();
  });

  it('blocks detached-head and unknown cleanup', () => {
    expect(deriveCleanupCapabilities({
      classification: 'unknown',
      reasonCode: 'detached_head',
    }).blockedReason).toContain('Detached HEAD');

    expect(deriveCleanupCapabilities({
      classification: 'unknown',
      reasonCode: 'no_baseline',
    }).blockedReason).toContain('Unknown cleanup candidates');
  });
});

describe('canSweepRemove', () => {
  it('authorizes merged candidates', () => {
    expect(canSweepRemove({
      classification: 'merged',
      reasonCode: 'ancestor_of_baseline',
    })).toBe(true);
  });

  it('rejects patch_equivalent candidates (false-positive on squash+revert)', () => {
    expect(canSweepRemove({
      classification: 'patch_equivalent',
      reasonCode: 'no_unique_patches',
    })).toBe(false);
  });

  it('rejects every classification that canSafeRemove rejects', () => {
    const rejected: Array<Parameters<typeof canSweepRemove>[0]> = [
      { classification: 'unique_commits', reasonCode: 'has_unique_commits' },
      { classification: 'dirty', reasonCode: 'uncommitted_changes' },
      { classification: 'busy', reasonCode: 'lease_active' },
      { classification: 'checked_out_elsewhere', reasonCode: 'other_worktree' },
      { classification: 'protected', reasonCode: 'protected_path' },
      { classification: 'unknown', reasonCode: 'detached_head' },
      { classification: 'unknown', reasonCode: 'no_baseline' },
    ];
    for (const candidate of rejected) {
      expect(canSweepRemove(candidate)).toBe(false);
    }
  });

  it('exposes the safe set as a readonly constant', () => {
    expect(SWEEP_SAFE_CLASSIFICATIONS).toEqual(['merged']);
  });
});
