/**
 * Mid-process size-capped rotation for the prod `server.log` (issue #1991).
 *
 * `scripts/prod-restart.sh` already rotates generations on start, but multi-day
 * unattended runs can grow a single live `~/.kookr/server.log` without bound
 * between restarts. This module periodically stats the live log and, when it
 * exceeds a byte threshold **and** process stdout is that file, renames it
 * through the same `.1`/`.2`/… scheme the restart script uses, then reopens
 * process stdout/stderr onto a fresh file so subsequent writes are not lost to
 * the renamed inode. If that attach fails (for example ENOSPC after the
 * rename), the same process keeps a pending reopen and later timer ticks retry
 * creating/attaching the live file without shifting generations again
 * (issue #3176).
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
  /**
   * Test seam replacing `openSync` for creating/reopening the live log.
   * Production uses `fs.openSync`. Lets tests inject ENOSPC without patching
   * the Node builtin.
   */
  openSyncFn?: (path: string, flags: string) => number;
  /**
   * Process-owned pending-reopen state. Production uses the module singleton so
   * later timer ticks retry an interrupted attach. Tests inject a fresh
   * instance to stay isolated from other cases.
   */
  recovery?: ServerLogRotationRecovery;
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
  /**
   * True when this process renamed its live log but has not yet attached
   * stdout/stderr (or the approved write fallback) to a fresh live file.
   * Later ticks retry that attach without rotating generations again.
   */
  pendingReopen?: boolean;
  /** True when a later tick finished the pending attach/recreation. */
  recovered?: boolean;
  /** Reopen/create attempts performed this tick (bounded). */
  recoveryAttempts?: number;
}

/** Max reopen attempts during one rotation or recovery tick (issue #3176). */
export const MAX_LIVE_LOG_RECOVERY_ATTEMPTS_PER_TICK = 2;

interface PendingLiveLogRecovery {
  logPath: string;
  previousSize: number | null;
}

/**
 * Narrowly owned pending-reopen state for one interrupted rotation.
 *
 * Only a log path this process already verified ownership of and renamed may
 * enter this state. Later ticks retry attach/recreation for that path alone —
 * never journald/TTY streams or a never-owned missing file.
 */
export class ServerLogRotationRecovery {
  private pending: PendingLiveLogRecovery | null = null;

  peek(logPath: string): PendingLiveLogRecovery | null {
    return this.pending?.logPath === logPath ? this.pending : null;
  }

  mark(pending: PendingLiveLogRecovery): void {
    this.pending = pending;
  }

  clear(logPath: string): void {
    if (this.pending?.logPath === logPath) this.pending = null;
  }

  reset(): void {
    this.pending = null;
  }
}

const defaultLiveLogRecovery = new ServerLogRotationRecovery();

/** Drop process-owned pending reopen state (tests). */
export function clearPendingServerLogRecovery(): void {
  defaultLiveLogRecovery.reset();
}

/** Upper bound on the retained rotation-error message length (issue #3113). */
export const MAX_ROTATION_ERROR_LENGTH = 500;

/** Cheap in-memory `/api/health` shape for the server-log rotation timer (issue #3113). */
export interface ServerLogRotationHealthSnapshot {
  schemaVersion: 'server-log-rotation.v1';
  /** ISO timestamp of the most recent rotation tick, or `null` before the first. */
  lastRotationAt: string | null;
  /**
   * Message (only, bounded) of the most recent tick's error, or `null` when the
   * last tick had none. A successful rotation — or a clean skip — clears it.
   */
  lastRotationError: string | null;
  /** Skip reason from the most recent tick, or `null` when it rotated. */
  lastSkippedReason: ServerLogRotationSkipReason | null;
}

