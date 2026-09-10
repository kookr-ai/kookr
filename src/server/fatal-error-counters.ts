/**
 * Process-fatal error counters (issue #3112).
 *
 * The process-level `uncaughtException` and `unhandledRejection` handlers in
 * {@link file://./start.ts} log a `[fatal] …` line and continue — correctly
 * keeping the daemon alive — but pre-#3112 they retained nothing observable, so
 * a daemon quietly absorbing fatal rejections looked healthy on `/api/health`.
 * Once `server.log` rotates, the only trace is gone.
 *
 * This module holds the small module-level state those handlers stamp:
 * monotonic since-boot counts plus the last message (message string only, never
 * the error object) and timestamp. `/api/health` projects the snapshot via a
 * getter wired in {@link file://./index.ts}, mirroring how `lastEmergencyPruneError`
 * is composed onto the `maintenancePrune` block (#3078).
 *
 * Kept in its own module (not inside start.ts) so index.ts can read the same
 * counters the entry point stamps without importing the process entry point.
 */

/**
 * Cap on the stored `lastFatalError` message length. A pathological error
 * message (e.g. a serialized giant object) must not bloat the health payload
 * (issue #3112 risk note). Truncated messages get an ellipsis marker.
 */
export const MAX_FATAL_MESSAGE_LENGTH = 500;

/** Read-only snapshot projected onto `/api/health` under `processFatal`. */
export interface FatalErrorHealthSnapshot {
  /** Count of `unhandledRejection`s the handler has absorbed since boot. */
  unhandledRejectionTotal: number;
  /** Count of `uncaughtException`s the handler has absorbed since boot. */
  uncaughtExceptionTotal: number;
  /** Message of the most recent fatal error (capped), or null if none yet. */
  lastFatalError: string | null;
  /** ISO-8601 timestamp of the most recent fatal error, or null if none yet. */
  lastFatalAt: string | null;
}

let unhandledRejectionTotal = 0;
let uncaughtExceptionTotal = 0;
let lastFatalError: string | null = null;
let lastFatalAt: string | null = null;

/**
 * Redact the obvious credential shapes from a fatal message before it is stored.
 * An error message can quote a request that carried a bearer token, an
 * `Authorization` header, a secret query/body field, or URL userinfo; `/api/health`
 * can be reached over the network (a token-authenticated non-loopback bind, a
 * viewer share), so those must not ride through on the message string. This is a
 * conservative best-effort scrub of common shapes — not a guarantee — layered on
 * top of the primary defense (storing the message only, never the error object).
 */
function redactSecrets(text: string): string {
  return text
    // `Authorization: Bearer <token>` / `Authorization=Basic <token>`
    .replace(/\b(authorization\s*[:=]\s*)(bearer|basic|digest|token)\s+\S+/gi, '$1$2 <redacted>')
    // bare `Bearer <token>` / `Basic <token>`
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <redacted>')
    // A secret-ish key (bare or quoted) followed by `:`/`=` and its value. The
    // value is a full quoted string (so quoted values containing spaces, e.g.
    // JSON `"api_key":"…"` or `password="a b c"`, are removed whole) or an
    // unquoted run up to the next delimiter.
    .replace(
      /(["']?\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|auth[_-]?token|token|secret|password|passwd|pwd)\b["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"',;)}\]]+)/gi,
      '$1<redacted>',
    )
    // URL userinfo: `scheme://user:pass@host`
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1<redacted>@')
    // JWT-like tokens (base64url header.payload.signature), which carry claims
    // even without a nearby key.
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+/g, '<redacted>');
}

/**
 * Extract a bounded, redacted message string from an unknown fatal value. Stores
 * the message only — never the full error object — so stack frames and any
 * embedded secrets stay out of the health payload, then scrubs common credential
 * shapes from the message itself and caps its length.
 *
 * Robust against two hostile inputs, because the callers are last-ditch process
 * handlers that must never throw: a value whose coercion throws (an object with a
 * throwing `toString` / `Symbol.toPrimitive`) falls back to a placeholder, and a
 * non-string `Error.message` (it is writable and not guaranteed to hold a string
 * at runtime) is coerced to a string so the later length check cannot throw.
 */
function toFatalMessage(value: unknown): string {
  let raw: string;
  try {
    const message = value instanceof Error ? value.message : value;
    raw = typeof message === 'string' ? message : String(message);
  } catch {
    raw = '<unstringifiable fatal value>';
  }
  raw = redactSecrets(raw);
  if (raw.length <= MAX_FATAL_MESSAGE_LENGTH) return raw;
  return `${raw.slice(0, MAX_FATAL_MESSAGE_LENGTH)}…`;
}

/**
 * Record an absorbed `unhandledRejection`. Increments the counter and stamps
 * the last-error message + timestamp. Never throws — the caller is a
 * last-ditch process handler.
 */
export function recordUnhandledRejection(reason: unknown, now: () => string = defaultNow): void {
  unhandledRejectionTotal += 1;
  lastFatalError = toFatalMessage(reason);
  lastFatalAt = now();
}

/**
 * Record an absorbed `uncaughtException`. Increments the counter and stamps
 * the last-error message + timestamp. Never throws.
 */
export function recordUncaughtException(err: unknown, now: () => string = defaultNow): void {
  uncaughtExceptionTotal += 1;
  lastFatalError = toFatalMessage(err);
  lastFatalAt = now();
}

/** In-memory snapshot for `/api/health`. Cheap read; never touches disk. */
export function getFatalErrorHealth(): FatalErrorHealthSnapshot {
  return {
    unhandledRejectionTotal,
    uncaughtExceptionTotal,
    lastFatalError,
    lastFatalAt,
  };
}

/**
 * Register the process-level fatal handlers that keep the daemon alive by
 * logging and continuing — they never re-raise or exit — and stamp the
 * observable counters above (issue #3112). Extracted from start.ts (which runs
 * `main()` on import and so cannot be imported by a test) so the
 * log-and-continue + counter-stamping behavior is unit-testable against a fake
 * emitter without booting the server.
 *
 * `emitter` defaults to the live `process`; tests pass a throwaway
 * `EventEmitter` and `emit()` the events to exercise the exact handler bodies.
 */
export function installProcessFatalHandlers(emitter: NodeJS.EventEmitter = process): void {
  emitter.on('uncaughtException', (err: unknown, origin: unknown) => {
    console.error(`[fatal] uncaughtException (${String(origin)}):`, err);
    recordUncaughtException(err);
  });
  emitter.on('unhandledRejection', (reason: unknown) => {
    console.error('[fatal] unhandledRejection:', reason);
    recordUnhandledRejection(reason);
  });
}

/** Reset all counters. Test-only — restores a clean module-level baseline. */
export function resetFatalErrorCounters(): void {
  unhandledRejectionTotal = 0;
  uncaughtExceptionTotal = 0;
  lastFatalError = null;
  lastFatalAt = null;
}

function defaultNow(): string {
  return new Date().toISOString();
}
