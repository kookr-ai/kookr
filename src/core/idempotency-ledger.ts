/**
 * IdempotencyLedger — durable key → task ledger for `POST /api/tasks`
 * (issue #1526 Phase B / FM2, FM3).
 *
 * Incident context: a client (Lucy) retried `POST /api/tasks` after her 30s
 * client timeout fired against an overloaded server. The server had already
 * created the task; the retry created an exact duplicate because each spawn
 * embeds a fresh random branch suffix in the prompt, defeating the existing
 * prompt+cwd+agentType+model+effort dedup in `checkSubmission` (`launch-service.ts`).
 *
 * This ledger lets a caller attach an opaque `idempotencyKey` to a launch
 * request. The FIRST request for a key creates the task as normal; ANY LATER
 * request for the same key — including one racing concurrently with the
 * first — returns the same task instead of creating a duplicate.
 *
 * ## Atomicity (R4-style: no await between check and set)
 *
 * {@link reserveOrWait} is a single synchronous method: the "does this key
 * already have an owner" check and the "claim it" write happen in the same
 * synchronous call, with no `await` in between. Node's single-threaded event
 * loop guarantees no other code can run between them, so two callers racing
 * for the same key can never both observe "unclaimed" — whichever call
 * reaches `reserveOrWait` first (in JS's run-to-completion sense) wins
 * ownership; the other is handed a promise to await.
 *
 * ## Pending vs finalized
 *
 * A reservation starts `pending` (in-memory only — a mid-flight launch is
 * meaningless after a crash, so it does not need to survive one). The owner
 * must call exactly one of:
 *   - `finalize(taskId)` — the launch produced this task; the in-memory entry
 *     flips to `finalized` and every waiter resolves with the same task id
 *     BEFORE the disk write is even attempted. Persisting to disk is
 *     best-effort past that point (see Durability below): `finalize` never
 *     rejects, so a caller that already has a real, launched task can never
 *     have that success turned into a thrown error by a failed ledger write.
 *   - `release()` — the launch failed (validation error, adapter launch
 *     failure, etc.); the entry is dropped entirely so a retry with the same
 *     key is treated as a fresh request. Only called when `launchTaskCore`
 *     itself threw — never after a real task exists (issue #1526 Phase B
 *     review item 1).
 *
 * ## Durability + TTL
 *
 * Only `finalized` entries are persisted (`idempotency-ledger.json` under the
 * Kookr data dir), so a restart mid-launch simply loses the (meaningless)
 * pending marker while a completed launch's replay protection survives.
 * Entries older than {@link IDEMPOTENCY_TTL_MS} (24h) are compacted both on
 * `load()` (boot) and inline inside `reserveOrWait` (so a key past its TTL is
 * silently treated as never-seen, without needing a background sweep timer).
 *
 * Durability is honest, not absolute: (1) a crash strictly inside the
 * create→finalize window loses the (memory-only) pending reservation, so a
 * retry after that specific crash can create a duplicate — the same window
 * that exists for any in-flight work; (2) `finalize`/`clear` persist
 * best-effort (`persistBestEffort`) — a disk write failure is logged loudly
 * but does not fail the caller, so same-process replay stays protected while
 * cross-restart durability for that one entry is not, until the next
 * successful write; (3) a corrupt on-disk file is quarantined and the ledger
 * restarts empty (see `readJsonFile`'s `quarantineCorrupt`), which resets
 * idempotency protection for every previously-finalized key — this is logged
 * via `console.warn`, not otherwise alerted on.
 */
import { join } from 'node:path';
import { atomicWriteFile, readJsonFile } from './persistence-utils.js';

export { MAX_IDEMPOTENCY_KEY_LENGTH } from '../shared/contracts/launch.js';

/** File name under the Kookr data dir. */
export const IDEMPOTENCY_LEDGER_FILE = 'idempotency-ledger.json';

const SCHEMA_VERSION = 1;

/** How long a finalized entry protects against a duplicate launch. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** One persisted (finalized-only) ledger row. */
export interface IdempotencyLedgerEntry {
  taskId: string;
  /** ISO-8601 timestamp of the launch request that finalized this key. */
  createdAt: string;
}

