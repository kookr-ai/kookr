import { describe, test, expect } from 'vitest';
import {
  describeBlocker,
  formatDirtySummary,
  isPermanentBlocker,
  totalDirtyCount,
  type WorktreeCleanupBlocker,
} from './worktree-cleanup-verdict.js';

/** Every blocker, so the exhaustive-switch helpers can't silently gain a hole. */
const ALL_BLOCKERS: WorktreeCleanupBlocker[] = [
  'not-found',
  'primary-working-tree',
  'not-a-linked-worktree',
  'protected-branch',
  'repository-context-unavailable',
  'repository-context-mismatch',
  'protected-marker',
  'shared-with-active-task',
  'detached-head',
  'no-branch',
  'uncommitted-changes',
  'unmerged-commits',
  'git-status-failed',
  'unmerged-check-failed',
  'ralph-loop-active',
];

describe('describeBlocker', () => {
  test('returns a non-empty description for every blocker', () => {
    for (const blocker of ALL_BLOCKERS) {
      expect(describeBlocker(blocker), blocker).toBeTruthy();
    }
  });

  test('does not leak the raw code into user-facing text', () => {
    for (const blocker of ALL_BLOCKERS) {
      expect(describeBlocker(blocker), blocker).not.toContain('-');
    }
  });
});

describe('isPermanentBlocker', () => {
  test('identity and protection facts are permanent', () => {
    expect(isPermanentBlocker('primary-working-tree')).toBe(true);
    expect(isPermanentBlocker('not-a-linked-worktree')).toBe(true);
    expect(isPermanentBlocker('protected-branch')).toBe(true);
    expect(isPermanentBlocker('protected-marker')).toBe(true);
    expect(isPermanentBlocker('not-found')).toBe(true);
  });

  test('anything the user can resolve while the dialog is open is not permanent', () => {
    // These drive whether a re-check is offered — a worktree can be committed,
    // merged, released by another task, or have its Ralph loop stopped.
    expect(isPermanentBlocker('uncommitted-changes')).toBe(false);
    expect(isPermanentBlocker('unmerged-commits')).toBe(false);
    expect(isPermanentBlocker('shared-with-active-task')).toBe(false);
    expect(isPermanentBlocker('ralph-loop-active')).toBe(false);
    expect(isPermanentBlocker('detached-head')).toBe(false);
  });

  test('transient git failures are retryable', () => {
    expect(isPermanentBlocker('git-status-failed')).toBe(false);
    expect(isPermanentBlocker('unmerged-check-failed')).toBe(false);
  });
});

describe('formatDirtySummary', () => {
  test('lists only non-zero categories', () => {
    expect(formatDirtySummary({ modified: 3, added: 0, deleted: 0, renamed: 0, untracked: 2 }))
      .toBe('3 modified · 2 untracked');
  });

  test('is empty for a clean tree, so callers can fall back to "clean"', () => {
    expect(formatDirtySummary({ modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0 })).toBe('');
  });

  test('is empty when no status was gathered', () => {
    expect(formatDirtySummary(undefined)).toBe('');
  });
});

describe('totalDirtyCount', () => {
  test('sums every category', () => {
    expect(totalDirtyCount({ modified: 1, added: 2, deleted: 3, renamed: 4, untracked: 5 })).toBe(15);
  });

  test('is 0 when no status was gathered', () => {
    expect(totalDirtyCount(undefined)).toBe(0);
  });
});
