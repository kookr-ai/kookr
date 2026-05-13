import { createHash } from 'node:crypto';
import type { HttpPushTracker } from '../core/http-push-tracker.js';
import type { TaskStore } from '../core/tasks.js';
import type { ActivityLedger, ActivityLedgerRow, HookEnvelopeV1 } from '../core/activity-ledger.js';
import type { AgentActivityMeta, InjectHookEventResult } from '../core/types.js';

/**
 * Narrow surface the {@link HookIngestion} service needs from an adapter.
 * Decouples the watcher and HTTP route from the full {@link AgentAdapter}
 * interface so ingestion can be tested in isolation with a 1-method stub.
 */
export interface HookEventInjector {
  injectHookEvent(tmuxName: string, rawJson: string, sequence?: number): InjectHookEventResult;
}

export interface HookIngestionDeps {
  adapter: HookEventInjector;
  httpPushTracker?: HttpPushTracker;
  /** Optional ledger for diagnostics. When set, every observed record
   *  (parent / child / malformed / duplicate) gets a row appended. */
  activityLedger?: ActivityLedger;
  /** Used to resolve `taskId` for ledger envelopes; optional in tests. */
  taskStore?: Pick<TaskStore, 'findTaskBySession'>;
  /**
   * Dedup TTL window. Defaults to 5 seconds — comfortably covers both
   * arrival orderings: the file watcher's 3s poll backup, and the
   * synchronous-ish HTTP fan-out from the Kookr hook writer.
   * See rfc-activity-log-reliability §5.
   */
  dedupTtlMs?: number;
  /** Test seam: overridable clock for deterministic dedup-window assertions. */
  now?: () => number;
}

export interface IngestInput {
  kookrSessionId: string;
  raw: string;
  source: 'file' | 'http';
}

export interface IngestResult {
  dispatched: boolean;
  reason?: 'duplicate' | 'empty';
  contentHash: string;
  /** The adapter's classification of this record (or the first occurrence's
   *  classification on a dedup hit). Surfaced so callers can inspect parse
   *  status / parentage without re-parsing. */
  injectResult: InjectHookEventResult;
}

/**
 * Routes hook records from both the file watcher (durable replay path) and
 * the HTTP endpoint (active fast path) through a single dedup point before
 * they reach the adapter. Deduplication is keyed by
 * `(kookrSessionId, sha256(trimmed raw))` with a short TTL — the first
 * source to arrive dispatches the event; the second is dropped with the
 * arrival noted via {@link HttpPushTracker} for telemetry.
 *
 * See rfc-activity-log-reliability §5.
 */
interface CacheEntry {
  ts: number;
  /** The first record's adapter result — duplicates inherit it for the ledger. */
  result: InjectHookEventResult;
  /** The first record's source — for diagnostics if needed. */
  firstSource: 'file' | 'http';
  /**
   * Set when this entry was seeded from a durable ledger (post-restart
   * hydration) rather than from a live ingest. Hydrated entries skip TTL
   * GC and skip the duplicate-row ledger write so a file-watcher replay
   * after a crash does not inflate diagnostic counts or advance the
   * sequence space. See rfc-activity-log-reliability edge cases.
   */
  hydrated?: boolean;
}

export class HookIngestion implements HookEventInjector {
  private cache = new Map<string, CacheEntry>();
  private sequenceCounters = new Map<string, number>();
  private metaByKookrSession = new Map<string, AgentActivityMeta>();
  private adapter: HookEventInjector;
  private httpPushTracker?: HttpPushTracker;
  private activityLedger?: ActivityLedger;
  private taskStore?: Pick<TaskStore, 'findTaskBySession'>;
  private dedupTtlMs: number;
  private now: () => number;

  constructor(deps: HookIngestionDeps) {
    this.adapter = deps.adapter;
    this.httpPushTracker = deps.httpPushTracker;
    this.activityLedger = deps.activityLedger;
    this.taskStore = deps.taskStore;
    this.dedupTtlMs = deps.dedupTtlMs ?? 5000;
    this.now = deps.now ?? Date.now;
  }

  /** HookFileWatcher-compatible alias. Treats the call as file-source. */
  injectHookEvent(tmuxName: string, rawJson: string): InjectHookEventResult {
    const result = this.ingest({ kookrSessionId: tmuxName, raw: rawJson, source: 'file' });
    return result.injectResult;
  }

  /** HTTP /api/hook-event/:sessionId entry point. */
  ingestFromHttp(sessionId: string, body: string): IngestResult {
    return this.ingest({ kookrSessionId: sessionId, raw: body, source: 'http' });
  }

