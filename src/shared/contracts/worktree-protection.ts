/** Filename of the marker that designates a protected worktree root. */
export const PROTECTED_MARKER = '.kookr-protected';

/** Branches that are protected from unattended worktree removal. */
export const DEFAULT_PROTECTED_BRANCHES = ['main', 'master', 'develop', 'dev'] as const;

/**
 * Pure, case-insensitive branch allowlist predicate. Callers that expose
 * configuration can pass a replacement allowlist; the default is deliberately
 * conservative for every cleanup surface.
 */
export function isProtectedBranch(
  branch: string | undefined,
  protectedBranches: readonly string[] = DEFAULT_PROTECTED_BRANCHES,
): boolean {
  if (!branch) return false;
  const normalized = branch.trim().toLowerCase().replace(/^refs\/heads\//, '');
  return protectedBranches.some((candidate) => candidate.trim().toLowerCase().replace(/^refs\/heads\//, '') === normalized);
}

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
