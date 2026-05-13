import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentType } from './agent-types.js';
import type { AgentEvent, EventParentage } from './types.js';

/**
 * Durable per-Kookr-session ingestion record. Phase 3 of
 * rfc-activity-log-reliability §1. Distinct from {@link AgentEvent}: the
 * envelope is the ledger's source of truth; AgentEvent is the normalized
 * projection that flows into the monitor window.
 */
export interface HookEnvelopeV1 {
  schemaVersion: 'hook-envelope.v1';
  kookrSessionId: string;
  taskId?: string;
  provider: AgentType;
  rawSessionId?: string;
  rawTurnId?: string;
  rawHookEventName?: string;
  source: 'file' | 'http';
  /** ISO timestamp when Kookr observed the record. */
  observedAt: string;
  /** Kookr-assigned monotonic per-kookrSessionId sequence. */
  sequence: number;
  /** sha256 of trimmed raw payload. */
  contentHash: string;
  parentage: EventParentage;
  parseStatus: 'ok' | 'repaired' | 'malformed' | 'dropped';
  /** Byte length of the raw payload — the raw bytes themselves are not
   *  duplicated here. Operators correlate to the original
   *  `~/.kookr/hooks/<session>.jsonl` line via contentHash if needed. */
  rawBytes: number;
}

export interface ActivityLedgerRow {
  envelope: HookEnvelopeV1;
  /** Normalized event when parsing succeeded; absent for malformed/dropped. */
  event?: AgentEvent;
  /** Where this row affected live state, or whether it was diagnostic-only. */
  projection?: 'parent_activity' | 'child_activity' | 'diagnostic_only';
  /** Free-text reason for parseStatus !== 'ok'. */
  error?: string;
}

export interface ActivityLedgerStats {
  kookrSessionId: string;
  rawRecordCount: number;
  parsedRecordCount: number;
  malformedRecordCount: number;
  duplicateRecordCount: number;
  droppedRecordCount: number;
  parentEventCount: number;
  childEventCount: number;
  foreignEventCount: number;
  unknownParentageCount: number;
  rawBytesTotal: number;
}

/** Owner-only directory bits — locks the activity ledger to the running user. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** Default size cap per ledger file before rotation. 10 MiB — generous for
 *  long sessions but small enough that worst-case disk usage is bounded:
 *  current + one rotation = ~20 MiB per Kookr session. */
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface ActivityLedgerOptions {
  /** Override the default 10 MiB rotation threshold. */
  maxFileBytes?: number;
}

/**
 * Append-only JSONL ledger of all hook records observed for a Kookr session,
 * including malformed and duplicate ones. Lives under
 * `<activityDir>/<kookrSessionId>.jsonl` with owner-only permissions. The
 * ledger is for diagnostics — live anomaly state still lives in the
 * monitor's bounded window. See rfc-activity-log-reliability §7.
 */
export class ActivityLedger {
  private writeQueues = new Map<string, Promise<void>>();
  private dirEnsured = false;
  private maxFileBytes: number;