interface IdempotencyLedgerFile {
  schemaVersion: number;
  entries: Record<string, IdempotencyLedgerEntry>;
}

/** Outcome delivered to callers that awaited a pending reservation. */
export type IdempotencyWaitOutcome =
  | { ok: true; taskId: string }
  | { ok: false };

/** Return of {@link IdempotencyLedger.reserveOrWait}. */
export type IdempotencyReservation =
  | {
      kind: 'own';
      /**
       * Record the winning task id and release every waiter with it. Updates
       * in-memory state and resolves waiters synchronously before attempting
       * to persist — the returned promise NEVER rejects (a disk failure is
       * logged and swallowed), so callers can safely call this after a real
       * launch without any risk of turning that success into a thrown error.
       */
      finalize: (taskId: string) => Promise<void>;
      /**
       * Drop the reservation (the launch itself failed) so a retry is
       * treated as fresh. Only call this when no task was created — never
       * after `finalize` would apply.
       */
      release: () => Promise<void>;
    }
  | {
      kind: 'wait';
      /** Resolves once the owning caller finalizes or releases. */
      wait: () => Promise<IdempotencyWaitOutcome>;
    }
  | {
      kind: 'replay';
      taskId: string;
    };

interface PendingState {
  status: 'pending';
  createdAtMs: number;
  resolve: (outcome: IdempotencyWaitOutcome) => void;
  promise: Promise<IdempotencyWaitOutcome>;
}

interface FinalizedState {
  status: 'finalized';
  createdAtMs: number;
  taskId: string;
}

type LedgerState = PendingState | FinalizedState;

function isValidEntry(value: unknown): value is IdempotencyLedgerEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Partial<IdempotencyLedgerEntry>;
  return (
    typeof e.taskId === 'string' &&
    e.taskId.length > 0 &&
    typeof e.createdAt === 'string' &&
    !Number.isNaN(Date.parse(e.createdAt))
  );
}

export class IdempotencyLedger {
  private readonly filePath: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private state = new Map<string, LedgerState>();
  /** Async write mutex — serializes persist() across concurrent finalize() callers. */
  private writeLock: Promise<void> = Promise.resolve();

