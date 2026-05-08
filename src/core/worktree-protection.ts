const PROTECTED_SUFFIX = 'kookr-prod';

/**
 * Pure predicate over an already-normalized path. Frontend-safe — no node:path
 * dependency.
 */
export function endsWithProtectedSuffix(absPath: string): boolean {
  return absPath.endsWith(PROTECTED_SUFFIX);
}

/** Strip the protected suffix from a path. Inverse of `endsWithProtectedSuffix`. */
export function deriveParentRepoFromProtected(absPath: string): string {
  return absPath.replace(/-prod$/, '');
}

/** Worktrees that Kookr must never remove automatically or from the workspace UI. */
export function isProtectedWorktreePath(worktreePath: string): boolean {
  return endsWithProtectedSuffix(worktreePath.replace(/[/\\]+$/, ''));
}
