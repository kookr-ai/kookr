import { describe, expect, it } from 'vitest';
import { isCleanupRemovableClassification } from './workspace-types.js';

describe('isCleanupRemovableClassification', () => {
  it('returns true for merged and patch-equivalent candidates', () => {
    expect(isCleanupRemovableClassification('merged')).toBe(true);
    expect(isCleanupRemovableClassification('patch_equivalent')).toBe(true);
  });

  it('returns false for all non-removable classifications', () => {
    expect(isCleanupRemovableClassification('unique_commits')).toBe(false);
    expect(isCleanupRemovableClassification('generated_only')).toBe(false);
    expect(isCleanupRemovableClassification('dirty')).toBe(false);
    expect(isCleanupRemovableClassification('checked_out_elsewhere')).toBe(false);
    expect(isCleanupRemovableClassification('stale_worktree')).toBe(false);
    expect(isCleanupRemovableClassification('busy')).toBe(false);
    expect(isCleanupRemovableClassification('protected')).toBe(false);
    expect(isCleanupRemovableClassification('unknown')).toBe(false);
  });
});
