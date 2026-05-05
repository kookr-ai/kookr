import { access, open, readFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Atomically write `data` to `filePath` using write-to-temp + fsync + rename.
 * The fsync ensures data is durable on disk before the rename, preventing
 * data loss on power failure or kernel crash.
 *
 * The temp file is created in the same directory as `filePath` with a random
 * suffix so concurrent writers don't collide.
 */
export async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const tempPath = join(dirname(filePath), `.tmp-${randomUUID()}`);
  const fh = await open(tempPath, 'w');
  try {
    await fh.writeFile(data, 'utf-8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tempPath, filePath);
}

/**
 * Read a JSON file and parse it. Returns `fallback` when the file is missing
 * or contains invalid JSON.
 *
 * Intentionally lossy — callers that need to distinguish "missing" from
 * "corrupt" (e.g. `task-persistence.ts`'s `CorruptTaskFileError`) should
 * read and parse the file themselves rather than use this helper.
 */
export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    await access(filePath);
  } catch {
    return fallback;
  }
  const raw = await readFile(filePath, 'utf-8');
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
