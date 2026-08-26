import { access, open, readFile, rename, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Error codes returned when the underlying platform or filesystem does not
 * support fsync on a directory handle (or won't let us open the directory to
 * fsync it). On such filesystems the directory-entry fsync is simply
 * unavailable, so we treat these as non-fatal: the rename has already made the
 * new file visible, and its directory-entry crash durability is best-effort.
 *
 * By contrast, any *other* error code is a genuine (supported) I/O failure and
 * is propagated to the caller.
 */
const UNSUPPORTED_DIR_SYNC_CODES: ReadonlySet<string> = new Set([
  'EINVAL', // some filesystems reject fsync on a directory fd
  'EISDIR', // platform rejects the directory fd for fsync
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS', // fsync not implemented
  'EPERM', // e.g. Windows, restricted mounts
  'EACCES', // cannot open the directory for reading
  'EBADF',
]);

function isUnsupportedDirSyncError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code != null && UNSUPPORTED_DIR_SYNC_CODES.has(code);
}

/**
 * Fsync the directory entry so a preceding rename is durable across a crash.
 * Mirrors the temp-sync → rename → dir-sync sequence used by the remote node
 * client (`src/remote/node-client.ts`).
 *
 * Swallows errors that indicate directory fsync is unsupported on this
 * platform/filesystem (see {@link UNSUPPORTED_DIR_SYNC_CODES}); rethrows any
 * genuine I/O error so the caller can react to it.
 */
async function fsyncDirectory(dirPath: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(dirPath, 'r');
  } catch (err) {
    if (isUnsupportedDirSyncError(err)) return;
    throw err;
  }
  try {
    await handle.sync();
  } catch (err) {
    if (isUnsupportedDirSyncError(err)) return;
    throw err;
  } finally {
    await handle.close();
  }
}

export interface ReadJsonFileOptions {
  quarantineCorrupt?: boolean;
  warningPrefix?: string;
  warn?: (message: string, cause: unknown) => void;
}

export interface AtomicWriteFileOptions {
  /**
   * Exact permission bits for the final file (e.g. `0o600` for secret stores).
   * Applied at open and re-applied via fchmod so the result is not masked by
   * the process umask. Omit to keep the platform default for non-secret callers
   * (`0o666` masked by umask, typically `0o644`).
   */
  mode?: number;
}

/**
 * Atomically write `data` to `filePath` using write-to-temp + fsync + rename +
 * parent-directory fsync. The ordering matters for crash durability:
 *
 *   1. fsync the temp file — its contents are on disk before it is linked in.
 *   2. rename the temp file over `filePath` — an atomic swap of the entry.
 *   3. fsync the parent directory — the renamed entry itself is durable.
 *
 * Without step 3, a power loss after the rename can lose the renamed directory
 * entry even though the file's contents were fsynced, leaving `filePath`
 * missing or still pointing at the old inode.
 *
 * The temp file is created in the same directory as `filePath` with a random
 * suffix so concurrent writers don't collide. When `options.mode` is set, the
 * mode is passed to `open` and then forced with `fchmod` before rename so the
 * final path carries the requested bits even when umask would strip them.
 *
 * Error semantics of the directory fsync (step 3): filesystems/platforms that
 * don't support fsync on a directory are tolerated silently — the write is
 * considered successful. A *genuine* directory-fsync failure is ambiguous
 * because the rename has already made the new file visible; it is surfaced as a
 * rejection (wrapping the original error as `cause`) so callers learn the
 * directory entry's durability isn't guaranteed, while the file at `filePath`
 * is already present with the new contents.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string,
  options?: AtomicWriteFileOptions,
): Promise<void> {
  const dir = dirname(filePath);
  const tempPath = join(dir, `.tmp-${randomUUID()}`);
  const mode = options?.mode;
  let renamed = false;
  try {
    const fh = await open(tempPath, 'w', mode);
    try {
      await fh.writeFile(data, 'utf-8');
      // open() applies mode & ~umask; fchmod forces the exact requested bits.
      if (mode !== undefined) {
        await fh.chmod(mode);
      }
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tempPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        await unlink(tempPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  }
  try {
    await fsyncDirectory(dir);
  } catch (err) {
    throw new Error(
      `atomicWriteFile: wrote and renamed ${filePath}, but failed to fsync its parent ` +
        `directory ${dir}; the new file is already visible, but its directory entry may ` +
        `not survive a crash`,
      { cause: err },
    );
  }
}

export async function quarantineCorruptJsonFile(filePath: string): Promise<string> {
  const stamp = new Date().toISOString();
  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = attempt === 0 ? '' : `-${attempt}`;
    const target = `${filePath}.corrupt-${stamp}${suffix}`;
    let reserved = false;
    try {
      const reservation = await open(target, 'wx');
      await reservation.close();
      reserved = true;
      await rename(filePath, target);
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      if (reserved) {
        try {
          await unlink(target);
        } catch {
          // Best-effort cleanup of the empty reservation file.
        }
      }
      throw err;
    }
  }
  throw new Error(`Unable to choose a quarantine path for corrupt JSON file: ${filePath}`);
}

/**
 * Read a JSON file and parse it. Returns `fallback` when the file is missing
 * or contains invalid JSON.
 *
 * Intentionally lossy — callers that need to distinguish "missing" from
 * "corrupt" (e.g. `task-persistence.ts`'s `CorruptTaskFileError`) should
 * read and parse the file themselves rather than use this helper.
 */
export async function readJsonFile<T>(
  filePath: string,
  fallback: T,
  options: ReadJsonFileOptions = {},
): Promise<T> {
  try {
    await access(filePath);
  } catch {
    return fallback;
  }
  const raw = await readFile(filePath, 'utf-8');
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    if (options.quarantineCorrupt) {
      const quarantinedPath = await quarantineCorruptJsonFile(filePath);
      const prefix = options.warningPrefix ?? 'persistence';
      const warn = options.warn ?? console.warn;
      warn(
        `[${prefix}] Corrupt JSON file ${filePath}; quarantined at ${quarantinedPath}; using fallback`,
        err,
      );
    }
    return fallback;
  }
}
