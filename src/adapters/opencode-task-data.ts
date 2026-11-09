/**
 * Per-TASK persistent opencode data (resume support).
 *
 * opencode keeps its whole conversation (sessions, messages, tool calls, token usage) in one sqlite
 * database at `<XDG_DATA_HOME>/opencode/opencode.db`. A managed launch used to keep that under the
 * throwaway per-session dir, so the conversation vanished when the session stopped and a relaunch of
 * the same task could never continue it. The adapter now points `XDG_DATA_HOME` at
 *
 *   <dataRoot>/<taskId>/data          (the opencode DB lives in data/opencode/opencode.db)
 *   <dataRoot>/<taskId>/gate-base     (HEAD sha the deliverable gate counts commits against)
 *
 * so a later launch of the same task can run `opencode --session <ses_...> <cwd>` against the same DB.
 *
 * Disk is bounded by {@link sweepOpenCodeTaskData}: a task's dir is removed once the task is
 * gone, a day (configurable) after it completed/cancelled (a finished task can still be reopened and
 * resumed), when it has been unused longer than the age cap, and oldest-first when the total exceeds the
 * size cap. A task that is `terminated` (a crash or abort the operator may reopen) is
 * kept (until the caps) so it stays resumable.
 */
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import type { TaskStatus } from '../core/task-status.js';
import { openCodeDbPathForDataHome } from './opencode-usage-scanner.js';

export const DEFAULT_OPENCODE_DATA_MAX_AGE_DAYS = 14;
export const DEFAULT_OPENCODE_DATA_MAX_MB = 1024;
/** Grace before a completed/cancelled task's data goes (an operator can reopen and resume a finished task). */
export const DEFAULT_OPENCODE_DATA_DONE_TTL_HOURS = 24;
/** Minimum spacing between background sweeps in one process. */
export const OPENCODE_DATA_SWEEP_INTERVAL_MS = 60_000;

const SIZE_EVICTION_GRACE_MS = 10 * 60_000;
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/;

/** `KOOKR_OPENCODE_DATA_DIR`, else `opencode-data` next to the hook files (inside the Kookr data dir). */
export function resolveOpenCodeDataRoot(env: NodeJS.ProcessEnv, hooksDir: string): string {
  const configured = env.KOOKR_OPENCODE_DATA_DIR?.trim();
  if (configured && isAbsolute(configured)) return configured;
  const expanded = hooksDir.startsWith('~/') ? join(homedir(), hooksDir.slice(2)) : hooksDir;
  return join(dirname(expanded), 'opencode-data');
}

/** Positive number from an env string, else the default (0 disables a cap). */
export function parseDataCap(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function openCodeTaskDir(root: string, taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) throw new Error(`unsafe task id for opencode data dir: ${taskId}`);
  return join(root, taskId);
}

export const openCodeTaskDataHome = (taskDir: string): string => join(taskDir, 'data');

/**
 * Ownership marker written into every task dir the adapter creates. Every recursive delete in this module
 * (sweep, fresh-launch reset, failed-launch cleanup) is confined to dirs that carry the marker with the
 * matching task id, so an operator-chosen `KOOKR_OPENCODE_DATA_DIR` that points at an existing directory
 * (or a symlink) can never get its unrelated children deleted.
 */
export const TASK_DIR_MARKER = '.kookr-opencode-task';

/**
 * Marker contents are `taskId` (legacy) or `taskId:token`. The token is a per-launch generation id: a
 * failed launch's late cleanup must only remove the dir THAT launch created, never one a retry of the
 * same task has since recreated and re-marked.
 */
export async function markTaskDir(taskDir: string, taskId: string, launchToken?: string): Promise<void> {
  await writeFile(join(taskDir, TASK_DIR_MARKER), `${launchToken ? `${taskId}:${launchToken}` : taskId}\n`, { mode: 0o600 });
}

async function readTaskDirMarker(dir: string): Promise<{ taskId: string; token?: string } | undefined> {
  try {
    const l = await lstat(dir);
    if (!l.isDirectory() || l.isSymbolicLink()) return undefined;
    const raw = (await readFile(join(dir, TASK_DIR_MARKER), 'utf8')).trim();
    const sep = raw.indexOf(':');
    return sep < 0 ? { taskId: raw } : { taskId: raw.slice(0, sep), token: raw.slice(sep + 1) };
  } catch {
    return undefined;
  }
}

