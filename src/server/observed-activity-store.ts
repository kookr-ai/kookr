import { join } from 'node:path';
import { atomicWriteFile, readJsonFile } from '../core/persistence-utils.js';
import type {
  ObservedState,
  ObservedEffectiveState,
  ObservedSessionRecord,
  ObservedSessionView,
  ObservedActivityCounters,
  ObservedActivitySnapshot,
} from '../shared/contracts/observed-activity.js';

// The pure wire shapes live in the shared contract so the frontend lane can
// consume them without importing from `server/`. Re-exported here so existing
// `server/` importers (routes, diagnostics) keep their import site unchanged.
export type {
  ObservedState,
  ObservedEffectiveState,
  ObservedSessionRecord,
  ObservedSessionView,
  ObservedActivityCounters,
  ObservedActivitySnapshot,
} from '../shared/contracts/observed-activity.js';

/**
 * Hermes observed-activity bridge — slice 1 store (jeanibarz/hermes-fleet#15,
 * RFC `rfc-hermes-observed-activity-bridge`).
 *
 * Makes the operator's external Hermes fleet visible as live activity in Kookr
 * WITHOUT touching the load-bearing activity ledger. This store is the whole
 * backend state for the observed lane:
 *
 * - **In-memory hot path** (`Map<sessionId, ObservedSessionRecord>`), bounded by
 *   a session cap + TTL eviction, so memory never grows without bound.
 * - **Dedicated durable last-state file** (`<kookrDir>/hermes-observed-activity.json`),
 *   NOT the activity ledger. It survives Kookr's routine restarts
 *   (systemd `Restart=on-failure`, deploys, watchdog) so the lane does not blank
 *   and read as "fleet died" — the false-NEGATIVE liveness error (RFC R7).
 * - **Server-stamped `receivedAt`** (never the producer's `ts`). On reload a
 *   session last seen within the stale window renders `working`; one older
 *   renders `stale` — so a restart lies in NEITHER direction (R6 and R7 at once).
 *
 * The store never reads the activity ledger and is never bound to a `Task`
 * (RFC R5/R6): integrity is preserved by construction, not by exclusion logic.
 */

export interface ObservedActivityRecordInput {
  sessionId: string;
  state: ObservedState;
  label?: string;
  /** Producer-supplied timestamp. Used ONLY for retry dedup, never for decay. */
  ts: number;
}

export type RecordOutcome = 'accepted' | 'deduped';

/** Reserved session-id prefix for observed sessions. Disjoint from real task
 *  sessions and from `REPLAY_SESSION_PREFIX`; the generic hook route rejects it
 *  (defense-in-depth) so the namespace cannot be driven unauthenticated. */
export const OBSERVED_SESSION_PREFIX = 'hermes-obs-';

/** Fixed provider identity for this lane — pinned server-side, never from a body. */
export const OBSERVED_PROVIDER = 'hermes-fleet' as const;

export const DEFAULT_MAX_SESSIONS = 256;
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h: evict long-idle sessions
export const DEFAULT_STALE_MS = 90_000; // a `working` session is `stale` after 90s silence
/**
 * Cadence (ms) at which the observed lane is re-broadcast to the monitor (slice
 * 2). Short so a `working`→`stale` decay transition and new pulses surface
 * within seconds; far below {@link DEFAULT_STALE_MS} so a stale flip is never
 * missed. Only armed when the Hermes flag is on.
 */
export const DEFAULT_OBSERVED_BROADCAST_INTERVAL_MS = 2_000;
export const DEFAULT_RATE_LIMIT = 120; // accepted pulses per window
export const DEFAULT_RATE_WINDOW_MS = 60_000;
export const OBSERVED_LABEL_MAX = 200;
/** Max distinct `(state,label,ts)` tuples remembered per session for retry dedup. */
const DEDUP_RING = 16;

export interface ObservedActivityStoreOptions {
  maxSessions?: number;
  ttlMs?: number;
  staleMs?: number;
  rateLimit?: number;
  rateWindowMs?: number;
  /** Test seam: overridable clock. */
  now?: () => number;
  /** Test seam: override the durable file path. */
  filePath?: string;
}

