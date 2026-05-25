import { realpathSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';

/**
 * Canonical form of a cwd for dedup comparison. Resolves symlinks and, on
 * case-insensitive filesystems (default macOS), the on-disk casing. Falls back
 * to path.resolve() when the directory does not exist or is not readable.
 */
export function canonicalizeCwd(cwd: string): string {
  try {
    return realpathSync(cwd);
  } catch {
    return pathResolve(cwd);
  }
}
