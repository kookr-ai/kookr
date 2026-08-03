/**
 * Mid-process size-capped rotation for the prod `server.log` (issue #1991).
 *
 * `scripts/prod-restart.sh` already rotates generations on start, but multi-day
 * unattended runs can grow a single live `~/.kookr/server.log` without bound
 * between restarts. This module periodically stats the live log and, when it
 * exceeds a byte threshold **and** process stdout is that file, renames it
 * through the same `.1`/`.2`/… scheme the restart script uses, then reopens
 * process stdout/stderr onto a fresh file so subsequent writes are not lost to
 * the renamed inode.
 *
 * Production script launches redirect with `node … > server.log 2>&1`, so the
 * process holds FDs 1 and 2 on the live log. A bare rename leaves those FDs
 * pointed at the generation file; freopen (close + open-on-lowest-fd) is
 * required. systemd/journald and interactive TTY launches do **not** attach
 * stdio to `server.log` — freopen is skipped (and rotation is skipped) so we
 * never steal journald/TTY streams.
 */

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

/** Default size threshold before rotation (50 MiB). */
export const DEFAULT_SERVER_LOG_MAX_BYTES = 50 * 1024 * 1024;

/** Default retained rotated generations (matches `KOOKR_LOG_GENERATIONS` in prod-restart). */
export const DEFAULT_SERVER_LOG_GENERATIONS = 3;

/** Default periodic check interval (60s). `stat` is cheap; catch runaway growth quickly. */
export const DEFAULT_SERVER_LOG_ROTATE_INTERVAL_MS = 60_000;

/** Hard cap on retained generations (matches prod-restart `MAX_LOG_GENERATIONS`). */
export const MAX_SERVER_LOG_GENERATIONS = 100;

export interface ServerLogRotationConfig {
  /** Absolute path to the live `server.log`. */
  logPath: string;
  /** Rotate when the live file size is strictly greater than this many bytes. */
  maxBytes: number;
  /** Number of rotated generations to retain (`.1` … `.N`). `0` disables rotation. */
  generations: number;
  /**
   * When true (default), reopen process stdout/stderr onto a fresh `logPath`
   * after renaming the live file. Tests inject `false` (or a custom
   * `reopenStdioFn`) so they never touch the test runner's FDs.
   */
  reopenStdio?: boolean;
  /** Test seam replacing the OS freopen. */
  reopenStdioFn?: (logPath: string) => void;
  /** Test seam for `statSync` size. */
  statSize?: (path: string) => number | null;
  /**
   * Test seam for the stdout-owns-log gate. Production uses
   * {@link processStdoutPointsAtLog}. When `reopenStdio === false` the gate is
   * skipped (unit tests rotate without claiming runner FDs).
   */
  stdioOwnsLog?: (logPath: string) => boolean;
}

export type ServerLogRotationSkipReason =
  | 'missing'
  | 'under-threshold'
  | 'disabled'
  | 'stdio-not-attached'
  | 'error';

export interface ServerLogRotationResult {
  /** True when generations were shifted (rename of the live file succeeded). */
  rotated: boolean;
  /** Size observed before the decision, in bytes. `null` when the file was missing. */
  previousSize: number | null;
  /** Why rotation did not run, when `rotated` is false. */
  skippedReason?: ServerLogRotationSkipReason;
  /**
   * Non-fatal follow-up problem after a successful rename (e.g. freopen failed
   * once then recovered via fallback, or freopen still degraded). Present only
   * when useful for logs; never thrown.
   */
  error?: string;
}

export interface ResolvedServerLogRotationEnv {
  /** Absolute live log path (`{dataDir}/server.log`). */
  logPath: string;
  maxBytes: number;
  generations: number;
  /** Check interval in ms. `0` disables the timer. */
  intervalMs: number;
}

/**
 * Resolve rotation knobs from the environment.
 *
 * | Variable | Default | Notes |
 * | --- | --- | --- |
 * | `KOOKR_SERVER_LOG_MAX_BYTES` | 52428800 (50 MiB) | `0` disables mid-process rotation |
 * | `KOOKR_LOG_GENERATIONS` | 3 | Shared with prod-restart; `0` disables |
 * | `KOOKR_SERVER_LOG_ROTATE_INTERVAL_MS` | 60000 | `0` disables the timer |
 */
