import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isSecretFieldName, redactSecrets as redactSecretString } from '../core/redact-secrets.js';

/**
 * Durable, rotating "last good" mirror of the `/api/health` body (issue #2495).
 *
 * When the HTTP surface is dark — the process is wedged, the port is bound but
 * unresponsive, or the operator is offline and can only reach the box over a
 * relay — `kookr ops digest` has nothing to quote. `ops-status` records *edges*, not
 * a full last-good body. This module writes one atomically-rotated JSON file
 * after every successful health assembly so an offline digest still has a
 * recent, redacted snapshot plus an mtime to reason about staleness.
 *
 * Guarantees:
 * - **Atomic + rotate-by-overwrite**: temp file + rename, so a crash mid-write
 *   cannot truncate the live file and history never grows unbounded.
 * - **Owner-only**: the snapshot is written at mode `0o600` (issue #2561). The
 *   temp file is created with that mode, chmod'd past umask, then the final
 *   path is chmod'd again after rename so a leftover world-readable file cannot
 *   stay group/other-readable. Stays on this sync path so `/api/health` never
 *   awaits disk.
 * - **Never throws on the hot path**: `record()` swallows every error — a failed
 *   or read-only state dir must never turn `/api/health` into a 500.
 * - **Redacted**: any key that looks like a credential (authorization, token,
 *   secret, bearer, api-key, cookie, password, csrf, …) is stripped before the
 *   body ever touches disk.
 * - **Size-capped**: the serialized file is kept at or under
 *   {@link LAST_GOOD_HEALTH_SIZE_CAP_BYTES}. If the full redacted body would
 *   exceed the cap, a `truncated` gauge-only snapshot is written instead.
 * - **Churn-bounded**: writes at most once per {@link LAST_GOOD_HEALTH_MIN_WRITE_INTERVAL_MS},
 *   except on a gauge edge (a monitored gauge changed), so a 1s health refresh
 *   loop does not hammer the disk.
 */

export const LAST_GOOD_HEALTH_FILE = 'last-good-health.json';
export const LAST_GOOD_HEALTH_SCHEMA_VERSION = 'last-good-health.v1';

/** Owner-read/write only. Matches settings.json and other operational snapshots. */
export const LAST_GOOD_HEALTH_FILE_MODE = 0o600;

/** Hard cap for the on-disk file, per issue #2495 (~32 KiB). */
export const LAST_GOOD_HEALTH_SIZE_CAP_BYTES = 32 * 1024;

/** Minimum spacing between disk writes, unless a gauge edge forces one. */
export const LAST_GOOD_HEALTH_MIN_WRITE_INTERVAL_MS = 5_000;

/**
 * Extra credential-looking key fragments beyond {@link isSecretFieldName}'s
 * core set (api-key / token / secret / password). Matched case-insensitively as
 * a substring so `Authorization`, `X-Auth-Bearer`, `csrfSecret`, `sessionCookie`,
 * etc. are all caught. We keep the core primitive as the shared base and only
 * widen it here so this persisted, operator-visible artifact errs on the side of
 * over-redaction.
 */
const EXTRA_SECRET_KEY_RE = /(authorization|bearer|cookie|credential|csrf|private[-_ ]?key|passwd)/i;

/** Repo-standard redaction placeholder (matches `core/redact-secrets`). */
const REDACTED = '[REDACTED]';

function isSecretKey(name: string): boolean {
  return isSecretFieldName(name) || EXTRA_SECRET_KEY_RE.test(name);
}

export interface LastGoodHealthSnapshot {
  schemaVersion: typeof LAST_GOOD_HEALTH_SCHEMA_VERSION;
  /** ISO timestamp of the health assembly this snapshot mirrors. */
  capturedAt: string;
  /** True when the body exceeded the size cap and only gauges were kept. */
  truncated: boolean;
  /** Redacted health body (or a gauge-only subset when `truncated`). */
  health: Record<string, unknown>;
}

export interface LastGoodHealthRead {
  snapshot: LastGoodHealthSnapshot;
  path: string;
  /** File mtime in epoch ms. */
  mtimeMs: number;
  /** How stale the file is relative to `now`, in ms (never negative). */
  ageMs: number;
}

export function lastGoodHealthPath(kookrDir: string): string {
  return join(kookrDir, LAST_GOOD_HEALTH_FILE);
}

