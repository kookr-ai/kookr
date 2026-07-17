/**
 * Verdict describing whether a task-owned worktree can be removed on
 * completion, and the evidence behind that answer.
 *
 * There is exactly one producer: `inspectWorktreeCleanup` in
 * `adapters/git-worktree.ts`. The completion cleanup calls it to decide, and
 * the completion dialog calls it (via `worktree:inspectCleanup`) to display.
 * Both read the same verdict, so the dialog cannot promise an outcome the
 * cleanup won't honor.
 */

/**
 * Why a worktree cannot be removed. Each value maps 1:1 onto a step of the
 * guard cascade in `cleanupSingleWorktree`, in cascade order.
 */
export type WorktreeCleanupBlocker =
  // Path/identity guards
  | 'not-found'
  | 'primary-working-tree'
  | 'not-a-linked-worktree'
  | 'protected-branch'
  | 'repository-context-unavailable'
  | 'repository-context-mismatch'
  | 'protected-marker'
  | 'shared-with-active-task'
  // Cleanliness guards
  | 'detached-head'
  | 'no-branch'
  | 'uncommitted-changes'
  | 'unmerged-commits'
  | 'git-status-failed'
  | 'unmerged-check-failed'
  // Client-side guard — the server cleanup never sees this one; the dialog
  // refuses to request cleanup while an agent is still driving the worktree.
  | 'ralph-loop-active';

/** Uncommitted-change counts parsed from `git status --porcelain`. */
export interface WorktreeDirtySummary {
  modified: number;
  added: number;
  deleted: number;
  renamed: number;
  untracked: number;
}

/**
 * Observations gathered while deciding. Populated only as far as the cascade
 * actually got — an identity guard trips before any `git status` runs, so a
 * `primary-working-tree` verdict carries no evidence at all.
 */
export interface WorktreeCleanupEvidence {
  dirty?: WorktreeDirtySummary;
  /** Commits on the branch not reachable from the default branch. */
  aheadCount?: number;
}

export interface WorktreeCleanupVerdict {
  worktreePath: string;
  /** Basename of the worktree path — what the dialog shows. */
  worktreeName: string;
  branch?: string;
  removable: boolean;
  /** Present exactly when `removable` is false. */
  blocker?: WorktreeCleanupBlocker;
  evidence: WorktreeCleanupEvidence;
  /** ISO timestamp. The verdict is a snapshot; cleanup re-checks at execution. */
  checkedAt: string;
}

/**
 * Blockers that re-running the inspection could never clear.
 *
 * Drives whether the dialog offers a re-check: identity and protection facts
 * are settled, so offering to re-check them would imply a possibility that
 * doesn't exist. Cleanliness, sharing, and a running loop can all change while
 * the dialog is open.
 *
 * Exhaustiveness is enforced at compile time below rather than by a `default`
 * arm: a new *permanent* blocker defaulting to "retryable" would make the
 * dialog offer a re-check that can never succeed, and no test would notice.
 */
const PERMANENT_BLOCKERS = [
  'not-found',
  'primary-working-tree',
  'not-a-linked-worktree',
  'protected-branch',
  'protected-marker',
  'repository-context-unavailable',
  'repository-context-mismatch',
] as const satisfies readonly WorktreeCleanupBlocker[];

const RECOVERABLE_BLOCKERS = [
  'shared-with-active-task',
  'detached-head',
  'no-branch',
  'uncommitted-changes',
  'unmerged-commits',
  'git-status-failed',
  'unmerged-check-failed',
  'ralph-loop-active',
] as const satisfies readonly WorktreeCleanupBlocker[];

/** Every blocker must be classified exactly once. Compile error otherwise. */
type _UnclassifiedBlocker = Exclude<
  WorktreeCleanupBlocker,
  (typeof PERMANENT_BLOCKERS)[number] | (typeof RECOVERABLE_BLOCKERS)[number]
>;
type _DoubleClassifiedBlocker = Extract<
  (typeof PERMANENT_BLOCKERS)[number],
  (typeof RECOVERABLE_BLOCKERS)[number]
>;
const _blockersExhaustive: _UnclassifiedBlocker extends never ? true : never = true;
const _blockersDisjoint: _DoubleClassifiedBlocker extends never ? true : never = true;
void _blockersExhaustive;
void _blockersDisjoint;

export function isPermanentBlocker(blocker: WorktreeCleanupBlocker): boolean {
  return (PERMANENT_BLOCKERS as readonly WorktreeCleanupBlocker[]).includes(blocker);
}

/** Short human-readable cause, rendered after "kept — " in the dialog. */
export function describeBlocker(blocker: WorktreeCleanupBlocker): string {
  switch (blocker) {
    case 'not-found':
      return 'path no longer exists';
    case 'primary-working-tree':
      return 'primary working tree';
    case 'not-a-linked-worktree':
      return 'not a linked worktree';
    case 'protected-branch':
      return 'protected branch';
    case 'protected-marker':
      return 'marked protected';
    case 'repository-context-unavailable':
      return 'repository context unavailable';
    case 'repository-context-mismatch':
      return 'repository context mismatch';
    case 'shared-with-active-task':
      return 'shared with another active task';
    case 'detached-head':
      return 'detached HEAD';
    case 'no-branch':
      return 'no branch information';
    case 'uncommitted-changes':
      return 'uncommitted changes';
    case 'unmerged-commits':
      return 'unmerged commits';
    case 'git-status-failed':
      return 'git status failed';
    case 'unmerged-check-failed':
      return 'merge check failed';
    case 'ralph-loop-active':
      return 'Ralph loop still active';
  }
}

/** Total changed paths, or 0 when no status was gathered. */
export function totalDirtyCount(dirty: WorktreeDirtySummary | undefined): number {
  if (!dirty) return 0;
  return dirty.modified + dirty.added + dirty.deleted + dirty.renamed + dirty.untracked;
}

/** Compact evidence line, e.g. "3 modified · 2 untracked". Empty when clean. */
export function formatDirtySummary(dirty: WorktreeDirtySummary | undefined): string {
  if (!dirty) return '';
  const parts: string[] = [];
  if (dirty.modified > 0) parts.push(`${dirty.modified} modified`);
  if (dirty.added > 0) parts.push(`${dirty.added} added`);
  if (dirty.deleted > 0) parts.push(`${dirty.deleted} deleted`);
  if (dirty.renamed > 0) parts.push(`${dirty.renamed} renamed`);
  if (dirty.untracked > 0) parts.push(`${dirty.untracked} untracked`);
  return parts.join(' · ');
}
