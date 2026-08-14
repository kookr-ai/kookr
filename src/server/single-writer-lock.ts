import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Startup single-writer assertion (RFC rfc-issue-ownership-lock R27).
 *
 * Kookr's persistence (`tasks.json`, no OS file lock) and the issue-claim
 * CAS both inherit the assumption that exactly ONE server process owns a
 * data dir. The port bind enforces this eventually, but boot-time task
 * mutations (reconcile, claim rebuild) run BEFORE the bind — so a second
 * process pointed at the same dir could silently interleave writes during
 * that window. This pid-file lock makes the assumption fail loudly instead.
 *
 * A stale lock (crashed process, SIGKILL'd restart, or a zombie that
 * `kill(pid, 0)` still reports as present) is detected via a liveness
 * probe and taken over silently.
 *
 * Planned restarts close the HTTP listen socket before they unlink this
 * pid file. The incoming process therefore often sees a still-live holder
 * for a few hundred milliseconds. We retry for a short window so
 * `pnpm prod:update` does not die with "exited before becoming healthy"
 * (issue #2501). A second *unrelated* server still fails after that window.
 */

/** Default retry budget when another live pid holds the lock (issue #2501). */
export const SINGLE_WRITER_LOCK_RETRY_MS = 5_000;
/** Pause between exclusive-create attempts while waiting for the outgoing holder. */
export const SINGLE_WRITER_LOCK_RETRY_INTERVAL_MS = 50;

export interface AcquireSingleWriterLockOptions {
  /** How long to keep retrying when another live process holds the lock. */
  retryMs?: number;
  /** Sleep between retries. */
  retryIntervalMs?: number;
  /** Test seam: replace `Atomics.wait` so retry tests stay synchronous and fast. */
  sleep?: (ms: number) => void;
  /** Test seam: replace the pid liveness probe. */
  isAlive?: (pid: number) => boolean;
}

export function acquireSingleWriterLock(
  kookrDir: string,
  options: AcquireSingleWriterLockOptions = {},
): () => void {
  const lockPath = join(kookrDir, 'server.pid');
  mkdirSync(kookrDir, { recursive: true });

  const retryMs = options.retryMs ?? SINGLE_WRITER_LOCK_RETRY_MS;
  const retryIntervalMs = options.retryIntervalMs ?? SINGLE_WRITER_LOCK_RETRY_INTERVAL_MS;
  const sleep = options.sleep ?? defaultSleep;
  const isAlive = options.isAlive ?? isProcessAlive;
  const deadline = Date.now() + Math.max(0, retryMs);

  const takeLock = (): void => writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });

  for (;;) {
    try {
      takeLock();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holderPid = readHolderPid(lockPath);
      const holderIsOtherLive =
        holderPid !== null
        && holderPid !== process.pid
        && isAlive(holderPid);
      if (holderIsOtherLive) {
        if (Date.now() < deadline) {
          sleep(retryIntervalMs);
          continue;
        }
        throw new Error(
          `[single-writer] another Kookr server (pid ${holderPid}) already owns ${kookrDir} — `
          + 'refusing to start a second writer against the same data dir (RFC issue-ownership-lock R27). '
          + `Stop that process or remove ${lockPath} if it is stale.`,
        );
      }
      // Stale (dead / zombie holder) or unreadable lock: take over.
      try {
        unlinkSync(lockPath);
      } catch {
        // Raced with another cleanup; fall through to the exclusive write.
      }
    }
  }

  return () => {
    try {
      if (readHolderPid(lockPath) === process.pid) unlinkSync(lockPath);
    } catch {
      // Best-effort release; a stale file is recovered by the next boot's liveness probe.
    }
  };
}

function readHolderPid(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * True only for a process that can still run user code.
 * Zombies still satisfy `kill(pid, 0)` but cannot own the data dir — treat
 * them as stale so a planned restart is not blocked by an unreaped outgoing
 * pid (issue #2501).
 */
export function isProcessAlive(pid: number): boolean {
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