/** True only for a real directory (not a symlink) holding the marker for exactly this task id (any launch). */
export async function isMarkedTaskDir(dir: string, taskId: string): Promise<boolean> {
  return (await readTaskDirMarker(dir))?.taskId === taskId;
}

/** True when `dir` does not exist or is an empty real directory (safe to take over without deleting anything). */
export async function isAbsentOrEmptyDir(dir: string): Promise<boolean> {
  try {
    const l = await lstat(dir);
    if (!l.isDirectory() || l.isSymbolicLink()) return false;
    return (await readdir(dir)).length === 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** Remove a task dir only when Kookr marked it; returns whether anything was removed. Never touches foreign dirs. */
export async function removeMarkedTaskDir(dir: string, taskId: string): Promise<boolean> {
  if (!(await isMarkedTaskDir(dir, taskId))) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

/**
 * Remove a task dir only when its marker carries this task id AND this launch's token. Used by a failed
 * launch's cleanup, which can run after a retry of the same task recreated the dir.
 */
export async function removeTaskDirOwnedByLaunch(dir: string, taskId: string, launchToken: string): Promise<boolean> {
  const marker = await readTaskDirMarker(dir);
  if (marker?.taskId !== taskId || marker.token !== launchToken) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

/** Outcome of inspecting a task's opencode DB for a resumable session. */
export type OpenCodeSessionLookup =
  | { kind: 'found'; id: string }
  /** No DB, a never-initialised (zero-byte) DB, or a DB without a usable root session: a fresh launch is correct. */
  | { kind: 'absent' }
  /** The DB exists but could not be read (locked, schema drift, addon load failure): do NOT treat as empty. */
  | { kind: 'unreadable'; error: string };

/**
 * The opencode session to resume from the task's DB: `preferred` when that row exists, else the newest
 * root (non-child) session. Never throws; `undefined` when the DB is absent/unreadable/empty.
 */
export async function inspectOpenCodeSession(dataHome: string, preferred?: string): Promise<OpenCodeSessionLookup> {
  const dbPath = openCodeDbPathForDataHome(dataHome);
  if (!existsSync(dbPath)) return { kind: 'absent' };
  let db: import('better-sqlite3').Database | undefined;
  try {
    if ((await stat(dbPath)).size === 0) return { kind: 'absent' };
    const { default: Database } = await import('better-sqlite3');
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 500 });
    if (preferred && SESSION_ID_RE.test(preferred)) {
      const hit = db.prepare('SELECT id FROM session WHERE id = ?').get(preferred) as { id: string } | undefined;
      if (hit) return { kind: 'found', id: hit.id };
    }
    const row = db
      .prepare('SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 1')
      .get() as { id: string } | undefined;
    return row && SESSION_ID_RE.test(row.id) ? { kind: 'found', id: row.id } : { kind: 'absent' };
  } catch (err) {
    return { kind: 'unreadable', error: err instanceof Error ? err.message : String(err) };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/** Best-effort id lookup for callers that only record usage: unreadable collapses to `undefined`. Never throws. */
export async function readOpenCodeSessionId(dataHome: string, preferred?: string): Promise<string | undefined> {
  const r = await inspectOpenCodeSession(dataHome, preferred);
  return r.kind === 'found' ? r.id : undefined;
}

export async function readGateBase(taskDir: string): Promise<string | undefined> {
  try {
    const sha = (await readFile(join(taskDir, 'gate-base'), 'utf8')).trim();
    return /^[0-9a-f]{7,64}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

export async function writeGateBase(taskDir: string, sha: string): Promise<void> {
  await mkdir(taskDir, { recursive: true, mode: 0o700 });
  await writeFile(join(taskDir, 'gate-base'), `${sha}\n`, { mode: 0o600 });
}

/** Mark the dir as used now (the age cap counts from last use). Best-effort. */
export async function touchTaskDir(taskDir: string): Promise<void> {
  try {
    const now = new Date();
    await utimes(taskDir, now, now);
  } catch {
    /* best-effort */
  }
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await dirBytes(p);
    else {
      try {
        total += (await stat(p)).size;
      } catch {
        /* vanished */
      }
    }
  }
  return total;
}

export interface SweepOptions {
  root: string;
  /** Task status by id, or `undefined` when the task no longer exists. */
  statusOf: (taskId: string) => TaskStatus | undefined;
  /** Task ids with a live session in this process (never swept). */
  activeTaskIds: ReadonlySet<string>;
  /**
   * Re-evaluated immediately before every removal (a resume-launch can start while a long sweep is walking the
   * tree, and a session adopted after a server restart is not in `activeTaskIds`). Returning true skips the removal.
   */
  isActive?: (taskId: string) => boolean;
  maxAgeMs: number;
  /** Grace after last use before a completed/cancelled task's data is removed (0 = immediately). */
  doneTtlMs: number;
  /** 0 disables the size cap. */
  maxBytes: number;
  now?: number;
  warn?: (msg: string) => void;
}

export interface SweepResult {
  removed: Array<{ taskId: string; reason: 'task-gone' | 'task-done' | 'expired' | 'size-cap' }>;
  remainingBytes: number;
}

/** Remove stale per-task data dirs. Never throws; only touches direct children of `root` with safe names. */
export async function sweepOpenCodeTaskData(opts: SweepOptions): Promise<SweepResult> {
  const result: SweepResult = { removed: [], remainingBytes: 0 };
  let names: string[];
  try {
    names = await readdir(opts.root);
  } catch {
    return result;
  }
  const now = opts.now ?? Date.now();
  const survivors: Array<{ taskId: string; dir: string; mtimeMs: number; bytes: number }> = [];
  let protectedBytes = 0;
  const remove = async (taskId: string, dir: string, reason: SweepResult['removed'][number]['reason']) => {
    try {
      if (opts.isActive?.(taskId)) return;
      if (await removeMarkedTaskDir(dir, taskId)) result.removed.push({ taskId, reason });
    } catch (err) {
      opts.warn?.(`[opencode-task-data] could not remove ${dir}: ${(err as Error).message}`);
    }
  };
  for (const taskId of names) {
    if (!TASK_ID_RE.test(taskId) || opts.activeTaskIds.has(taskId)) continue;
    const dir = join(opts.root, taskId);
    // Only dirs Kookr itself created (ownership marker) are ever considered; foreign dirs and symlinks are left alone.
    if (!(await isMarkedTaskDir(dir, taskId))) continue;
    let mtimeMs: number;
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) continue;
      mtimeMs = s.mtimeMs;
    } catch {
      continue;
    }
    const status = opts.statusOf(taskId);
    if (status === undefined) { await remove(taskId, dir, 'task-gone'); continue; }
    // A task that is still open/pending/in progress may have a live terminal session that survived a Kookr
    // restart (dtach keeps it running) and is therefore not in `activeTaskIds`: the caps never evict it.
    if (status === 'open' || status === 'pending' || status === 'inProgress') {
      protectedBytes += await dirBytes(dir);
      continue;
    }
    if ((status === 'completed' || status === 'cancelled') && now - mtimeMs >= opts.doneTtlMs) {
      await remove(taskId, dir, 'task-done');
      continue;
    }
    // Age counts from last use (the adapter touches the dir on launch and stop), so a launch in flight is safe.
    if (opts.maxAgeMs > 0 && now - mtimeMs > opts.maxAgeMs) {
      await remove(taskId, dir, 'expired');
      continue;
    }
    survivors.push({ taskId, dir, mtimeMs, bytes: await dirBytes(dir) });
  }
  let total = survivors.reduce((n, s) => n + s.bytes, 0) + protectedBytes;
  if (opts.maxBytes > 0 && total > opts.maxBytes) {
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const s of survivors) {
      if (total <= opts.maxBytes) break;
      // Never evict a dir used in the last few minutes: its launch may be in flight.
      if (now - s.mtimeMs < SIZE_EVICTION_GRACE_MS) continue;
      await remove(s.taskId, s.dir, 'size-cap');
      total -= s.bytes;
    }
  }
  result.remainingBytes = total;
  return result;
}