export function resolveServerLogRotationEnv(
  env: NodeJS.ProcessEnv = process.env,
  dataDir: string,
): ResolvedServerLogRotationEnv {
  return {
    logPath: join(dataDir, 'server.log'),
    maxBytes: parseNonNegativeInt(env.KOOKR_SERVER_LOG_MAX_BYTES, DEFAULT_SERVER_LOG_MAX_BYTES),
    generations: clampGenerations(
      parseNonNegativeInt(env.KOOKR_LOG_GENERATIONS, DEFAULT_SERVER_LOG_GENERATIONS),
    ),
    intervalMs: parseNonNegativeInt(
      env.KOOKR_SERVER_LOG_ROTATE_INTERVAL_MS,
      DEFAULT_SERVER_LOG_ROTATE_INTERVAL_MS,
    ),
  };
}

function parseNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function clampGenerations(value: number): number {
  if (value <= 0) return 0;
  return Math.min(value, MAX_SERVER_LOG_GENERATIONS);
}

/**
 * True when process stdout (fd 1) is open on the same inode as `logPath`.
 * Used so we never freopen journald/TTY/pipe stdio onto `server.log` just
 * because a leftover log file on disk exceeded the size cap.
 */
export function processStdoutPointsAtLog(logPath: string): boolean {
  try {
    const logStat = statSync(logPath);
    const outStat = fstatSync(1);
    return outStat.dev === logStat.dev && outStat.ino === logStat.ino;
  } catch {
    return false;
  }
}

/**
 * Reopen process stdout (fd 1) and stderr (fd 2) onto `logPath` in append mode.
 *
 * Relies on POSIX lowest-free-fd allocation: after closing 1, the next open is
 * expected to return 1; same for 2. Throws if the OS returns a different fd so
 * we never silently write the live log to an unexpected descriptor.
 *
 * Call only after {@link processStdoutPointsAtLog} confirmed ownership. Between
 * close and open the lowest free fd can theoretically be stolen by another
 * thread's open(2); the fd≠1/2 checks fail closed on that race.
 */
export function reopenProcessStdio(logPath: string): void {
  closeSync(1);
  const stdoutFd = openSync(logPath, 'a');
  if (stdoutFd !== 1) {
    throw new Error(`expected freopen stdout fd 1, got ${stdoutFd}`);
  }

  closeSync(2);
  const stderrFd = openSync(logPath, 'a');
  if (stderrFd !== 2) {
    throw new Error(`expected freopen stderr fd 2, got ${stderrFd}`);
  }
}

/**
 * Last-resort: if freopen left stdio broken, route process.stdout/stderr writes
 * through an append FD so the process keeps logging to `logPath`.
 */
function installStdioWriteFallback(logPath: string): void {
  const fd = openSync(logPath, 'a');
  const write = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    try {
      if (typeof chunk === 'string') {
        const enc = typeof encoding === 'string' ? encoding : 'utf8';
        writeSync(fd, chunk, undefined, enc);
      } else {
        writeSync(fd, chunk);
      }
      if (typeof encoding === 'function') encoding(null);
      else if (typeof cb === 'function') cb(null);
      return true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (typeof encoding === 'function') encoding(error);
      else if (typeof cb === 'function') cb(error);
      return false;
    }
  };
  process.stdout.write = write as typeof process.stdout.write;
  process.stderr.write = write as typeof process.stderr.write;
}

function ensureLiveLogExists(logPath: string): void {
  const fd = openSync(logPath, 'a');
  closeSync(fd);
}

/**
 * Shift numbered generations and rename the live log to `.1`, matching
 * `rotate_server_log` in `scripts/prod-restart.sh`.
 *
 * Does **not** reopen stdio — callers that hold FDs on the live path must
 * freopen afterwards (see {@link maybeRotateServerLog}).
 */
