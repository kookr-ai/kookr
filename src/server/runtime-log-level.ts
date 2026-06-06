/**
 * Runtime debug-verbosity control (issue #662).
 *
 * Kookr supervises long-lived agent sessions, so "restart to get debug logs"
 * means killing in-flight work — exactly when an operator least wants to. This
 * module holds a process-global, runtime-mutable log level so verbosity can be
 * raised/lowered on the *running* process via the admin endpoint in
 * {@link ./routes/admin-routes.ts}, with an optional TTL that auto-reverts so a
 * forgotten `debug` doesn't flood the unrotated `~/.kookr/server.log` forever.
 *
 * This is deliberately a thin shim, not a structured-logging migration: call
 * sites that previously consulted the startup-only `KOOKR_DEBUG` flag can switch
 * to {@link isDebugEnabled}/{@link isLevelEnabled} to become runtime-aware. The
 * default level is seeded from `KOOKR_DEBUG` so existing behavior is preserved
 * (`KOOKR_DEBUG` env ownership/docs stays with the parallel #663 work).
 */

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Higher rank means more verbose. A level is enabled when the current rank is >= its rank. */
const LEVEL_RANK: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** Cap so a fat-fingered TTL can't pin `debug` on for an unreasonable span. */
const MAX_TTL_SECONDS = 24 * 60 * 60;

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Seed the default level from the startup-only `KOOKR_DEBUG` flag. */
function seedDefaultLevel(): LogLevel {
  const raw = process.env.KOOKR_DEBUG?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' ? 'debug' : 'info';
}

let defaultLevel: LogLevel = seedDefaultLevel();
let currentLevel: LogLevel = defaultLevel;
/** Epoch ms at which an active TTL override reverts to {@link defaultLevel}; null when none. */
let ttlExpiresAt: number | null = null;
let revertTimer: ReturnType<typeof setTimeout> | null = null;

function clearRevertTimer(): void {
  if (revertTimer) {
    clearTimeout(revertTimer);
    revertTimer = null;
  }
}

function revertToDefault(): void {
  currentLevel = defaultLevel;
  ttlExpiresAt = null;
  clearRevertTimer();
}

/**
 * Lazy backstop for the setTimeout-based revert: if the timer somehow didn't
 * fire (e.g. a paused/blocked event loop), any read still sees an expired TTL
 * collapse back to the default.
 */
function maybeExpire(): void {
  if (ttlExpiresAt !== null && Date.now() >= ttlExpiresAt) {
    revertToDefault();
  }
}

export function getLogLevel(): LogLevel {
  maybeExpire();
  return currentLevel;
}

/** True when `level` is at or below the current verbosity (i.e. would be emitted). */
export function isLevelEnabled(level: LogLevel): boolean {
  return LEVEL_RANK[getLogLevel()] >= LEVEL_RANK[level];
}

/** Runtime-aware replacement for the static `KOOKR_DEBUG` check. */
export function isDebugEnabled(): boolean {
  return isLevelEnabled('debug');
}

export interface LogLevelState {
  /** Active level right now. */
  level: LogLevel;
  /** Level a TTL override reverts to (seeded from `KOOKR_DEBUG`). */
  default: LogLevel;
  /** Epoch ms when the current override auto-reverts; null when no TTL is set. */
  ttlExpiresAt: number | null;
}

export function getLogLevelState(): LogLevelState {
  maybeExpire();
  return { level: currentLevel, default: defaultLevel, ttlExpiresAt };
}

export type SetLogLevelError = 'invalid-level' | 'invalid-ttl';

export interface SetLogLevelResult {
  ok: boolean;
  error?: SetLogLevelError;
}

/**
 * Set the runtime level. Pass `ttlSeconds` to auto-revert to the default after
 * that span (whole seconds, clamped to {@link MAX_TTL_SECONDS}); omit it for a
 * sticky change. Returns a discriminated result rather than throwing so the
 * route can map validation failures to a 400.
 */
export function setLogLevel(level: unknown, ttlSeconds?: unknown): SetLogLevelResult {
  if (!isLogLevel(level)) {
    return { ok: false, error: 'invalid-level' };
  }

  let ttl: number | null = null;
  if (ttlSeconds !== undefined && ttlSeconds !== null) {
    if (typeof ttlSeconds !== 'number' || !Number.isFinite(ttlSeconds)) {
      return { ok: false, error: 'invalid-ttl' };
    }
    // Floor to whole seconds, then reject sub-second TTLs: a value in (0, 1)
    // would otherwise floor to 0 and be accepted as a no-op that instantly
    // reverts — reporting success for a change that never took effect.
    const floored = Math.floor(ttlSeconds);
    if (floored < 1) {
      return { ok: false, error: 'invalid-ttl' };
    }
    ttl = Math.min(floored, MAX_TTL_SECONDS);
  }

  clearRevertTimer();
  currentLevel = level;

  if (ttl !== null) {
    ttlExpiresAt = Date.now() + ttl * 1000;
    revertTimer = setTimeout(revertToDefault, ttl * 1000);
    // A log-level revert must never keep the process alive on its own.
    revertTimer.unref?.();
  } else {
    ttlExpiresAt = null;
  }

  return { ok: true };
}

/** Test seam: re-seed the default from the current env and clear any override. */
export function resetLogLevel(): void {
  clearRevertTimer();
  defaultLevel = seedDefaultLevel();
  currentLevel = defaultLevel;
  ttlExpiresAt = null;
}
