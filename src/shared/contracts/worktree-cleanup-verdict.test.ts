import { describe, test, expect } from 'vitest';
import {
  describeBlocker,
  describeVerdictOutcome,
  formatDirtySummary,
  isAlreadyGoneBlocker,
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

describe('isAlreadyGoneBlocker', () => {
  test('only a vanished path counts — it is the state removal was after', () => {
    expect(isAlreadyGoneBlocker('not-found')).toBe(true);
    for (const blocker of ALL_BLOCKERS.filter((b) => b !== 'not-found')) {
      expect(isAlreadyGoneBlocker(blocker), blocker).toBe(false);
    }
  });
});

describe('describeVerdictOutcome', () => {
  test('a vanished worktree reads as done, not refused', () => {
    // The regression this guards: "kept — path no longer exists" made a task
    // that had cleaned up after itself look like it could not be closed.
    const text = describeVerdictOutcome({ removable: false, blocker: 'not-found' });
    expect(text).toBe('already removed — nothing to clean up');
    expect(text).not.toContain('kept');
  });

  test('every other blocker still reads as a refusal, with its cause', () => {
    for (const blocker of ALL_BLOCKERS.filter((b) => b !== 'not-found')) {
      expect(describeVerdictOutcome({ removable: false, blocker }), blocker)
        .toBe(`kept — ${describeBlocker(blocker)}`);
    }
  });

  test('the separator swaps for the spoken summary, so nothing reads out "em dash"', () => {
    expect(describeVerdictOutcome({ removable: false, blocker: 'not-found' }, ', '))
      .toBe('already removed, nothing to clean up');
    expect(describeVerdictOutcome({ removable: false, blocker: 'uncommitted-changes' }, ', '))
      .toBe('kept, uncommitted changes');
  });

  test('a refusal with no named cause does not read as safe', () => {
    // `blocker` is present exactly when `removable` is false, so this is
    // malformed — but the row still draws a refusal glyph beside this text,
    // and "safe to remove" there would contradict it.
    expect(describeVerdictOutcome({ removable: false })).toBe('kept — reason unavailable');
  });

  test('a removable worktree says so regardless of separator', () => {
    expect(describeVerdictOutcome({ removable: true })).toBe('safe to remove');
    expect(describeVerdictOutcome({ removable: true }, ', ')).toBe('safe to remove');
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