/**
 * Bounded, durable-last-state store for the Hermes observed lane. See the module
 * doc. All mutation goes through {@link record}; all reads through
 * {@link snapshot}. Persistence is fire-and-forget atomic writes (a corrupt file
 * quarantines and falls back to empty — the lane degrades to "no pulses", never
 * blocks boot).
 */
export class ObservedActivityStore {
  private sessions = new Map<string, ObservedSessionRecord>();
  private dedup = new Map<string, string[]>();
  private counters: ObservedActivityCounters;
  private readonly filePath: string;
  private readonly maxSessions: number;
  private readonly ttlMs: number;
  private readonly staleMs: number;
  private readonly rateLimit: number;
  private readonly rateWindowMs: number;
  private readonly now: () => number;
  private loaded = false;
  private loadPromise: Promise<void> | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private rateWindowStart = 0;
  private rateCount = 0;

  constructor(kookrDir: string, options: ObservedActivityStoreOptions = {}) {
    this.filePath = options.filePath ?? join(kookrDir, 'hermes-observed-activity.json');
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    this.rateLimit = options.rateLimit ?? DEFAULT_RATE_LIMIT;
    this.rateWindowMs = options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
    this.counters = {
      accepted: 0,
      deduped: 0,
      rejected: {},
      lastAcceptedAt: null,
      lastRejectAt: null,
      startedAt: this.now(),
    };
  }

  getFilePath(): string {
    return this.filePath;
  }

