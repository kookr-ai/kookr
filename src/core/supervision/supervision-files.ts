/**
 * On-disk record of a task supervision: `<dataDir>/supervisions/<id>/brief.md`
 * and `state.json`. Every write goes through a temp file plus rename so a
 * reader (or a crash) never sees a half-written file. The filesystem is
 * injected so tests can observe the write order without touching disk.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SupervisionTarget {
  taskId: string;
  name: string;
}

export interface SupervisionState {
  supervisionId: string;
  targets: SupervisionTarget[];
  goals: string[];
  deadlineAt: string;
  createdAt: string;
  supervisorTaskId: string | null;
}

export interface SupervisionFs {
  mkdirSync(path: string, opts: { recursive: true }): unknown;
  writeFileSync(path: string, data: string): unknown;
  renameSync(from: string, to: string): unknown;
  rmSync(path: string, opts: { force: true }): unknown;
}

const nodeFs: SupervisionFs = { mkdirSync, writeFileSync, renameSync, rmSync };

const DEFAULT_PORT = 4800;

/**
 * Data directory of the server the CLI talked to, derived the way the server
 * and `resolveKookrDataDir` (kookr-maintenance) do: `~/.kookr` for the default
 * port 4800, `~/.kookr-<port>` otherwise. `KOOKR_DIR` is deliberately ignored
 * because the server ignores it, and the server-side service reads these files.
 * `baseUrl` is the resolved API base; when its port cannot be read (non-numeric
 * or absent) we fall back to `KOOKR_PORT`, then the default directory.
 */
export function resolveDataDir(
  baseUrl: string | undefined,
  env: NodeJS.ProcessEnv,
  home: string = env.HOME ?? env.USERPROFILE ?? homedir(),
): string {
  let port: number | undefined;
  if (baseUrl) {
    try {
      const raw = new URL(baseUrl).port;
      port = raw === '' ? undefined : Number(raw);
    } catch {
      port = undefined;
    }
  }
  if (port === undefined) {
    const raw = env.KOOKR_PORT?.trim();
    port = raw ? Number(raw) : undefined;
  }
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535 || port === DEFAULT_PORT) {
    return join(home, '.kookr');
  }
  return join(home, `.kookr-${port}`);
}

export function supervisionDir(dataDir: string, supervisionId: string): string {
  return join(dataDir, 'supervisions', supervisionId);
}

/** Write `content` to `path` via `<path>.tmp-<pid>` + rename; the temp file is removed on failure. */
export function writeFileAtomic(path: string, content: string, fs: SupervisionFs = nodeFs): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, path);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort; the original error is the one worth reporting
    }
    throw err;
  }
}

export function writeSupervisionFiles(
  dataDir: string,
  state: SupervisionState,
  brief: string | undefined,
  fs: SupervisionFs = nodeFs,
): string {
  const dir = supervisionDir(dataDir, state.supervisionId);
  fs.mkdirSync(dir, { recursive: true });
  if (brief !== undefined) writeFileAtomic(join(dir, 'brief.md'), brief, fs);
  writeFileAtomic(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, fs);
  return dir;
}