  private ingest({ kookrSessionId, raw, source }: IngestInput): IngestResult {
    const normalized = raw.trim();
    const contentHash = createHash('sha256').update(normalized).digest('hex');
    if (!normalized) {
      return {
        dispatched: false,
        reason: 'empty',
        contentHash,
        injectResult: { parseStatus: 'dropped', agentType: 'claude-code', error: 'empty payload' },
      };
    }

    const key = `${kookrSessionId}::${contentHash}`;
    const now = this.now();
    this.gcExpired(now);

    const httpTrackerCall = () => {
      if (source === 'http' && this.httpPushTracker) {
        this.httpPushTracker.recordHttpArrival(kookrSessionId, raw);
      }
    };

    const existing = this.cache.get(key);
    if (existing) {
      httpTrackerCall();
      if (existing.hydrated) {
        // Restart-replay hit: this record was already ledger-recorded before
        // the crash. Drop silently — no new ledger row, no meta bump, no
        // sequence allocation. The original arrival's bookkeeping survives.
        return { dispatched: false, reason: 'duplicate', contentHash, injectResult: existing.result };
      }
      // Steady-state dual-delivery: the OTHER source already dispatched this
      // record. Reuse the original sequence number on the diagnostic ledger
      // row so the sequence space tracks dispatches, not arrivals.
      this.bumpMeta(kookrSessionId, { duplicate: true });
      this.writeLedger({
        kookrSessionId,
        contentHash,
        source,
        sequence: existing.result.sequence ?? 0,
        rawBytes: normalized.length,
        result: existing.result,
        projection: 'diagnostic_only',
      });
      return { dispatched: false, reason: 'duplicate', contentHash, injectResult: existing.result };
    }

    httpTrackerCall();
    // First-observation: allocate a fresh sequence AFTER the cache check so
    // duplicates do not advance the sequence counter (a restart-replay would
    // otherwise inflate the sequence space by the size of the ledger).
    const sequence = this.nextSequence(kookrSessionId);

    let result: InjectHookEventResult;
    try {
      result = this.adapter.injectHookEvent(kookrSessionId, normalized, sequence);
    } catch (err) {
      // Adapters MUST NOT throw on a malformed payload, but if a different
      // bug surfaces, record a malformed ledger row and rethrow so callers
      // see the failure. Cache stays empty so a replay can retry.
      const malformed: InjectHookEventResult = {
        parseStatus: 'malformed',
        agentType: 'claude-code',
        error: err instanceof Error ? err.message : String(err),
      };
      this.bumpMeta(kookrSessionId, { duplicate: false, result: malformed });
      this.writeLedger({
        kookrSessionId,
        contentHash,
        source,
        sequence,
        rawBytes: normalized.length,
        result: malformed,
        projection: 'diagnostic_only',
      });
      throw err;
    }

    if (result.parseStatus === 'ok') {
      this.cache.set(key, { ts: now, result, firstSource: source });
    }
    this.bumpMeta(kookrSessionId, { duplicate: false, result });
    this.writeLedger({
      kookrSessionId,
      contentHash,
      source,
      sequence,
      rawBytes: normalized.length,
      result,
      projection: ledgerProjection(result),
    });
    return { dispatched: result.parseStatus === 'ok', contentHash, injectResult: result };
  }

  /**
   * Returns the in-memory counters published to {@link AgentState.activityMeta}.
   * Undefined when no events have been observed for this Kookr session.
   */
  getActivityMeta(kookrSessionId: string): AgentActivityMeta | undefined {
    const meta = this.metaByKookrSession.get(kookrSessionId);
    return meta ? { ...meta } : undefined;
  }

  /**
   * Seed the dedup cache + sequence counter for `kookrSessionId` from its
   * durable ledger. Called by the bootstrap before any file watcher is
   * armed so a `replayExisting: true` replay does not re-inject records
   * that were already delivered (via HTTP) and durably recorded before
   * the server crash. See rfc-activity-log-reliability edge cases.
   *
   * No-op when the ledger is empty or absent. Synthesizes a stand-in
   * {@link InjectHookEventResult} from each row so a subsequent duplicate
   * arrival can still report parentage / agentType to callers without
   * re-parsing the raw payload.
   */
  async hydrateFromLedger(
    kookrSessionId: string,
    ledger: ActivityLedger,
  ): Promise<{ hydratedHashes: number; maxSequence: number }> {
    const rows = await ledger.readAll(kookrSessionId);
    let maxSequence = 0;
    let hydratedHashes = 0;
    for (const row of rows) {
      const { envelope } = row;
      if (envelope.sequence > maxSequence) maxSequence = envelope.sequence;
      // Only parsed-ok rows reached the adapter, so only those can be
      // duplicates if the file watcher replays them. Malformed / dropped /
      // duplicate rows were never dispatched — replay would just re-write
      // their counterparts.
      if (envelope.parseStatus !== 'ok' || row.projection === 'diagnostic_only') continue;
      const key = `${kookrSessionId}::${envelope.contentHash}`;
      if (this.cache.has(key)) continue;
      // Pin hydrated entries against the dedup TTL — file replay may take
      // longer than dedupTtlMs on large ledgers, and re-dispatching a record
      // because the cache aged out defeats the purpose of hydration.
      // POSITIVE_INFINITY ensures gcExpired never sweeps these; forgetSession
      // (and pruneSession via delete-task) is the only path that removes them.
      this.cache.set(key, {
        ts: Number.POSITIVE_INFINITY,
        firstSource: envelope.source,
        hydrated: true,
        result: {
          parseStatus: 'ok',
          agentType: envelope.provider,
          parentage: envelope.parentage,
          rawSessionId: envelope.rawSessionId,
          rawTurnId: envelope.rawTurnId,
          rawHookEventName: envelope.rawHookEventName,
          sequence: envelope.sequence,
        },
      });
      hydratedHashes += 1;
    }
    if (maxSequence > 0) {
      const existing = this.sequenceCounters.get(kookrSessionId) ?? 0;
      if (maxSequence > existing) this.sequenceCounters.set(kookrSessionId, maxSequence);
    }
    return { hydratedHashes, maxSequence };
  }