  /** Load the durable last-state file (idempotent, deduped across callers). */
  async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.loadPromise) {
      this.loadPromise = this.doLoad();
    }
    await this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    const rows = await readJsonFile<ObservedSessionRecord[]>(this.filePath, [], {
      quarantineCorrupt: true,
      warningPrefix: 'hermes-observed-activity',
    });
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (isValidPersistedRow(row)) {
          this.sessions.set(row.sessionId, {
            sessionId: row.sessionId,
            state: row.state,
            label: row.label,
            receivedAt: row.receivedAt,
            firstSeen: row.firstSeen,
            pulseCount: row.pulseCount,
          });
        }
      }
    }
    this.loaded = true;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  /**
   * Record one observed pulse. Returns `'deduped'` for an exact retry
   * (same `sessionId`+`state`+`label`+`ts` seen recently) — which does NOT
   * refresh `receivedAt`, so a retry cannot mask staleness; a genuine heartbeat
   * carries a new `ts` and is `'accepted'`, refreshing liveness.
   *
   * The dedup ring is in-memory only (the durable file stores session state, not
   * the ring), so a literal retry that straddles a restart is treated as a fresh
   * heartbeat. That is acceptable: a pulse recent enough to be retried across a
   * restart is fair to show as live, and the dangerous case (no pulse at all) is
   * still caught by `receivedAt`-based decay.
   *
   * @throws RangeError when the per-window rate limit is exceeded. Callers map
   *   that to a 429 and should call {@link recordRejection} with `rate_limited`.
   */
  async record(input: ObservedActivityRecordInput): Promise<RecordOutcome> {
    await this.ensureLoaded();
    const now = this.now();
    this.evictExpired(now);

    const dedupKey = `${input.state}\u0000${input.label ?? ''}\u0000${input.ts}`;
    const ring = this.dedup.get(input.sessionId);
    if (ring && ring.includes(dedupKey)) {
      this.counters.deduped += 1;
      return 'deduped';
    }

    if (!this.admitRate(now)) {
      throw new RangeError('observed-activity rate limit exceeded');
    }

    const existing = this.sessions.get(input.sessionId);
    const record: ObservedSessionRecord = {
      sessionId: input.sessionId,
      state: input.state,
      label: input.label,
      receivedAt: now,
      firstSeen: existing?.firstSeen ?? now,
      pulseCount: (existing?.pulseCount ?? 0) + 1,
    };
    this.sessions.set(input.sessionId, record);
    this.rememberDedup(input.sessionId, dedupKey);
    this.enforceSessionCap();

    this.counters.accepted += 1;
    this.counters.lastAcceptedAt = now;
    void this.persist();
    return 'accepted';
  }

  /** Record a rejected request for the operator-facing counters (R7). */
  recordRejection(reason: string): void {
    this.counters.rejected[reason] = (this.counters.rejected[reason] ?? 0) + 1;
    this.counters.lastRejectAt = this.now();
  }

  /** Point-in-time view with decayed effective states and counters. */
  async snapshot(): Promise<ObservedActivitySnapshot> {
    await this.ensureLoaded();
    const now = this.now();
    this.evictExpired(now);
    const sessions: ObservedSessionView[] = [];
    for (const record of this.sessions.values()) {
      const ageMs = now - record.receivedAt;
      sessions.push({
        ...record,
        ageMs,
        effectiveState: this.deriveEffectiveState(record, now),
      });
    }
    sessions.sort((a, b) => b.receivedAt - a.receivedAt);
    return { sessions, counters: { ...this.counters, rejected: { ...this.counters.rejected } }, now };
  }

  private deriveEffectiveState(record: ObservedSessionRecord, now: number): ObservedEffectiveState {
    if (record.state === 'working' && now - record.receivedAt > this.staleMs) {
      return 'stale';
    }
    return record.state;
  }

  private admitRate(now: number): boolean {
    if (now - this.rateWindowStart >= this.rateWindowMs) {
      this.rateWindowStart = now;
      this.rateCount = 0;
    }
    if (this.rateCount >= this.rateLimit) return false;
    this.rateCount += 1;
    return true;
  }

  private rememberDedup(sessionId: string, key: string): void {
    const ring = this.dedup.get(sessionId) ?? [];
    ring.push(key);
    while (ring.length > DEDUP_RING) ring.shift();
    this.dedup.set(sessionId, ring);
  }

  private evictExpired(now: number): void {
    for (const [sessionId, record] of this.sessions) {
      if (now - record.receivedAt > this.ttlMs) {
        this.sessions.delete(sessionId);
        this.dedup.delete(sessionId);
      }
    }
  }

  private enforceSessionCap(): void {
    if (this.sessions.size <= this.maxSessions) return;
    // Drop the oldest-by-receivedAt until within cap.
    const ordered = [...this.sessions.values()].sort((a, b) => a.receivedAt - b.receivedAt);
    for (const record of ordered) {
      if (this.sessions.size <= this.maxSessions) break;
      this.sessions.delete(record.sessionId);
      this.dedup.delete(record.sessionId);
    }
  }

  /**
   * Serialized atomic persist of the current session records. Each call appends
   * one write to a chain, so writes never overlap and each runs against the
   * latest state at execution time. Fire-and-forget on the request path (disk
   * latency must not sit in front of a pulse); failures are swallowed (the lane
   * must never fault ingestion). Await {@link flush} for durability (tests,
   * graceful shutdown).
   */
  private persist(): void {
    this.persistChain = this.persistChain
      .then(() => this.writeOnce())
      .catch((err) => {
        console.warn('[hermes-observed-activity] persist failed:', err);
      });
  }

  private async writeOnce(): Promise<void> {
    const rows = [...this.sessions.values()];
    await atomicWriteFile(this.filePath, JSON.stringify(rows), { mode: 0o600 });
  }

  /** Await all queued persists. Use before relying on the durable file on disk. */
  async flush(): Promise<void> {
    await this.persistChain;
  }
}

function isValidPersistedRow(row: unknown): row is ObservedSessionRecord {
  if (typeof row !== 'object' || row === null) return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.sessionId === 'string' &&
    (r.state === 'working' || r.state === 'idle' || r.state === 'done') &&
    (r.label === undefined || typeof r.label === 'string') &&
    typeof r.receivedAt === 'number' &&
    Number.isFinite(r.receivedAt) &&
    typeof r.firstSeen === 'number' &&
    Number.isFinite(r.firstSeen) &&
    typeof r.pulseCount === 'number' &&
    Number.isFinite(r.pulseCount)
  );
}