  constructor(kookrDir: string, options: { ttlMs?: number; now?: () => number } = {}) {
    this.filePath = join(kookrDir, IDEMPOTENCY_LEDGER_FILE);
    this.ttlMs = options.ttlMs ?? IDEMPOTENCY_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Load finalized entries from disk, dropping anything already past the
   * TTL (boot-time compaction). Missing/corrupt file ⇒ empty ledger. Any
   * in-memory pending reservations are cleared — a fresh process has no
   * in-flight launches yet.
   */
  async load(): Promise<void> {
    const fallback: IdempotencyLedgerFile = { schemaVersion: SCHEMA_VERSION, entries: {} };
    const loaded = await readJsonFile<IdempotencyLedgerFile>(this.filePath, fallback, {
      quarantineCorrupt: true,
      warningPrefix: 'idempotency-ledger',
    });
    this.state.clear();
    if (!loaded || typeof loaded !== 'object' || loaded.schemaVersion !== SCHEMA_VERSION) {
      if (loaded && typeof loaded === 'object' && loaded.schemaVersion !== SCHEMA_VERSION) {
        console.warn(`[idempotency-ledger] Unknown schemaVersion ${loaded.schemaVersion}, starting empty`);
      }
      return;
    }
    const nowMs = this.now();
    const entries = loaded.entries && typeof loaded.entries === 'object' ? loaded.entries : {};
    for (const [key, entry] of Object.entries(entries)) {
      if (!isValidEntry(entry)) {
        console.warn(`[idempotency-ledger] Skipping invalid entry for key ${JSON.stringify(key).slice(0, 80)}`);
        continue;
      }
      const createdAtMs = Date.parse(entry.createdAt);
      if (nowMs - createdAtMs > this.ttlMs) continue; // expired — compacted on load
      this.state.set(key, { status: 'finalized', createdAtMs, taskId: entry.taskId });
    }
  }

  /**
   * Atomic check-and-reserve for `key` (no await inside — see class docs).
   * Always call this before any async task-creation work.
   */
  reserveOrWait(key: string): IdempotencyReservation {
    this.compactExpired();
    const existing = this.state.get(key);
    if (existing?.status === 'finalized') {
      return { kind: 'replay', taskId: existing.taskId };
    }
    if (existing?.status === 'pending') {
      return { kind: 'wait', wait: () => existing.promise };
    }

    let resolve!: (outcome: IdempotencyWaitOutcome) => void;
    const promise = new Promise<IdempotencyWaitOutcome>((res) => {
      resolve = res;
    });
    const createdAtMs = this.now();
    this.state.set(key, { status: 'pending', createdAtMs, resolve, promise });

    return {
      kind: 'own',
      finalize: async (taskId: string) => {
        // In-memory state flips to finalized — and every waiter resolves —
        // BEFORE the persist attempt below, so a disk failure here can only
        // cost cross-restart durability, never same-process replay
        // protection or the caller's launch result (issue #1526 Phase B
        // review item 1: a launch that already spawned an agent must never
        // become an HTTP error just because the ledger write failed).
        this.state.set(key, { status: 'finalized', createdAtMs, taskId });
        resolve({ ok: true, taskId });
        await this.persistBestEffort('finalize', key);
      },
      release: async () => {
        this.state.delete(key);
        resolve({ ok: false });
        // Nothing to persist — pending reservations were never written.
      },
    };
  }

  /**
   * Drop a finalized entry regardless of TTL. Used when a replay's `taskId`
   * no longer resolves to a task (e.g. deleted, or terminal-and-never-ran —
   * see `isReplayableTask` in `launch-service.ts`) so the key becomes
   * claimable again instead of permanently pointing at a dead reference.
   */
  async clear(key: string): Promise<void> {
    if (!this.state.delete(key)) return;
    await this.persistBestEffort('clear', key);
  }

  /** Number of entries (pending + finalized) currently held. Test/diagnostic use. */
  size(): number {
    return this.state.size;
  }

  private compactExpired(): void {
    const nowMs = this.now();
    for (const [key, entry] of this.state) {
      if (entry.status === 'finalized' && nowMs - entry.createdAtMs > this.ttlMs) {
        this.state.delete(key);
      }
    }
  }

  /**
   * `persist()` wrapped so a disk failure (full disk, permissions, missing
   * dir) never propagates to `finalize()`/`clear()` callers (issue #1526
   * Phase B review item 1). Durability is best-effort by design: the
   * in-memory state (already updated by the caller before this runs) stays
   * correct regardless, so same-process replay protection is unaffected —
   * only the on-disk copy (and therefore cross-restart durability) is at
   * risk. Logged loudly so a persistently-failing disk is visible in
   * server logs rather than silently degrading protection.
   */
  private async persistBestEffort(op: string, key: string): Promise<void> {
    try {
      await this.persist();
    } catch (err) {
      console.error(
        `[idempotency-ledger] ${op}(${JSON.stringify(key)}): failed to persist ledger to disk. ` +
        `In-memory state is unaffected (same-process replay protection still holds), but this ` +
        `entry will NOT survive a restart until the next successful write:`,
        err,
      );
    }
  }

  private async persist(): Promise<void> {
    const prev = this.writeLock;
    let release: () => void = () => {};
    this.writeLock = new Promise<void>((res) => {
      release = res;
    });
    try {
      await prev;
      const entries: Record<string, IdempotencyLedgerEntry> = {};
      for (const [key, entry] of this.state) {
        if (entry.status !== 'finalized') continue;
        entries[key] = { taskId: entry.taskId, createdAt: new Date(entry.createdAtMs).toISOString() };
      }
      const file: IdempotencyLedgerFile = { schemaVersion: SCHEMA_VERSION, entries };
      // Compact JSON: finalize/clear rewrite the full finalized map; pretty-print
      // inflates bytes/CPU under spawn retries with no parse benefit (issue #2266).
      // Load still accepts legacy pretty-printed files via JSON.parse.
      await atomicWriteFile(this.filePath, JSON.stringify(file));
    } finally {
      release();
    }
  }
}