export function rotateServerLogGenerations(logPath: string, generations: number): void {
  const retained = clampGenerations(generations);
  if (retained <= 0) return;

  // Drop anything at/above the retention ceiling (and clean a stale upper bound).
  for (let i = retained; i <= MAX_SERVER_LOG_GENERATIONS; i++) {
    try {
      unlinkSync(`${logPath}.${i}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  for (let generation = retained - 1; generation >= 1; generation--) {
    try {
      renameSync(`${logPath}.${generation}`, `${logPath}.${generation + 1}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  try {
    renameSync(logPath, `${logPath}.1`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function defaultStatSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Rotate `logPath` when it exceeds `maxBytes` and this process owns the live
 * FD (stdout points at the log). Reopens stdio onto a fresh file so appends
 * after rotation are not lost.
 *
 * Errors are captured on the result (never thrown) so a timer tick cannot
 * crash the server. If rename succeeds but freopen fails, `rotated` is still
 * true and a fallback write path is installed so logging keeps working.
 */
export function maybeRotateServerLog(config: ServerLogRotationConfig): ServerLogRotationResult {
  const maxBytes = Math.max(0, Math.floor(config.maxBytes));
  const generations = clampGenerations(config.generations);

  if (maxBytes <= 0 || generations <= 0) {
    return { rotated: false, previousSize: null, skippedReason: 'disabled' };
  }

  let previousSize: number | null = null;
  let renamed = false;

  try {
    const statSize = config.statSize ?? defaultStatSize;
    previousSize = statSize(config.logPath);
    if (previousSize === null) {
      return { rotated: false, previousSize: null, skippedReason: 'missing' };
    }
    if (previousSize <= maxBytes) {
      return { rotated: false, previousSize, skippedReason: 'under-threshold' };
    }

    const shouldReopen = config.reopenStdio !== false;
    // When reopening is requested, only rotate if stdout is the live log —
    // otherwise we would steal journald/TTY stdio (or rename a file we are not
    // writing to). Unit tests set reopenStdio:false and skip this gate.
    if (shouldReopen) {
      const owns = config.stdioOwnsLog ?? processStdoutPointsAtLog;
      if (!owns(config.logPath)) {
        return { rotated: false, previousSize, skippedReason: 'stdio-not-attached' };
      }
    }

    rotateServerLogGenerations(config.logPath, generations);
    renamed = true;

    if (shouldReopen) {
      const reopen = config.reopenStdioFn ?? reopenProcessStdio;
      try {
        reopen(config.logPath);
      } catch (firstErr) {
        // Rename already happened — keep rotated:true and recover.
        ensureLiveLogExists(config.logPath);
        try {
          reopen(config.logPath);
          return {
            rotated: true,
            previousSize,
            error:
              `freopen retried after: ${
                firstErr instanceof Error ? firstErr.message : String(firstErr)
              }`,
          };
        } catch (secondErr) {
          try {
            installStdioWriteFallback(config.logPath);
          } catch {
            // Fallback install failed; still report the freopen error.
          }
          return {
            rotated: true,
            previousSize,
            error:
              `freopen failed after rename: ${
                secondErr instanceof Error ? secondErr.message : String(secondErr)
              }`,
          };
        }
      }
    } else if (!existsSync(config.logPath)) {
      // Test / no-reopen path: create an empty live file so subsequent appends
      // have a target without touching process FDs.
      ensureLiveLogExists(config.logPath);
    }

    return { rotated: true, previousSize };
  } catch (err) {
    // If we already renamed, do not report rotated:false — that would strand
    // the size-cap (next ticks see missing live file and permanently no-op).
    if (renamed) {
      try {
        ensureLiveLogExists(config.logPath);
      } catch {
        // ignore
      }
      return {
        rotated: true,
        previousSize,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return {
      rotated: false,
      previousSize,
      skippedReason: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Timer tick: rotate when needed and emit a single structured log line.
 * Never throws.
 */
export function runScheduledServerLogRotation(config: ServerLogRotationConfig): ServerLogRotationResult {
  const result = maybeRotateServerLog(config);
  if (result.rotated) {
    // Prefer writeSync on fd 1 so the breadcrumb lands on the *fresh* log after
    // freopen, even if console state is mid-transition.
    const line =
      `[server-log-rotation] rotated ${config.logPath} ` +
      `(was ${result.previousSize} bytes; retaining ${clampGenerations(config.generations)} generation(s))\n`;
    try {
      writeSync(1, line);
    } catch {
      try {
        console.log(line.trimEnd());
      } catch {
        // Last-resort swallow — rotation already succeeded.
      }
    }
    if (result.error) {
      console.error('[server-log-rotation] post-rotate warning:', result.error);
    }
  } else if (result.skippedReason === 'error') {
    console.error('[server-log-rotation] rotation failed:', result.error);
  }
  return result;
}