/**
 * Deep-copy `value`, redacting credentials two ways:
 *  - any field whose *key* looks like a credential is replaced wholesale;
 *  - every string *value* is run through the shared token/PEM/Authorization
 *    pattern scrubber, so a secret smuggled into an innocuous key (e.g. a
 *    `lastError` string containing a Bearer token) is still caught.
 *
 * Only plain JSON shapes are expected (the health body is already
 * JSON-serializable), so there are no cycles to guard against.
 */
export function redactSecretFields(value: unknown): unknown {
  if (typeof value === 'string') return redactSecretString(value);
  if (Array.isArray(value)) return value.map(redactSecretFields);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? REDACTED : redactSecretFields(val);
    }
    return out;
  }
  return value;
}

/** Reduce `build` to just its version, if present — the only field the digest reads. */
function slimBuild(health: Record<string, unknown>): { version: unknown } | undefined {
  const build = health.build;
  if (build && typeof build === 'object') {
    const version = (build as Record<string, unknown>).version;
    if (version !== undefined) return { version };
  }
  return undefined;
}

/**
 * First truncation tier: drop free-form/large fields, keep the operator gauges.
 * `attentionQueue` and `capacity` are small today but not size-bounded, so a
 * second tier ({@link pickMinimalGauges}) backstops the hard cap.
 * `timerHealth` is four counts (issue #2636) so last-good still answers
 * "did prune run?" when the full body is too big.
 */
function pickGauges(health: Record<string, unknown>): Record<string, unknown> {
  const gauges: Record<string, unknown> = {};
  for (const key of [
    'status',
    'agents',
    'serverStartedAt',
    'attentionQueue',
    'capacity',
    'helperLlm',
    'timerHealth',
  ] as const) {
    if (health[key] !== undefined) gauges[key] = health[key];
  }
  const build = slimBuild(health);
  if (build) gauges.build = build;
  return gauges;
}

/**
 * Second truncation tier: scalar-only, so the serialized snapshot is
 * unconditionally tiny. Guarantees the on-disk file honors the size cap even if
 * the gauge blocks in {@link pickGauges} were themselves oversized.
 */
function pickMinimalGauges(health: Record<string, unknown>): Record<string, unknown> {
  const gauges: Record<string, unknown> = {};
  for (const key of ['status', 'agents', 'serverStartedAt'] as const) {
    if (health[key] !== undefined) gauges[key] = health[key];
  }
  const build = slimBuild(health);
  if (build) gauges.build = build;
  return gauges;
}

/**
 * A compact signature of the gauges an operator watches for edges. A change
 * here forces an out-of-band write even inside the throttle window so a status
 * flip or an agent-count change is never hidden behind the 5s interval.
 */
function gaugeSignature(health: Record<string, unknown>): string {
  const status = health.status;
  const agents = health.agents;
  const queue = health.attentionQueue as { activeFindingDepth?: unknown } | undefined;
  const capacity = health.capacity as { active?: unknown } | undefined;
  const helperLlm = health.helperLlm as
    | { paused?: Array<{ provider?: unknown }>; stormsSuppressed?: unknown }
    | undefined;
  const pausedProviders = (helperLlm?.paused ?? [])
    .map((row) => (typeof row.provider === 'string' ? row.provider : ''))
    .join(',');
  const timerHealth = health.timerHealth as
    | {
      overdue?: unknown;
      neverFired?: unknown;
      oldestNeverFiredName?: unknown;
      oldestOverdueName?: unknown;
    }
    | undefined;
  return JSON.stringify([
    status,
    agents,
    queue?.activeFindingDepth,
    capacity?.active,
    pausedProviders,
    helperLlm?.stormsSuppressed ?? 0,
    timerHealth?.overdue ?? 0,
    timerHealth?.neverFired ?? 0,
    typeof timerHealth?.oldestNeverFiredName === 'string'
      ? timerHealth.oldestNeverFiredName
      : '',
    typeof timerHealth?.oldestOverdueName === 'string'
      ? timerHealth.oldestOverdueName
      : '',
  ]);
}

function serialize(snapshot: LastGoodHealthSnapshot): string {
  return `${JSON.stringify(snapshot)}\n`;
}

export interface LastGoodHealthWriterOptions {
  kookrDir: string;
  /** Injectable clock (epoch ms). Defaults to `Date.now`. */
  now?: () => number;
  minWriteIntervalMs?: number;
  sizeCapBytes?: number;
}

