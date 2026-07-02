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
 * A stale lock (crashed process, SIGKILL'd restart) is detected via a
 * `kill(pid, 0)` liveness probe and taken over silently.
 */
export function acquireSingleWriterLock(kookrDir: string): () => void {
  const lockPath = join(kookrDir, 'server.pid');
  mkdirSync(kookrDir, { recursive: true });

  const takeLock = (): void => writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });

  try {
    takeLock();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const holderPid = readHolderPid(lockPath);
    if (holderPid !== null && holderPid !== process.pid && isProcessAlive(holderPid)) {
      throw new Error(
        `[single-writer] another Kookr server (pid ${holderPid}) already owns ${kookrDir} — `
        + 'refusing to start a second writer against the same data dir (RFC issue-ownership-lock R27). '
        + `Stop that process or remove ${lockPath} if it is stale.`,
      );
    }
    // Stale (dead holder) or unreadable lock: take over.
    try {
      unlinkSync(lockPath);
    } catch {
      // Raced with another cleanup; fall through to the exclusive write.
    }
    takeLock();
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = alive but not ours; ESRCH = gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