/**
 * In-memory health for the server-log rotation timer (issue #3113).
 *
 * The rotation tick runs each minute and previously discarded its result, so a
 * persistently failing rotation (ENOSPC / EACCES / read-only FS) — the one
 * condition that actually causes unbounded `server.log` growth — was invisible
 * to a remote operator: the routine only `console.error`s, into the very log
 * that is failing to rotate, and its own error lines are the first thing lost
 * once the 50 MiB cap is blown. This retains the last tick's timestamp, error
 * message, and skip reason and projects them onto `/api/health`, mirroring the
 * emergency-prune error surface (#3078 / #2344).
 *
 * Stores only the bounded error message, never the full error object.
 */
export class ServerLogRotationHealth {
  private lastRotationAt: string | null = null;
  private lastRotationError: string | null = null;
  private lastSkippedReason: ServerLogRotationSkipReason | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Retain the observable fields from one rotation tick's result. Pure in-memory
   * assignment — does not throw for any real {@link ServerLogRotationResult}
   * (production uses the default `Date.now` clock).
   */
  record(result: ServerLogRotationResult): void {
    this.lastRotationAt = new Date(this.now()).toISOString();
    this.lastRotationError =
      result.error != null ? result.error.slice(0, MAX_ROTATION_ERROR_LENGTH) : null;
    this.lastSkippedReason = result.skippedReason ?? null;
  }