export class LastGoodHealthWriter {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly minWriteIntervalMs: number;
  private readonly sizeCapBytes: number;
  private lastWriteMs = Number.NEGATIVE_INFINITY;
  private lastSignature: string | undefined;

  constructor(opts: LastGoodHealthWriterOptions) {
    this.filePath = lastGoodHealthPath(opts.kookrDir);
    this.now = opts.now ?? Date.now;
    this.minWriteIntervalMs = opts.minWriteIntervalMs ?? LAST_GOOD_HEALTH_MIN_WRITE_INTERVAL_MS;
    this.sizeCapBytes = opts.sizeCapBytes ?? LAST_GOOD_HEALTH_SIZE_CAP_BYTES;
  }

  /**
   * Mirror a freshly assembled health body to disk. Fire-and-forget: throttled,
   * atomic, and guaranteed never to throw. Call only after a *successful*
   * assembly so a failed one leaves the previous good file intact.
   */
  record(health: Record<string, unknown>): void {
    try {
      const nowMs = this.now();
      const signature = gaugeSignature(health);
      const edge = signature !== this.lastSignature;
      if (!edge && nowMs - this.lastWriteMs < this.minWriteIntervalMs) return;

      const capturedAt = new Date(nowMs).toISOString();
      const redacted = redactSecretFields(health) as Record<string, unknown>;
      let snapshot: LastGoodHealthSnapshot = {
        schemaVersion: LAST_GOOD_HEALTH_SCHEMA_VERSION,
        capturedAt,
        truncated: false,
        health: redacted,
      };
      let text = serialize(snapshot);
      // Two truncation tiers so the hard cap is honored unconditionally: first
      // drop free-form fields (keep gauges); if that still overflows, fall back
      // to a scalar-only minimal set.
      if (Buffer.byteLength(text, 'utf8') > this.sizeCapBytes) {
        snapshot = {
          schemaVersion: LAST_GOOD_HEALTH_SCHEMA_VERSION,
          capturedAt,
          truncated: true,
          health: pickGauges(redacted),
        };
        text = serialize(snapshot);
        if (Buffer.byteLength(text, 'utf8') > this.sizeCapBytes) {
          snapshot = { ...snapshot, health: pickMinimalGauges(redacted) };
          text = serialize(snapshot);
        }
      }

      this.writeAtomic(text);
      this.lastWriteMs = nowMs;
      this.lastSignature = signature;
    } catch {
      // Never let a persistence failure touch the /api/health hot path.
    }
  }

  private writeAtomic(text: string): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    // mode on write only applies when the temp path is created; chmod forces
    // exact bits after open (umask / leftover .tmp) before rename.
    writeFileSync(tmp, text, { encoding: 'utf8', mode: LAST_GOOD_HEALTH_FILE_MODE });
    try {
      chmodSync(tmp, LAST_GOOD_HEALTH_FILE_MODE);
    } catch {
      // Best-effort: create mode already requested 0o600. Do not fail the
      // write — record() still needs to update throttle bookkeeping.
    }
    renameSync(tmp, this.filePath);
    // Rename replaces the path with the temp inode on POSIX, but chmod the
    // final path so a leftover 0644 dest is tightened even if a filesystem
    // preserves dest mode across overwrite.
    try {
      chmodSync(this.filePath, LAST_GOOD_HEALTH_FILE_MODE);
    } catch {
      // Best-effort: content is already durable. A chmod failure must not
      // throw into /api/health or skip lastWriteMs / lastSignature.
    }
  }
}

/**
 * Read the last-good health snapshot from `kookrDir`, or null if the file is
 * absent, unreadable, malformed, or written by an unknown schema version.
 * Used by the offline digest (`kookr ops digest --offline`) when HTTP is dark.
 */
export function readLastGoodHealth(
  kookrDir: string,
  opts: { now?: number } = {},
): LastGoodHealthRead | null {
  const filePath = lastGoodHealthPath(kookrDir);
  let raw: string;
  let mtimeMs: number;
  try {
    raw = readFileSync(filePath, 'utf8');
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || (parsed as { schemaVersion?: unknown }).schemaVersion !== LAST_GOOD_HEALTH_SCHEMA_VERSION
  ) {
    return null;
  }
  const now = opts.now ?? Date.now();
  return {
    snapshot: parsed as LastGoodHealthSnapshot,
    path: filePath,
    mtimeMs,
    ageMs: Math.max(0, now - mtimeMs),
  };
}
