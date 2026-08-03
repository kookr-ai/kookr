/**
 * Mid-process size-capped rotation for the prod `server.log` (issue #1991).
 *
 * `scripts/prod-restart.sh` already rotates generations on start, but multi-day
 * unattended runs can grow a single live `~/.kookr/server.log` without bound
 * between restarts. This module periodically stats the live log and, when it
 * exceeds a byte threshold, renames it through the same `.1`/`.2`/… scheme the
 * restart script uses, then reopens process stdout/stderr onto a fresh file so
 * subsequent writes are not lost to the renamed inode.
 *
 * Production launches redirect with `node … > server.log 2>&1`, so the process
 * holds FDs 1 and 2 on the live log. A bare rename leaves those FDs pointed at
 * the generation file; freopen (close + open-on-lowest-fd) is required.
 */

import {
  closeSync,
  existsSync,
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
   * `reopenStdio`) so they never touch the test runner's FDs.
   */
  reopenStdio?: boolean;
  /** Test seam replacing the OS freopen. */
  reopenStdioFn?: (logPath: string) => void;
  /** Test seam for `statSync`. */
  statSize?: (path: string) => number | null;
}

export interface ServerLogRotationResult {
  /** True when a rotation was performed. */
  rotated: boolean;
  /** Size observed before the decision, in bytes. `null` when the file was missing. */
  previousSize: number | null;
  /** Why rotation did not run, when `rotated` is false. */
  skippedReason?: 'missing' | 'under-threshold' | 'disabled' | 'error';
  /** Error message when rotation threw; never rethrown to callers. */
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
 * Reopen process stdout (fd 1) and stderr (fd 2) onto `logPath` in append mode.
 *
 * Relies on POSIX lowest-free-fd allocation: after closing 1, the next open is
 * expected to return 1; same for 2. Throws if the OS returns a different fd so
 * we never silently write the live log to an unexpected descriptor.
 *
 * Not safe under concurrent opens from other threads between close and open;
 * the server's JS thread is single-threaded and this path runs synchronously
 * with no awaits between close and open.
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
 * Rotate `logPath` when it exceeds `maxBytes`. Optionally reopens process
 * stdio onto a fresh file so appends after rotation are not lost.
 *
 * Errors are captured on the result (never thrown) so a timer tick cannot
 * crash the server.
 */
export function maybeRotateServerLog(config: ServerLogRotationConfig): ServerLogRotationResult {
  const maxBytes = Math.max(0, Math.floor(config.maxBytes));
  const generations = clampGenerations(config.generations);

  if (maxBytes <= 0 || generations <= 0) {
    return { rotated: false, previousSize: null, skippedReason: 'disabled' };
  }

  try {
    const statSize = config.statSize ?? defaultStatSize;
    const previousSize = statSize(config.logPath);
    if (previousSize === null) {
      return { rotated: false, previousSize: null, skippedReason: 'missing' };
    }
    if (previousSize <= maxBytes) {
      return { rotated: false, previousSize, skippedReason: 'under-threshold' };
    }

    rotateServerLogGenerations(config.logPath, generations);

    const shouldReopen = config.reopenStdio !== false;
    if (shouldReopen) {
      const reopen = config.reopenStdioFn ?? reopenProcessStdio;
      reopen(config.logPath);
    } else if (!existsSync(config.logPath)) {
      // Test / no-reopen path: create an empty live file so subsequent appends
      // have a target without touching process FDs.
      const fd = openSync(config.logPath, 'a');
      closeSync(fd);
    }

    return { rotated: true, previousSize };
  } catch (err) {
    return {
      rotated: false,
      previousSize: null,
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
  } else if (result.skippedReason === 'error') {
    console.error('[server-log-rotation] rotation failed:', result.error);
  }
  return result;
}
