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
   * File mode applied when the temp file is created. The rename preserves that
   * mode on the destination, so secret stores can force owner-only (`0o600`)
   * rather than the platform default (`0o666` masked by umask, typically
   * `0o644`). Omit to keep the previous default for non-secret callers.
   */
  mode?: number;
}

/**
 * Atomically write `data` to `filePath` using write-to-temp + fsync + rename.
 * The fsync ensures data is durable on disk before the rename, preventing
 * data loss on power failure or kernel crash.
 *
 * The temp file is created in the same directory as `filePath` with a random
 * suffix so concurrent writers don't collide. When `options.mode` is set, it is
 * applied at open time so the final renamed file carries that mode (subject to
 * umask on create).
 */
export async function atomicWriteFile(
  filePath: string,
  data: string,
  options?: AtomicWriteFileOptions,
): Promise<void> {
  const tempPath = join(dirname(filePath), `.tmp-${randomUUID()}`);
  const fh = await open(tempPath, 'w', options?.mode);
  try {
    await fh.writeFile(data, 'utf-8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tempPath, filePath);
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
