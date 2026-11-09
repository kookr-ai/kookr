import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * This Kookr install's identity for container labels (`kookr.instance`). Created once under the data dir and never
 * regenerated: a second Kookr on the same Docker daemon has a different id, so the reconciler never touches its
 * containers. Copying the file to another install is unsupported (both would then claim each other's containers).
 */
export async function getOrCreateInstanceId(dataDir: string): Promise<string> {
  const file = join(dataDir, 'instance-id');
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (UUID.test(existing)) return existing;
    // A corrupt file is an error, not a reason to mint a new id: a new id would orphan every labelled container.
    throw new Error(`${file} exists but is not a valid instance id; refusing to replace it`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  // `wx`: if two processes race, exactly one wins and the loser re-reads the winner's id.
  try {
    await writeFile(file, `${id}\n`, { mode: 0o600, flag: 'wx' });
    return id;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return (await readFile(file, 'utf8')).trim();
  }
}

/** Read-only variant for commands that must not create state: undefined when no instance id exists yet. */
export async function readInstanceId(dataDir: string): Promise<string | undefined> {
  try {
    const v = (await readFile(join(dataDir, 'instance-id'), 'utf8')).trim();
    return UUID.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
