/**
 * Scoped, retained rollback snapshots for Layer-4 auto-update (RFC Layer 4 / R8
 * + delivery). Unlike the install route's whole-`~/.claude/plugins` backup
 * (which `rm`s on success and would, on restore, discard a native edit made
 * afterward to an UNRELATED plugin), these snapshots are scoped to the ONE
 * plugin's install directory — exactly what `claude plugin update <id>` changes
 * — and are RETAINED for a stated window so a rollback is possible after the
 * fact.
 *
 * The snapshot is a copy of the plugin's install dir taken BEFORE the update. A
 * rollback replaces the (updated) install dir with the snapshot. A rollback
 * within the same plugin dir after a native edit to THAT plugin is an inherent
 * limitation of per-plugin scoping; cross-plugin and settings edits are never
 * touched.
 */
import { access, cp, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Default retention window for a pre-update snapshot (7 days). */
export const DEFAULT_SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const SNAPSHOTS_DIRNAME = 'plugin-auto-update-snapshots';

/** Filesystem-safe token from a plugin id (`a@b` → `a__at__b`), for a dir name. */
export function snapshotToken(pluginId: string): string {
  return pluginId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** The base directory snapshots live under. */
export function snapshotsBaseDir(dataDir: string): string {
  return join(dataDir, SNAPSHOTS_DIRNAME);
}

/**
 * Copy `installPath` aside into a fresh snapshot directory under the Kookr data
 * dir. Returns the snapshot path. Throws when `installPath` does not exist (a
 * plugin with no on-disk dir cannot be snapshotted — the caller treats that as a
 * non-rollbackable update).
 */
export async function captureScopedSnapshot(
  dataDir: string,
  pluginId: string,
  installPath: string,
  now: number = Date.now(),
): Promise<string> {
  await access(installPath); // throws if the install dir is missing
  const base = snapshotsBaseDir(dataDir);
  await mkdir(base, { recursive: true });
  const dest = join(base, `${snapshotToken(pluginId)}-${now}-${process.pid}`);
  await rm(dest, { recursive: true, force: true }); // paranoia: never merge into a stale dir
  await cp(installPath, dest, { recursive: true });
  return dest;
}

/**
 * Restore `installPath` from a previously captured snapshot (scoped rollback).
 * Moves the current (updated) dir aside, copies the snapshot back into place,
 * then removes the moved-aside dir. Returns `{ ok: true }` on success, or
 * `{ ok: false, snapshotPath }` when the restore could not complete (the snapshot
 * is preserved so the operator can recover manually). The snapshot is LEFT in
 * place either way (retained); the caller prunes it past the window.
 */
export async function restoreScopedSnapshot(
  snapshotPath: string,
  installPath: string,
): Promise<{ ok: boolean; snapshotPath?: string }> {
  try {
    await access(snapshotPath);
  } catch {
    return { ok: false, snapshotPath };
  }
  // Build the restored copy in a temp sibling FIRST, so the (updated) install dir
  // is never removed until a complete good copy exists — a copy failure leaves the
  // install dir intact rather than missing.
  const tmp = `${installPath}.kookr-autoupdate-restore-tmp-${Date.now()}-${process.pid}`;
  try {
    await rm(tmp, { recursive: true, force: true });
    await cp(snapshotPath, tmp, { recursive: true }); // snapshot stays retained
  } catch (err) {
    console.error(`[auto-update] scoped rollback copy failed for ${installPath}: ${String(err)}`);
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, snapshotPath }; // install dir untouched
  }
  const aside = `${installPath}.kookr-autoupdate-pre-rollback-${Date.now()}`;
  try {
    try {
      await rename(installPath, aside);
    } catch {
      // installPath may be absent — fine, we are restoring into place.
    }
    await rename(tmp, installPath);
    await rm(aside, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    console.error(`[auto-update] scoped rollback swap failed for ${installPath}: ${String(err)}`);
    // If the install dir ended up missing but the moved-aside copy survived, put it back.
    try {
      await access(installPath);
    } catch {
      await rename(aside, installPath).catch(() => undefined);
    }
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, snapshotPath };
  }
}

/** Delete a snapshot directory (best-effort). */
export async function discardSnapshot(snapshotPath: string): Promise<void> {
  try {
    await rm(snapshotPath, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
}
