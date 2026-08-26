import { access, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

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
 * Atomically write `data` to `filePath` using write-to-temp + fsync + rename.
 * The fsync ensures data is durable on disk before the rename, preventing
 * data loss on power failure or kernel crash.
 *
 * The temp file is created in the same directory as `filePath` with a random
 * suffix so concurrent writers don't collide. When `options.mode` is set, the
 * mode is passed to `open` and then forced with `fchmod` before rename so the
 * final path carries the requested bits even when umask would strip them.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string,
  options?: AtomicWriteFileOptions,
): Promise<void> {
  const tempPath = join(dirname(filePath), `.tmp-${randomUUID()}`);
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
