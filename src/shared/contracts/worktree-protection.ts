/** Filename of the marker that designates a protected worktree root. */
export const PROTECTED_MARKER = '.kookr-protected';

const LEGACY_PROD_SUFFIX = 'kookr-prod';

/**
 * Pure predicate over an already-normalized path. Frontend-safe — no node
 * dependency. Matches the legacy `kookr-prod` basename convention only.
 *
 * Server-authoritative protection lives in
 * `src/adapters/worktree-marker.ts:isProtectedWorktreePath`, which reads the
 * `.kookr-protected` marker file. The basename predicate is retained for
 * cosmetic frontend hints (e.g. stripping the suffix when displaying a
 * project's parent-repo path).
 */
export function endsWithProtectedSuffix(absPath: string): boolean {
  return absPath.endsWith(LEGACY_PROD_SUFFIX);
}

/** Strip the legacy `-prod` suffix from a path. Inverse of `endsWithProtectedSuffix`. */
export function deriveParentRepoFromProtected(absPath: string): string {
  return absPath.replace(/-prod$/, '');
}
