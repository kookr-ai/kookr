import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { readProcessStartTimeMs } from '../adapters/process-tree.js';

/**
 * Startup single-writer assertion (RFC rfc-issue-ownership-lock R27).
 *
 * Kookr's persistence (`tasks.json`, no OS file lock) and the issue-claim
 * CAS both inherit the assumption that exactly ONE server process owns a
 * data dir. The port bind enforces this eventually, but boot-time task
 * mutations (reconcile, claim rebuild) run BEFORE the bind — so a second
 * process pointed at the same dir could silently interleave writes during
 * that window. This lock makes the assumption fail loudly instead.
 *
 * `server.pid` remains the human-readable ownership record. Its first line is
 * still the PID so older Kookr binaries fail closed on a live new-version
 * owner. Version 2 adds a second-line JSON record that binds the PID to its OS
 * start time (so a recycled PID is not mistaken for the crashed owner) and to
 * a per-acquisition ID (so an old release callback cannot delete a successor's
 * lock). `server.lock.sqlite` supplies the atomic cross-process mutex: its open
 * write transaction is released by the OS on a crash, so stale metadata can be
 * replaced without an unlink/recreate race.
 *
 * Planned restarts close the HTTP listen socket before they release this
 * lock. The incoming process therefore often sees a still-live holder for a
 * few hundred milliseconds. We retry for a short window so
 * `pnpm prod:update` does not die with "exited before becoming healthy"
 * (issue #2501). A second unrelated server still fails after that window.
 */

/** Default retry budget when another live process holds the lock (issue #2501). */
export const SINGLE_WRITER_LOCK_RETRY_MS = 5_000;
/** Pause between acquisition attempts while waiting for the outgoing holder. */
export const SINGLE_WRITER_LOCK_RETRY_INTERVAL_MS = 50;

interface SingleWriterLockRecord {
  version: 2;
  pid: number;
  processStartTimeMs: number;
  acquisitionId: string;
}

type HolderRecord =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'legacy'; pid: number }
  | { kind: 'current'; record: SingleWriterLockRecord };

export interface AcquireSingleWriterLockOptions {
  /** How long to keep retrying when another live process holds the lock. */
  retryMs?: number;
  /** Sleep between retries. */
  retryIntervalMs?: number;
  /** Test seam: replace `Atomics.wait` so retry tests stay synchronous and fast. */
  sleep?: (ms: number) => void;
  /** Test seam: replace the pid liveness probe. */
  isAlive?: (pid: number) => boolean;
  /** Test seam: replace the OS process-start identity reader. */
  readProcessStartTimeMs?: (pid: number) => number | null;
  /** Test seam: make acquisition identity deterministic. */
  createAcquisitionId?: () => string;
}

export function acquireSingleWriterLock(
  kookrDir: string,
  options: AcquireSingleWriterLockOptions = {},
): () => void {
  const lockPath = join(kookrDir, 'server.pid');
  const mutexPath = join(kookrDir, 'server.lock.sqlite');
  mkdirSync(kookrDir, { recursive: true });

  const retryMs = options.retryMs ?? SINGLE_WRITER_LOCK_RETRY_MS;
  const retryIntervalMs = options.retryIntervalMs ?? SINGLE_WRITER_LOCK_RETRY_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const isAlive = options.isAlive ?? isProcessAlive;
  const readStartTime = options.readProcessStartTimeMs ?? readProcessStartTimeMs;
  const ownStartTimeMs = readStartTime(process.pid);
  if (ownStartTimeMs === null) {
    throw new Error(
      `[single-writer] cannot determine this process identity (pid ${process.pid}) — `
      + `refusing to take the data-directory lock for ${kookrDir}`,
    );
  }

  const ownRecord: SingleWriterLockRecord = {
    version: 2,
    pid: process.pid,
    processStartTimeMs: ownStartTimeMs,
    acquisitionId: (options.createAcquisitionId ?? randomUUID)(),
  };
  const serializedOwnRecord = `${ownRecord.pid}\n${JSON.stringify(ownRecord)}\n`;
  const deadline = Date.now() + Math.max(0, retryMs);
  const mutex = new Database(mutexPath, { timeout: 0 });
  let transactionOpen = false;

  const rollback = (): void => {
    if (!transactionOpen) return;
    try {
      mutex.exec('ROLLBACK');
    } finally {
      transactionOpen = false;
    }
  };

  const close = (): void => {
    try {
      rollback();
    } finally {
      mutex.close();
    }
  };

  const retry = (holder: HolderRecord): void => {
    try {
      retryOrThrow(holder, lockPath, kookrDir, deadline, retryIntervalMs, sleep);
    } catch (error) {
      close();
      throw error;
    }
  };

  for (;;) {
    let holder = readHolder(lockPath);
    try {
      mutex.exec('BEGIN IMMEDIATE');
      transactionOpen = true;
    } catch (error) {
      if (!isSqliteBusy(error)) {
        close();
        throw error;
      }
      retry(holder);
      continue;
    }

    // Re-read only after the mutex is held. Another new-version contender can
    // no longer change the ownership record until this transaction ends.
    holder = readHolder(lockPath);
    const holderState = classifyHolder(holder, isAlive, readStartTime);
    if (holderState === 'active' || holderState === 'unknown') {
      rollback();
      retry(holder);
      continue;
    }

    try {
      // `wx` preserves exclusivity for a genuinely absent path, including
      // compatibility with an older Kookr binary that does not use the SQLite
      // mutex. A stale path is safe to replace while the new-version mutex is
      // held: a dead/recycled owner cannot release it, and live legacy holders
      // were classified active above.
      publishLockRecord(lockPath, serializedOwnRecord, holder.kind === 'missing');
    } catch (error) {
      rollback();
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        retry(readHolder(lockPath));
        continue;
      }
      close();
      throw error;
    }
    break;
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      const holder = readHolder(lockPath);
      if (holder.kind === 'current' && sameAcquisition(holder.record, ownRecord)) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Best effort. A stale record is recovered after the OS releases the
          // SQLite transaction when this process exits.
        }
      }
      if (transactionOpen) {
        mutex.exec('COMMIT');
        transactionOpen = false;
      }
    } catch {
      // Best-effort release. Closing the connection still drops the OS lock;
      // ownership-checked metadata cleanup can be retried by the next boot.
      rollback();
    } finally {
      mutex.close();
    }
  };
  return release;
}

