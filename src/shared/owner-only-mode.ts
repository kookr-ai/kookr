import { chmodSync, existsSync } from 'node:fs';

/**
 * Owner-only permission modes for at-rest relay state and its recovery
 * artifacts (issue #2779). Relay SQLite state, its WAL/SHM sidecars, and the
 * files produced by `relay state reset` hold node registration hashes,
 * invitation verifiers, contact-share metadata, and tenant controls; a
 * permissive umask must not widen them beyond the owner.
 *
 * `0o600` (files) and `0o700` (directories) are POSIX concepts. `chmod` is a
 * no-op on Windows and can fail on exotic filesystems, so callers repair modes
 * best-effort: a chmod failure never breaks the operation that produced the
 * artifact — the content is already durable.
 */
export const OWNER_ONLY_FILE_MODE = 0o600;
export const OWNER_ONLY_DIR_MODE = 0o700;

/**
 * Best-effort tighten an existing file to owner-only (`0o600`). Missing paths
 * and chmod failures (Windows, exotic filesystems) are ignored so this can be
 * called defensively after any create/copy that may have honored the umask.
 */
export function enforceOwnerOnlyFile(path: string): void {
  try {
    if (existsSync(path)) chmodSync(path, OWNER_ONLY_FILE_MODE);
  } catch {
    // Best-effort: the file is already written; mode repair must not throw.
  }
}

/**
 * Best-effort tighten an existing directory to owner-only (`0o700`). Missing
 * paths and chmod failures are ignored, as for {@link enforceOwnerOnlyFile}.
 */
export function enforceOwnerOnlyDir(path: string): void {
  try {
    if (existsSync(path)) chmodSync(path, OWNER_ONLY_DIR_MODE);
  } catch {
    // Best-effort: the directory already exists; mode repair must not throw.
  }
}