  /** Forget per-session bookkeeping — called when a task / session is deleted. */
  forgetSession(kookrSessionId: string): void {
    this.metaByKookrSession.delete(kookrSessionId);
    this.sequenceCounters.delete(kookrSessionId);
    // Drop dedup entries for this session.
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${kookrSessionId}::`)) this.cache.delete(key);
    }
  }

  private bumpMeta(
    kookrSessionId: string,
    args: { duplicate: boolean; result?: InjectHookEventResult },
  ): void {
    const meta = this.metaByKookrSession.get(kookrSessionId) ?? emptyMeta();
    if (args.duplicate) {
      meta.duplicateRecordCount += 1;
    } else {
      meta.totalEventsSeen += 1;
      const r = args.result!;
      if (r.parseStatus === 'malformed') meta.malformedRecordCount += 1;
      else if (r.parseStatus === 'dropped') meta.droppedRecordCount += 1;
      else {
        switch (r.parentage) {
          case 'parent': meta.parentEventCount += 1; break;
          case 'child': meta.childEventCount += 1; break;
          case 'foreign': meta.foreignEventCount += 1; break;
          case 'unknown':
          default: meta.unknownParentageCount += 1; break;
        }
      }
    }
    this.metaByKookrSession.set(kookrSessionId, meta);
  }

  private nextSequence(kookrSessionId: string): number {
    const next = (this.sequenceCounters.get(kookrSessionId) ?? 0) + 1;
    this.sequenceCounters.set(kookrSessionId, next);
    return next;
  }

  private writeLedger(args: {
    kookrSessionId: string;
    contentHash: string;
    source: 'file' | 'http';
    sequence: number;
    rawBytes: number;
    result: InjectHookEventResult;
    projection: ActivityLedgerRow['projection'];
  }): void {
    if (!this.activityLedger) return;
    const taskId = this.taskStore?.findTaskBySession(args.kookrSessionId)?.id;
    const envelope: HookEnvelopeV1 = {
      schemaVersion: 'hook-envelope.v1',
      kookrSessionId: args.kookrSessionId,
      taskId,
      provider: args.result.agentType,
      rawSessionId: args.result.rawSessionId,
      rawTurnId: args.result.rawTurnId,
      rawHookEventName: args.result.rawHookEventName,
      source: args.source,
      observedAt: new Date(this.now()).toISOString(),
      sequence: args.sequence,
      contentHash: args.contentHash,
      parentage: args.result.parentage ?? 'unknown',
      parseStatus: args.result.parseStatus,
      rawBytes: args.rawBytes,
    };
    const row: ActivityLedgerRow = {
      envelope,
      projection: args.projection,
      ...(args.result.error ? { error: args.result.error } : {}),
    };
    // Fire-and-forget: ledger latency must not sit in front of hook delivery.
    void this.activityLedger.append(row).catch(() => { /* diagnostics-only path */ });
  }

  private gcExpired(now: number): void {
    const threshold = now - this.dedupTtlMs;
    for (const [key, entry] of this.cache) {
      if (entry.ts < threshold) this.cache.delete(key);
    }
  }
}

function ledgerProjection(result: InjectHookEventResult): ActivityLedgerRow['projection'] {
  if (result.parseStatus !== 'ok') return 'diagnostic_only';
  if (result.parentage === 'parent') return 'parent_activity';
  if (result.parentage === 'child') return 'child_activity';
  return 'diagnostic_only';
}

function emptyMeta(): AgentActivityMeta {
  return {
    totalEventsSeen: 0,
    parentEventCount: 0,
    childEventCount: 0,
    foreignEventCount: 0,
    unknownParentageCount: 0,
    malformedRecordCount: 0,
    droppedRecordCount: 0,
    duplicateRecordCount: 0,
  };
}
