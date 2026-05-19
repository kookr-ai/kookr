import { createHash } from 'node:crypto';

const REPO_KEY_MAX_SLUG_LEN = 100;
const REPO_KEY_HASH_LEN = 8;

/**
 * Replace filesystem-unsafe characters with a single dash. Used for branch
 * names that may contain slashes, colons, or shell glob metacharacters.
 *
 * Behaviour: any character that is not [A-Za-z0-9._-] becomes `-`. The result
 * is never empty for non-empty input.
 */
export function slugifyForCheckpointKey(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * Compute a deterministic, filesystem-safe key for a git checkout, derived
 * from its absolute git-common-dir path. Truncates the slug for path-length
 * safety (255-byte limits on common filesystems) and appends an 8-char SHA-1
 * hash of the full path so that collisions between truncated paths cannot
 * happen.
 */
export function repoKeyFor(gitCommonDir: string): string {
  const slug = slugifyForCheckpointKey(gitCommonDir).slice(0, REPO_KEY_MAX_SLUG_LEN);
  const hash = createHash('sha1').update(gitCommonDir).digest('hex').slice(0, REPO_KEY_HASH_LEN);
  return `${slug}-${hash}`;
}