  getHealthSnapshot(): ServerLogRotationHealthSnapshot {
    return {
      schemaVersion: 'server-log-rotation.v1',
      lastRotationAt: this.lastRotationAt,
      lastRotationError: this.lastRotationError,
      lastSkippedReason: this.lastSkippedReason,
    };
  }
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

type OpenAppendFn = (path: string, flags: string) => number;

function closeIfOpen(fd: number): void {
  try {
    fstatSync(fd);
    closeSync(fd);
  } catch {
    // Already closed (failed freopen after rename) — leave the slot free so
    // the next open can reuse fd 1/2. Empty catch: fstat/close here is the
    // probe, and logging through the same stdio would recurse.
  }
}

function isFdOpen(fd: number): boolean {
  try {
    fstatSync(fd);
    return true;
  } catch {
    return false;
  }
}

type ReopenMode = 'rotate' | 'recover';

/**
 * Reopen process stdout (fd 1) and stderr (fd 2) onto `logPath` in append mode.
 *
 * Relies on POSIX lowest-free-fd allocation: after closing 1, the next open is
 * expected to return 1; same for 2. Throws if the OS returns a different fd so
 * we never silently write the live log to an unexpected descriptor.
 *
 * Same-tick rotation (`rotate`) still closes the fds this process just owned.
 * Later-tick recovery (`recover`) never closes an occupied fd 1/2 — after a
 * failed freopen those slots can have been reused by SQLite/HTTP — and throws
 * so the write fallback can attach without stealing.
 *
 * Call only after {@link processStdoutPointsAtLog} confirmed ownership, or from
 * pending recovery for a rotation this process already owned. Between close
 * and open the lowest free fd can theoretically be stolen by another thread's
 * open(2); the fd≠1/2 checks fail closed on that race.
 */
export function reopenProcessStdio(logPath: string): void {
  reopenProcessStdioWith(logPath, (path, flags) => openSync(path, flags), 'rotate');
}

function reopenProcessStdioWith(
  logPath: string,
  openFn: OpenAppendFn,
  mode: ReopenMode,
): void {
  if (mode === 'recover') {
    if (isFdOpen(1)) {
      throw new Error('refusing to steal occupied stdout fd 1 during live-log recovery');
    }
    const stdoutFd = openFn(logPath, 'a');
    if (stdoutFd !== 1) {
      throw new Error(`expected freopen stdout fd 1, got ${stdoutFd}`);
    }
    if (isFdOpen(2)) {
      throw new Error('refusing to steal occupied stderr fd 2 during live-log recovery');
    }
    const stderrFd = openFn(logPath, 'a');
    if (stderrFd !== 2) {
      throw new Error(`expected freopen stderr fd 2, got ${stderrFd}`);
    }
    return;
  }

  closeIfOpen(1);
  const stdoutFd = openFn(logPath, 'a');
  if (stdoutFd !== 1) {
    throw new Error(`expected freopen stdout fd 1, got ${stdoutFd}`);
  }

  closeIfOpen(2);
  const stderrFd = openFn(logPath, 'a');
  if (stderrFd !== 2) {
    throw new Error(`expected freopen stderr fd 2, got ${stderrFd}`);
  }
}

/**
 * Last-resort: if freopen left stdio broken, route process.stdout/stderr writes
 * through an append FD so the process keeps logging to `logPath`.
 */
function installStdioWriteFallback(logPath: string, openFn: OpenAppendFn): void {
  const fd = openFn(logPath, 'a');
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

function ensureLiveLogExists(logPath: string, openFn: OpenAppendFn): void {
  const fd = openFn(logPath, 'a');
  closeSync(fd);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolveOpenAppend(config: ServerLogRotationConfig): OpenAppendFn {
  return config.openSyncFn ?? ((path, flags) => openSync(path, flags));
}

function resolveReopen(
  config: ServerLogRotationConfig,
  openFn: OpenAppendFn,
  mode: ReopenMode,
): (logPath: string) => void {
  if (config.reopenStdioFn) return config.reopenStdioFn;
  return (logPath) => reopenProcessStdioWith(logPath, openFn, mode);
}

function resolveRecovery(config: ServerLogRotationConfig): ServerLogRotationRecovery {
  return config.recovery ?? defaultLiveLogRecovery;
}

interface AttachLiveStdioResult {
  attached: boolean;
  error?: string;
  attempts: number;
}

/**
 * Recreate the live log if needed and attach stdio (or the approved write
 * fallback). Bounded to {@link MAX_LIVE_LOG_RECOVERY_ATTEMPTS_PER_TICK}
 * reopen tries plus one fallback. Does not shift generations.
 */
function tryAttachLiveStdio(
  logPath: string,
  shouldReopen: boolean,
  reopen: (logPath: string) => void,
  openFn: OpenAppendFn,
): AttachLiveStdioResult {
  if (!shouldReopen) {
    try {
      if (!existsSync(logPath)) {
        ensureLiveLogExists(logPath, openFn);
      }
      return { attached: existsSync(logPath), attempts: 1 };
    } catch (err) {
      return { attached: false, attempts: 1, error: errorMessage(err) };
    }
  }

  let attempts = 0;
  try {
    attempts += 1;
    reopen(logPath);
    return { attached: true, attempts };
  } catch (firstErr) {
    try {
      ensureLiveLogExists(logPath, openFn);
    } catch (ensureErr) {
      return { attached: false, attempts, error: errorMessage(ensureErr) };
    }
    if (attempts >= MAX_LIVE_LOG_RECOVERY_ATTEMPTS_PER_TICK) {
      return { attached: false, attempts, error: errorMessage(firstErr) };
    }
    try {
      attempts += 1;
      reopen(logPath);
      return {
        attached: true,
        attempts,
        error: `freopen retried after: ${errorMessage(firstErr)}`,
      };
    } catch (secondErr) {
      try {
        installStdioWriteFallback(logPath, openFn);
        return {
          attached: true,
          attempts,
          error: `freopen failed after rename: ${errorMessage(secondErr)}`,
        };
      } catch {
        return {
          attached: false,
          attempts,
          error: `freopen failed after rename: ${errorMessage(secondErr)}`,
        };
      }
    }
  }
}

function recoverPendingLiveLog(
  config: ServerLogRotationConfig,
  pending: PendingLiveLogRecovery,
): ServerLogRotationResult {
  const shouldReopen = config.reopenStdio !== false;
  const openFn = resolveOpenAppend(config);
  const reopen = resolveReopen(config, openFn, 'recover');
  const recovery = resolveRecovery(config);
  const attach = tryAttachLiveStdio(config.logPath, shouldReopen, reopen, openFn);
  if (attach.attached) {
    recovery.clear(config.logPath);
    return {
      rotated: false,
      previousSize: pending.previousSize,
      recovered: true,
      error: attach.error,
      recoveryAttempts: attach.attempts,
    };
  }
  return {
    rotated: false,
    previousSize: pending.previousSize,
    skippedReason: 'error',
    error: attach.error,
    pendingReopen: true,
    recoveryAttempts: attach.attempts,
  };
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
 * true and a fallback write path is installed so logging keeps working. If
 * even that attach fails, a process-owned pending reopen is kept so the next
 * tick retries recreation without shifting generations again (issue #3176).
 */
export function maybeRotateServerLog(config: ServerLogRotationConfig): ServerLogRotationResult {
  const recovery = resolveRecovery(config);
  const pending = recovery.peek(config.logPath);
  if (pending) {
    // Retry the interrupted attach before missing/size/ownership early
    // returns. Generations were already shifted on the tick that set pending.
    return recoverPendingLiveLog(config, pending);
  }

  const maxBytes = Math.max(0, Math.floor(config.maxBytes));
  const generations = clampGenerations(config.generations);

  if (maxBytes <= 0 || generations <= 0) {
    return { rotated: false, previousSize: null, skippedReason: 'disabled' };
  }

  let previousSize: number | null = null;
  let renamed = false;
  const openFn = resolveOpenAppend(config);
  const shouldReopen = config.reopenStdio !== false;

  try {
    const statSize = config.statSize ?? defaultStatSize;
    previousSize = statSize(config.logPath);
    if (previousSize === null) {
      return { rotated: false, previousSize: null, skippedReason: 'missing' };
    }
    if (previousSize <= maxBytes) {
      return { rotated: false, previousSize, skippedReason: 'under-threshold' };
    }

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

    const reopen = resolveReopen(config, openFn, 'rotate');
    const attach = tryAttachLiveStdio(config.logPath, shouldReopen, reopen, openFn);
    if (!attach.attached) {
      recovery.mark({ logPath: config.logPath, previousSize });
      return {
        rotated: true,
        previousSize,
        error: attach.error,
        pendingReopen: true,
        recoveryAttempts: attach.attempts,
      };
    }
    return {
      rotated: true,
      previousSize,
      error: attach.error,
      recoveryAttempts: attach.attempts,
    };
  } catch (err) {
    // If we already renamed, do not report rotated:false — that would strand
    // the size-cap (next ticks see missing live file and permanently no-op).
    if (renamed) {
      const attach = tryAttachLiveStdio(
        config.logPath,
        shouldReopen,
        resolveReopen(config, openFn, 'rotate'),
        openFn,
      );
      if (!attach.attached) {
        recovery.mark({ logPath: config.logPath, previousSize });
      }
      return {
        rotated: true,
        previousSize,
        error: errorMessage(err),
        pendingReopen: attach.attached ? undefined : true,
        recoveryAttempts: attach.attempts,
      };
    }
    return {
      rotated: false,
      previousSize,
      skippedReason: 'error',
      error: errorMessage(err),
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
  } else if (result.recovered) {
    const line = `[server-log-rotation] restored live log ${config.logPath}\n`;
    // writeSync(1) is only safe when fd 1 is still the live log. After ENOSPC,
    // POSIX may have reused that slot; fallback patches process.stdout.write
    // onto a new fd. Hitting the reused slot would corrupt SQLite/HTTP.
    try {
      if (processStdoutPointsAtLog(config.logPath)) {
        writeSync(1, line);
      } else {
        console.log(line.trimEnd());
      }
    } catch {
      try {
        console.log(line.trimEnd());
      } catch {
        // Last-resort swallow — logging was restored via fallback or reopen.
      }
    }
    if (result.error) {
      console.error('[server-log-rotation] post-restore warning:', result.error);
    }
  } else if (result.skippedReason === 'error') {
    console.error('[server-log-rotation] rotation failed:', result.error);
  }
  return result;
}