  constructor(private activityDir: string, options: ActivityLedgerOptions = {}) {
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  /**
   * Queue an append for `row`. Returns the chained promise so tests can
   * await flush; production callers fire-and-forget so ledger latency
   * never sits in front of hook delivery.
   */
  append(row: ActivityLedgerRow): Promise<void> {
    const session = row.envelope.kookrSessionId;
    const prior = this.writeQueues.get(session) ?? Promise.resolve();
    const next = prior
      .catch(() => { /* swallow previous failure for chain continuity */ })
      .then(() => this.appendOnce(row));
    this.writeQueues.set(session, next);
    return next;
  }

  private async appendOnce(row: ActivityLedgerRow): Promise<void> {
    if (!this.dirEnsured) {
      await mkdir(this.activityDir, { recursive: true, mode: DIR_MODE });
      this.dirEnsured = true;
    }
    const path = this.pathFor(row.envelope.kookrSessionId);
    const line = `${JSON.stringify(row)}\n`;

    let currentSize = 0;
    try {
      const st = await stat(path);
      currentSize = st.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (currentSize > 0 && currentSize + Buffer.byteLength(line, 'utf8') > this.maxFileBytes) {
      await this.rotate(path);
    }

    const handle = await open(path, 'a', FILE_MODE);
    try {
      await handle.appendFile(line, 'utf8');
    } finally {
      await handle.close();
    }
  }

  /**
   * Atomically move the current ledger file aside to `<path>.1`,
   * overwriting any previous rotation. Best-effort: a missing source file
   * is treated as success because another writer may have rotated first.
   */
  private async rotate(path: string): Promise<void> {
    const rotated = `${path}.1`;
    try {
      await unlink(rotated);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    try {
      await rename(path, rotated);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  /**
   * Flush all pending writes for `kookrSessionId` (or every session when
   * omitted). Tests use this to await durability before asserting.
   */
  async flush(kookrSessionId?: string): Promise<void> {
    if (kookrSessionId) {
      const q = this.writeQueues.get(kookrSessionId);
      if (q) await q.catch(() => {});
      return;
    }
    await Promise.all(
      [...this.writeQueues.values()].map((q) => q.catch(() => {})),
    );
  }

  pathFor(kookrSessionId: string): string {
    return join(this.activityDir, `${kookrSessionId}.jsonl`);
  }

  async readAll(kookrSessionId: string): Promise<ActivityLedgerRow[]> {
    await this.flush(kookrSessionId);
    const path = this.pathFor(kookrSessionId);
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const rows: ActivityLedgerRow[] = [];
    for (const line of content.split('\n')) {
      if (!line) continue;
      try {
        rows.push(JSON.parse(line) as ActivityLedgerRow);
      } catch {
        // Ledger row is self-malformed — extremely rare, ignore for stats.
      }
    }
    return rows;
  }

  async stats(kookrSessionId: string): Promise<ActivityLedgerStats> {
    const rows = await this.readAll(kookrSessionId);
    const out: ActivityLedgerStats = {
      kookrSessionId,
      rawRecordCount: rows.length,
      parsedRecordCount: 0,
      malformedRecordCount: 0,
      duplicateRecordCount: 0,
      droppedRecordCount: 0,
      parentEventCount: 0,
      childEventCount: 0,
      foreignEventCount: 0,
      unknownParentageCount: 0,
      rawBytesTotal: 0,
    };
    for (const row of rows) {
      const { envelope, projection } = row;
      out.rawBytesTotal += envelope.rawBytes;

      // Each row contributes to exactly one parseStatus bucket.
      if (envelope.parseStatus === 'malformed') {
        out.malformedRecordCount += 1;
        continue;
      }
      if (envelope.parseStatus === 'dropped') {
        out.droppedRecordCount += 1;
        continue;
      }

      // 'ok' or 'repaired' from here.
      out.parsedRecordCount += 1;

      // diagnostic_only projection on a parsed-ok row marks the second arrival
      // of an already-dispatched record — count as duplicate, do NOT re-count
      // parentage (the original arrival's parentage row already did).
      if (projection === 'diagnostic_only') {
        out.duplicateRecordCount += 1;
        continue;
      }

      switch (envelope.parentage) {
        case 'parent': out.parentEventCount += 1; break;
        case 'child': out.childEventCount += 1; break;
        case 'foreign': out.foreignEventCount += 1; break;
        case 'unknown':
        default: out.unknownParentageCount += 1; break;
      }
    }
    return out;
  }

  /** Delete this session's ledger file AND any rotated `.1` companion.
   *  Used when a task is deleted. */
  async pruneSession(kookrSessionId: string): Promise<void> {
    await this.flush(kookrSessionId);
    this.writeQueues.delete(kookrSessionId);
    for (const path of [this.pathFor(kookrSessionId), `${this.pathFor(kookrSessionId)}.1`]) {
      try {
        await unlink(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  }
}