function readHolder(lockPath: string): HolderRecord {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8').trim();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'invalid' };
  }

  const newline = raw.indexOf('\n');
  const pidText = newline === -1 ? raw : raw.slice(0, newline).trim();
  if (!/^[1-9]\d*$/.test(pidText)) return { kind: 'invalid' };
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid)) return { kind: 'invalid' };
  if (newline === -1) {
    return { kind: 'legacy', pid };
  }

  try {
    const value: unknown = JSON.parse(raw.slice(newline + 1).trim());
    if (!isSingleWriterLockRecord(value) || value.pid !== pid) return { kind: 'invalid' };
    return { kind: 'current', record: value };
  } catch {
    return { kind: 'invalid' };
  }
}

function publishLockRecord(lockPath: string, data: string, pathWasMissing: boolean): void {
  const temporaryPath = join(dirname(lockPath), `.tmp-${randomUUID()}`);
  let published = false;
  try {
    const fd = openSync(temporaryPath, 'wx');
    try {
      writeFileSync(fd, data, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    if (pathWasMissing) {
      // Hard-link publication is atomic and refuses to overwrite a lock that
      // appeared after the missing-path check (including an older binary).
      linkSync(temporaryPath, lockPath);
    } else {
      // The stale record stays complete until this atomic replacement. A
      // crash before rename leaves only an allowlisted `.tmp-<uuid>` file.
      renameSync(temporaryPath, lockPath);
      published = true;
    }
  } finally {
    if (!published) {
      try { unlinkSync(temporaryPath); } catch { /* best-effort temp cleanup */ }
    }
  }
}

function isSingleWriterLockRecord(value: unknown): value is SingleWriterLockRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<SingleWriterLockRecord>;
  return record.version === 2
    && Number.isSafeInteger(record.pid)
    && (record.pid ?? 0) > 0
    && Number.isSafeInteger(record.processStartTimeMs)
    && (record.processStartTimeMs ?? -1) >= 0
    && typeof record.acquisitionId === 'string'
    && record.acquisitionId.length > 0;
}

function classifyHolder(
  holder: HolderRecord,
  isAlive: (pid: number) => boolean,
  readStartTime: (pid: number) => number | null,
): 'stale' | 'active' | 'unknown' {
  if (holder.kind === 'missing') return 'stale';
  if (holder.kind === 'invalid') return 'unknown';
  if (!isAlive(holder.kind === 'legacy' ? holder.pid : holder.record.pid)) return 'stale';
  if (holder.kind === 'legacy') return 'active';

  const currentStartTimeMs = readStartTime(holder.record.pid);
  if (currentStartTimeMs === null) return 'unknown';
  return currentStartTimeMs === holder.record.processStartTimeMs ? 'active' : 'stale';
}

function sameAcquisition(left: SingleWriterLockRecord, right: SingleWriterLockRecord): boolean {
  return left.pid === right.pid
    && left.processStartTimeMs === right.processStartTimeMs
    && left.acquisitionId === right.acquisitionId;
}

function holderPid(holder: HolderRecord): number | null {
  if (holder.kind === 'legacy') return holder.pid;
  if (holder.kind === 'current') return holder.record.pid;
  return null;
}

function retryOrThrow(
  holder: HolderRecord,
  lockPath: string,
  kookrDir: string,
  deadline: number,
  retryIntervalMs: number,
  sleep: (ms: number) => void,
): void {
  if (Date.now() < deadline) {
    sleep(retryIntervalMs);
    return;
  }

  const pid = holderPid(holder);
  if (pid !== null) {
    throw new Error(
      `[single-writer] another Kookr server (pid ${pid}) already owns ${kookrDir} — `
      + 'refusing to start a second writer against the same data dir (RFC issue-ownership-lock R27). '
      + `Stop that process or inspect ${lockPath} if it is stale.`,
    );
  }
  throw new Error(
    `[single-writer] cannot verify the owner recorded in ${lockPath} — `
    + 'refusing to replace an unreadable data-directory lock. Ensure no Kookr server is running '
    + 'before removing it manually.',
  );
}

function isSqliteBusy(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT';
}

/**
 * True only for a process that can still run user code.
 * Zombies still satisfy `kill(pid, 0)` but cannot own the data dir — treat
 * them as stale so a planned restart is not blocked by an unreaped outgoing
 * pid (issue #2501).
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    // EPERM = alive but not ours; ESRCH = gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
  return !isZombiePid(pid);
}

function isZombiePid(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm is inside the last "(...)" and may contain spaces; state is the
    // next single character after that closing paren.
    const close = stat.lastIndexOf(')');
    if (close === -1) return false;
    return stat[close + 2] === 'Z';
  } catch {
    // No /proc (macOS). BSD and procps both expose state as the first
    // character of `ps -o stat=` (`Z`, `Z+`, `Zs`, …).
    try {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], {
        encoding: 'utf8',
        timeout: 1_000,
      }).trim();
      return out.startsWith('Z');
    } catch {
      return false;
    }
  }
}

function defaultSleep(ms: number): void {
  if (ms <= 0) return;
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}
