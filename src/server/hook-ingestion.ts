import { createHash } from 'node:crypto';
import type { HttpPushTracker } from '../core/http-push-tracker.js';
import type { TaskStore } from '../core/tasks.js';
import type { ActivityLedger, ActivityLedgerRow, HookEnvelopeV1 } from '../core/activity-ledger.js';
import type { AgentActivityMeta, EventOrigin, InjectHookEventResult } from '../core/types.js';
import type { CoordinatorAuditTailRow } from './coordinator/detectors.js';

/**
 * Synthetic Kookr session id prefix that marks a session as replay-only.
 * `scripts/replay-hooks.ts` feeds a recorded hook JSONL into a running dev
 * instance against a session whose id starts with this prefix; ingestion then
 * tags every such record `origin: 'replay'`. Scoping replay to a dedicated
 * synthetic session (never a live tmux name) is the structural guard against
 * replayed events leaking into a live session's state — see issue #701 and KB
 * lesson `scope-replay-streams-by-negotiated-epochs`.
 */
export const REPLAY_SESSION_PREFIX = 'kookr-replay-';

/**
 * Classify a Kookr session id as `'replay'` (synthetic reproduction session)
 * or `'live'` (a real agent session). The session id is the single source of
 * truth so the HTTP route needs no extra parameter and a replayed record can
 * never be mistaken for fresh live output.
 */
export function deriveEventOrigin(kookrSessionId: string): EventOrigin {
  return kookrSessionId.startsWith(REPLAY_SESSION_PREFIX) ? 'replay' : 'live';
}

/**
 * Narrow surface the {@link HookIngestion} service needs from an adapter.
 * Decouples the watcher and HTTP route from the full {@link AgentAdapter}
 * interface so ingestion can be tested in isolation with a 1-method stub.
 *
 * `options.origin` is forwarded so a future detector/monitor change can honor
 * replay-vs-live without re-deriving it; existing adapters may safely ignore it.
 */
export interface HookEventInjector {
  injectHookEvent(
    tmuxName: string,
    rawJson: string,
    sequence?: number,
    options?: { origin?: EventOrigin; startupReplay?: boolean; fileMtimeMs?: number },
  ): InjectHookEventResult;
}

export interface HookParseDegradationEvent {
  kookrSessionId: string;
  source: IngestInput['source'];
  eventId: string;
  sequence: number;
  error: string;
  excerpt: string;
  observedAt: string;
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
  /**
   * Called for live malformed hook records only. Startup replay and synthetic
   * replay sessions remain diagnostics-only so old bad records do not alert.
   */
  onParseDegradation?: (event: HookParseDegradationEvent) => void;
  /** Lag threshold for structured diagnostics. Defaults to 2 seconds. */
  lagWarningThresholdMs?: number;
}

export interface IngestInput {
  kookrSessionId: string;
  raw: string;
  source: 'file' | 'http';
  startupReplay?: boolean;
  fileMtimeMs?: number;
}

export interface IngestResult {
  dispatched: boolean;
  reason?: 'duplicate' | 'empty';
  contentHash: string;
  /**
   * End-to-end correlation id for this hook event (#705). Minted here at
   * ingestion via {@link mintEventId} and threaded unchanged through the
   * pipeline into the derived finding / emitted alert. Stable across durable
   * replay (the hydrated/duplicate paths recompute it from the original
   * sequence) so the same hook event always carries the same id.
   */
  eventId: string;
  /** The adapter's classification of this record (or the first occurrence's
   *  classification on a dedup hit). Surfaced so callers can inspect parse
   *  status / parentage without re-parsing. */
  injectResult: InjectHookEventResult;
  /** Live vs. replayed, derived from the session id. Surfaced so the replay
   *  harness (and tests) can confirm replayed records are tagged `'replay'`. */
  origin: EventOrigin;
}

/**
 * Mint the stable end-to-end correlation id for a hook event (#705).
 *
 * The id is a pure, deterministic function of the owning Kookr session and the
 * Kookr-assigned monotonic {@link EventMeta.sequence}. Both inputs survive
 * durable replay (hydration re-dispatches with the original sequence) and
 * WebSocket reconnect (snapshots are rebuilt from stored monitor state, never
 * re-minted), so the same event always yields the same id. Because it is pure,
 * downstream code recomputes it from the same `(kookrSessionId, sequence)`
 * carried on {@link EventMeta} rather than regenerating a fresh id — the value
 * is threaded unchanged by construction.
 *
 * The session id is hashed (not embedded verbatim) so the correlation id can
 * appear in structured logs and on the wire without leaking the raw session
 * identifier — addressing the redaction open question in #705.
 */
export function mintEventId(kookrSessionId: string, sequence: number): string {
  const sessionDigest = createHash('sha256').update(kookrSessionId).digest('hex').slice(0, 12);
  return `evt_${sessionDigest}_${sequence}`;
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

const COORDINATOR_AUDIT_TAIL_LIMIT = 1_000;
const DEFAULT_LAG_WARNING_THRESHOLD_MS = 2_000;
const LAG_SAMPLE_LIMIT = 128;

export type HookWriteTimestampSource = 'payload' | 'file_mtime' | 'missing' | 'invalid';

export interface HookIngestionSessionDiagnostics {
  kookrSessionId: string;
  totalArrivals: number;
  dispatchedArrivals: number;
  duplicateArrivals: number;
  missingWriteTimestampCount: number;
  invalidWriteTimestampCount: number;
  futureWriteTimestampCount: number;
  notableLagCount: number;
  startupReplayArrivalCount: number;
  lastProcessedAt: string | null;
  lastWriteTimestampAt: string | null;
  lastWriteTimestampSource: HookWriteTimestampSource | null;
  lag: {
    count: number;
    lastMs: number | null;
    meanMs: number | null;
    maxMs: number | null;
    p95Ms: number | null;
  };
  sourceCounts: Record<'file' | 'http', number>;
  writeTimestampSourceCounts: Record<HookWriteTimestampSource, number>;
}

export interface HookIngestionDiagnosticsSnapshot {
  schemaVersion: 'hook-ingestion-diagnostics.v1';
  generatedAt: string;
  lagWarningThresholdMs: number;
  sessionCount: number;
  totalArrivals: number;
  missingWriteTimestampCount: number;
  notableLagCount: number;
  sessions: HookIngestionSessionDiagnostics[];
}

interface MutableHookIngestionSessionDiagnostics {
  kookrSessionId: string;
  totalArrivals: number;
  dispatchedArrivals: number;
  duplicateArrivals: number;
  missingWriteTimestampCount: number;
  invalidWriteTimestampCount: number;
  futureWriteTimestampCount: number;
  notableLagCount: number;
  startupReplayArrivalCount: number;
  lastProcessedAtMs: number | null;
  lastWriteTimestampMs: number | null;
  lastWriteTimestampSource: HookWriteTimestampSource | null;
  lastLagMs: number | null;
  lagMaxMs: number | null;
  lagSamples: number[];
  sourceCounts: Record<'file' | 'http', number>;
  writeTimestampSourceCounts: Record<HookWriteTimestampSource, number>;
  overLagThreshold: boolean;
}

export class HookIngestion implements HookEventInjector {
  private cache = new Map<string, CacheEntry>();
  private sequenceCounters = new Map<string, number>();
  private metaByKookrSession = new Map<string, AgentActivityMeta>();
  private coordinatorAuditTail: CoordinatorAuditTailRow[] = [];
  private latestCoordinatorPostToolUseRows = new Map<string, CoordinatorAuditTailRow>();
  private coordinatorAuditTailProjectionCache?: readonly CoordinatorAuditTailRow[];
  private adapter: HookEventInjector;
  private httpPushTracker?: HttpPushTracker;
  private activityLedger?: ActivityLedger;
  private taskStore?: Pick<TaskStore, 'findTaskBySession'>;
  private dedupTtlMs: number;
  private now: () => number;
  private onParseDegradation?: (event: HookParseDegradationEvent) => void;
  private lagWarningThresholdMs: number;
  private diagnosticsBySession = new Map<string, MutableHookIngestionSessionDiagnostics>();

  constructor(deps: HookIngestionDeps) {
    this.adapter = deps.adapter;
    this.httpPushTracker = deps.httpPushTracker;
    this.activityLedger = deps.activityLedger;
    this.taskStore = deps.taskStore;
    this.dedupTtlMs = deps.dedupTtlMs ?? 5000;
    this.now = deps.now ?? Date.now;
    this.onParseDegradation = deps.onParseDegradation;
    this.lagWarningThresholdMs = deps.lagWarningThresholdMs ?? DEFAULT_LAG_WARNING_THRESHOLD_MS;
  }

  /** HookFileWatcher-compatible alias. Treats the call as file-source. */
  injectHookEvent(
    tmuxName: string,
    rawJson: string,
    _sequence?: number,
    options?: { origin?: EventOrigin; startupReplay?: boolean; fileMtimeMs?: number },
  ): InjectHookEventResult {
    const result = this.ingest({
      kookrSessionId: tmuxName,
      raw: rawJson,
      source: 'file',
      startupReplay: options?.startupReplay,
      fileMtimeMs: options?.fileMtimeMs,
    });
    return result.injectResult;
  }

  /** HTTP /api/hook-event/:sessionId entry point. */
  ingestFromHttp(sessionId: string, body: string): IngestResult {
    return this.ingest({ kookrSessionId: sessionId, raw: body, source: 'http' });
  }

  private ingest({ kookrSessionId, raw, source, startupReplay = false, fileMtimeMs }: IngestInput): IngestResult {
    const normalized = raw.trim();
    const contentHash = createHash('sha256').update(normalized).digest('hex');
    const origin = deriveEventOrigin(kookrSessionId);
    if (!normalized) {
      return {
        dispatched: false,
        reason: 'empty',
        contentHash,
        eventId: mintEventId(kookrSessionId, 0),
        origin,
        injectResult: { parseStatus: 'dropped', agentType: 'claude-code', error: 'empty payload', origin },
      };
    }

    const key = `${kookrSessionId}::${contentHash}`;
    const now = this.now();
    const lagSample = this.recordLagSample({
      kookrSessionId,
      raw: normalized,
      source,
      processedAtMs: now,
      fileMtimeMs,
      startupReplay,
    });
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
        // the crash, but the in-memory monitor/watchdog state is empty after
        // restart. Re-dispatch into live state using the original Kookr
        // sequence while suppressing duplicate ledger writes and sequence
        // allocation.
        const result = this.adapter.injectHookEvent(
          kookrSessionId,
          normalized,
          existing.result.sequence,
          { origin },
        );
        result.origin = origin;
        this.cache.set(key, { ts: now, result, firstSource: existing.firstSource });
        this.bumpMeta(kookrSessionId, { duplicate: false, result });
        // Replay re-dispatch: recompute the correlation id from the ORIGINAL
        // sequence so the id is identical to the pre-restart dispatch.
        const eventId = mintEventId(kookrSessionId, result.sequence ?? existing.result.sequence ?? 0);
        this.markDiagnosticsArrival(kookrSessionId, { duplicate: false, dispatched: result.parseStatus === 'ok' });
        return { dispatched: result.parseStatus === 'ok', contentHash, eventId, origin, injectResult: result };
      }
      // Steady-state dual-delivery: the OTHER source already dispatched this
      // record. Reuse the original sequence number on the diagnostic ledger
      // row so the sequence space tracks dispatches, not arrivals.
      this.bumpMeta(kookrSessionId, { duplicate: true });
      this.markDiagnosticsArrival(kookrSessionId, { duplicate: true, dispatched: false });
      this.writeLedger({
        kookrSessionId,
        contentHash,
        source,
        sequence: existing.result.sequence ?? 0,
        rawBytes: normalized.length,
        result: existing.result,
        projection: 'diagnostic_only',
      });
      // A dual-delivery duplicate reports the SAME correlation id as the first
      // occurrence (recomputed from the original sequence) — both arrivals are
      // the same logical event.
      const eventId = mintEventId(kookrSessionId, existing.result.sequence ?? 0);
      return { dispatched: false, reason: 'duplicate', contentHash, eventId, origin, injectResult: { ...existing.result, origin } };
    }

    httpTrackerCall();
    // First-observation: allocate a fresh sequence AFTER the cache check so
    // duplicates do not advance the sequence counter (a restart-replay would
    // otherwise inflate the sequence space by the size of the ledger).
    const sequence = this.nextSequence(kookrSessionId);
    // Mint the end-to-end correlation id once, at ingestion, from the freshly
    // allocated sequence (#705). Downstream code recomputes the identical id
    // from `(kookrSessionId, sequence)` carried on EventMeta.
    const eventId = mintEventId(kookrSessionId, sequence);

    let result: InjectHookEventResult;
    try {
      result = this.adapter.injectHookEvent(kookrSessionId, normalized, sequence, { origin });
      result.origin = origin;
    } catch (err) {
      // Adapters MUST NOT throw on a malformed payload, but if a different
      // bug surfaces, record a malformed ledger row and rethrow so callers
      // see the failure. Cache stays empty so a replay can retry.
      const malformed: InjectHookEventResult = {
        parseStatus: 'malformed',
        agentType: 'claude-code',
        error: err instanceof Error ? err.message : String(err),
        origin,
      };
      this.bumpMeta(kookrSessionId, { duplicate: false, result: malformed });
      this.emitParseDegradation({
        kookrSessionId,
        source,
        eventId,
        sequence,
        result: malformed,
        raw: normalized,
        origin,
        startupReplay,
      });
      this.writeLedger({
        kookrSessionId,
        contentHash,
        source,
        sequence,
        rawBytes: normalized.length,
        result: malformed,
        projection: 'diagnostic_only',
      });
      console.debug('[hook-ingestion] event ingested', {
        eventId,
        kookrSessionId,
        sequence,
        source,
        ...(lagSample ? {
          lagMs: lagSample.lagMs,
          writeTimestampSource: lagSample.writeTimestampSource,
        } : {}),
        parseStatus: malformed.parseStatus,
      });
      throw err;
    }

    if (result.parseStatus === 'ok') {
      this.cache.set(key, { ts: now, result, firstSource: source });
    }
    this.bumpMeta(kookrSessionId, { duplicate: false, result });
    this.markDiagnosticsArrival(kookrSessionId, { duplicate: false, dispatched: result.parseStatus === 'ok' });
    if (result.parseStatus === 'malformed') {
      this.emitParseDegradation({
        kookrSessionId,
        source,
        eventId,
        sequence,
        result,
        raw: normalized,
        origin,
        startupReplay,
      });
    }
    this.writeLedger({
      kookrSessionId,
      contentHash,
      source,
      sequence,
      rawBytes: normalized.length,
      result,
      projection: ledgerProjection(result),
    });
    const observedAt = new Date(now).toISOString();
    const taskId = this.taskStore?.findTaskBySession(kookrSessionId)?.id;
    this.appendCoordinatorAuditTail({
      ...(taskId ? { taskId } : {}),
      observedAt,
      ...(result.rawHookEventName ? { rawHookEventName: result.rawHookEventName } : {}),
      envelope: {
        ...(taskId ? { taskId } : {}),
        kookrSessionId,
        observedAt,
        ...(result.rawHookEventName ? { rawHookEventName: result.rawHookEventName } : {}),
      },
    });
    // Structured lineage log (#705): one line per ingested event carrying the
    // correlation id operators use to trace this event through the pipeline.
    console.debug('[hook-ingestion] event ingested', {
      eventId,
      kookrSessionId,
      sequence,
      source,
      ...(lagSample ? {
        lagMs: lagSample.lagMs,
        writeTimestampSource: lagSample.writeTimestampSource,
      } : {}),
      parentage: result.parentage ?? 'unknown',
      parseStatus: result.parseStatus,
      ...(result.rawHookEventName ? { rawHookEventName: result.rawHookEventName } : {}),
    });
    return { dispatched: result.parseStatus === 'ok', contentHash, eventId, origin, injectResult: result };
  }

  /**
   * Returns the in-memory counters published to {@link AgentState.activityMeta}.
   * Undefined when no events have been observed for this Kookr session.
   */
  getActivityMeta(kookrSessionId: string): AgentActivityMeta | undefined {
    const meta = this.metaByKookrSession.get(kookrSessionId);
    return meta ? { ...meta } : undefined;
  }

  getCoordinatorAuditTail(): CoordinatorAuditTailRow[] {
    if (this.coordinatorAuditTailProjectionCache) {
      return [...this.coordinatorAuditTailProjectionCache];
    }
    const rowsByKey = new Map<string, CoordinatorAuditTailRow>();
    for (const row of this.coordinatorAuditTail) rowsByKey.set(coordinatorAuditTailKey(row), row);
    for (const row of this.latestCoordinatorPostToolUseRows.values()) {
      rowsByKey.set(coordinatorAuditTailKey(row), row);
    }
    this.coordinatorAuditTailProjectionCache = Object.freeze(
      [...rowsByKey.values()].map(cloneAndFreezeCoordinatorAuditTailRow),
    );
    return [...this.coordinatorAuditTailProjectionCache];
  }

  getDiagnosticsSnapshot(): HookIngestionDiagnosticsSnapshot {
    const sessions = [...this.diagnosticsBySession.values()]
      .map(projectIngestionSessionDiagnostics)
      .sort((a, b) => a.kookrSessionId.localeCompare(b.kookrSessionId));
    return {
      schemaVersion: 'hook-ingestion-diagnostics.v1',
      generatedAt: new Date(this.now()).toISOString(),
      lagWarningThresholdMs: this.lagWarningThresholdMs,
      sessionCount: sessions.length,
      totalArrivals: sessions.reduce((sum, session) => sum + session.totalArrivals, 0),
      missingWriteTimestampCount: sessions.reduce((sum, session) => sum + session.missingWriteTimestampCount, 0),
      notableLagCount: sessions.reduce((sum, session) => sum + session.notableLagCount, 0),
      sessions,
    };
  }

  private appendCoordinatorAuditTail(row: CoordinatorAuditTailRow): void {
    if (isCoordinatorPostToolUseRow(row)) {
      const key = row.taskId ?? row.envelope?.taskId ?? row.envelope?.kookrSessionId;
      const observedAt = coordinatorRowObservedAt(row);
      if (key && observedAt) {
        const prior = this.latestCoordinatorPostToolUseRows.get(key);
        const priorObservedAt = prior ? coordinatorRowObservedAt(prior) : undefined;
        if (!priorObservedAt || observedAt > priorObservedAt) {
          this.latestCoordinatorPostToolUseRows.set(key, cloneCoordinatorAuditTailRow(row));
        }
      }
    }
    this.coordinatorAuditTail.push(row);
    if (this.coordinatorAuditTail.length > COORDINATOR_AUDIT_TAIL_LIMIT) {
      this.coordinatorAuditTail.splice(0, this.coordinatorAuditTail.length - COORDINATOR_AUDIT_TAIL_LIMIT);
    }
    this.invalidateCoordinatorAuditTailProjectionCache();
  }

  private invalidateCoordinatorAuditTailProjectionCache(): void {
    this.coordinatorAuditTailProjectionCache = undefined;
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
      this.appendCoordinatorAuditTail({
        ...(envelope.taskId ? { taskId: envelope.taskId } : {}),
        observedAt: envelope.observedAt,
        ...(envelope.rawHookEventName ? { rawHookEventName: envelope.rawHookEventName } : {}),
        envelope: {
          ...(envelope.taskId ? { taskId: envelope.taskId } : {}),
          kookrSessionId: envelope.kookrSessionId,
          observedAt: envelope.observedAt,
          ...(envelope.rawHookEventName ? { rawHookEventName: envelope.rawHookEventName } : {}),
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
    this.diagnosticsBySession.delete(kookrSessionId);
    this.sequenceCounters.delete(kookrSessionId);
    this.coordinatorAuditTail = this.coordinatorAuditTail.filter(
      (row) => row.envelope?.kookrSessionId !== kookrSessionId,
    );
    for (const [key, row] of [...this.latestCoordinatorPostToolUseRows]) {
      if (key === kookrSessionId || row.envelope?.kookrSessionId === kookrSessionId) {
        this.latestCoordinatorPostToolUseRows.delete(key);
      }
    }
    this.invalidateCoordinatorAuditTailProjectionCache();
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

  private recordLagSample(args: {
    kookrSessionId: string;
    raw: string;
    source: IngestInput['source'];
    processedAtMs: number;
    fileMtimeMs?: number;
    startupReplay: boolean;
  }): { lagMs: number; writeTimestampSource: HookWriteTimestampSource } | undefined {
    const diagnostics = this.getOrCreateDiagnostics(args.kookrSessionId);
    diagnostics.totalArrivals += 1;
    diagnostics.sourceCounts[args.source] += 1;
    diagnostics.lastProcessedAtMs = args.processedAtMs;
    if (args.startupReplay) {
      diagnostics.startupReplayArrivalCount += 1;
      diagnostics.overLagThreshold = false;
      return undefined;
    }

    const writeTimestamp = extractHookWriteTimestampMs(args.raw, args.fileMtimeMs);
    diagnostics.writeTimestampSourceCounts[writeTimestamp.source] += 1;
    diagnostics.lastWriteTimestampSource = writeTimestamp.source;

    if (writeTimestamp.source === 'missing') {
      diagnostics.missingWriteTimestampCount += 1;
      diagnostics.overLagThreshold = false;
      return undefined;
    }
    if (writeTimestamp.source === 'invalid') {
      diagnostics.invalidWriteTimestampCount += 1;
      diagnostics.overLagThreshold = false;
      return undefined;
    }

    diagnostics.lastWriteTimestampMs = writeTimestamp.ms;
    const rawLagMs = args.processedAtMs - writeTimestamp.ms;
    const lagMs = Math.max(0, Math.round(rawLagMs));
    if (rawLagMs < 0) diagnostics.futureWriteTimestampCount += 1;
    diagnostics.lastLagMs = lagMs;
    diagnostics.lagMaxMs = diagnostics.lagMaxMs === null ? lagMs : Math.max(diagnostics.lagMaxMs, lagMs);
    pushBounded(diagnostics.lagSamples, lagMs, LAG_SAMPLE_LIMIT);

    const overThreshold = lagMs > this.lagWarningThresholdMs;
    if (overThreshold) {
      diagnostics.notableLagCount += 1;
      if (!diagnostics.overLagThreshold) {
        console.warn('[hook-ingestion] lag threshold crossed', {
          kookrSessionId: args.kookrSessionId,
          source: args.source,
          lagMs,
          thresholdMs: this.lagWarningThresholdMs,
          writeTimestampSource: writeTimestamp.source,
        });
      }
    }
    diagnostics.overLagThreshold = overThreshold;
    return { lagMs, writeTimestampSource: writeTimestamp.source };
  }

  private markDiagnosticsArrival(
    kookrSessionId: string,
    args: { duplicate: boolean; dispatched: boolean },
  ): void {
    const diagnostics = this.getOrCreateDiagnostics(kookrSessionId);
    if (args.duplicate) diagnostics.duplicateArrivals += 1;
    if (args.dispatched) diagnostics.dispatchedArrivals += 1;
  }

  private getOrCreateDiagnostics(kookrSessionId: string): MutableHookIngestionSessionDiagnostics {
    const existing = this.diagnosticsBySession.get(kookrSessionId);
    if (existing) return existing;
    const created: MutableHookIngestionSessionDiagnostics = {
      kookrSessionId,
      totalArrivals: 0,
      dispatchedArrivals: 0,
      duplicateArrivals: 0,
      missingWriteTimestampCount: 0,
      invalidWriteTimestampCount: 0,
      futureWriteTimestampCount: 0,
      notableLagCount: 0,
      startupReplayArrivalCount: 0,
      lastProcessedAtMs: null,
      lastWriteTimestampMs: null,
      lastWriteTimestampSource: null,
      lastLagMs: null,
      lagMaxMs: null,
      lagSamples: [],
      sourceCounts: { file: 0, http: 0 },
      writeTimestampSourceCounts: { payload: 0, file_mtime: 0, missing: 0, invalid: 0 },
      overLagThreshold: false,
    };
    this.diagnosticsBySession.set(kookrSessionId, created);
    return created;
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

  private emitParseDegradation(args: {
    kookrSessionId: string;
    source: IngestInput['source'];
    eventId: string;
    sequence: number;
    result: InjectHookEventResult;
    raw: string;
    origin: EventOrigin;
    startupReplay: boolean;
  }): void {
    if (!this.onParseDegradation) return;
    if (args.origin !== 'live' || args.startupReplay) return;
    this.onParseDegradation({
      kookrSessionId: args.kookrSessionId,
      source: args.source,
      eventId: args.eventId,
      sequence: args.sequence,
      error: args.result.error ?? 'malformed hook payload',
      excerpt: malformedExcerpt(args.raw),
      observedAt: new Date(this.now()).toISOString(),
    });
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

function cloneCoordinatorAuditTailRow(row: CoordinatorAuditTailRow): CoordinatorAuditTailRow {
  const copy: CoordinatorAuditTailRow = { ...row };
  if (row.envelope) copy.envelope = { ...row.envelope };
  return copy;
}

function cloneAndFreezeCoordinatorAuditTailRow(row: CoordinatorAuditTailRow): CoordinatorAuditTailRow {
  const copy = cloneCoordinatorAuditTailRow(row);
  if (copy.envelope) copy.envelope = Object.freeze(copy.envelope) as CoordinatorAuditTailRow['envelope'];
  return Object.freeze(copy) as CoordinatorAuditTailRow;
}

function coordinatorAuditTailKey(row: CoordinatorAuditTailRow): string {
  return [
    row.taskId ?? '',
    row.envelope?.taskId ?? '',
    row.envelope?.kookrSessionId ?? '',
    row.rawHookEventName ?? row.envelope?.rawHookEventName ?? '',
    row.observedAt ?? row.envelope?.observedAt ?? row.timestamp ?? row.ts ?? '',
  ].join('\0');
}

function isCoordinatorPostToolUseRow(row: CoordinatorAuditTailRow): boolean {
  return row.rawHookEventName === 'PostToolUse'
    || row.envelope?.rawHookEventName === 'PostToolUse'
    || row.hook_event_name === 'PostToolUse'
    || row.event?.type === 'tool_result'
    || row.type === 'tool_result';
}

function coordinatorRowObservedAt(row: CoordinatorAuditTailRow): Date | undefined {
  return parseCoordinatorDate(row.observedAt)
    ?? parseCoordinatorDate(row.timestamp)
    ?? parseCoordinatorDate(row.ts)
    ?? parseCoordinatorDate(row.envelope?.observedAt);
}

function parseCoordinatorDate(value: string | number | Date | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
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

function malformedExcerpt(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function extractHookWriteTimestampMs(
  raw: string,
  fileMtimeMs: number | undefined,
): { source: HookWriteTimestampSource; ms: number } {
  const payloadTimestamp = extractPayloadTimestampMs(raw);
  if (payloadTimestamp) return payloadTimestamp;
  if (typeof fileMtimeMs === 'number' && Number.isFinite(fileMtimeMs)) {
    return { source: 'file_mtime', ms: fileMtimeMs };
  }
  return { source: 'missing', ms: 0 };
}

function extractPayloadTimestampMs(raw: string): { source: HookWriteTimestampSource; ms: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const record = parsed as Record<string, unknown>;
  const timestampValue = record.kookr_hook_written_at_ms
    ?? record.kookr_hook_written_at
    ?? record.kookrHookWrittenAt
    ?? record.written_at
    ?? record.writtenAt
    ?? record.timestamp
    ?? record.ts
    ?? record.created_at
    ?? record.createdAt;
  if (timestampValue === undefined || timestampValue === null) return undefined;
  const timestampMs = parseTimestampMs(timestampValue);
  return Number.isFinite(timestampMs)
    ? { source: 'payload', ms: timestampMs }
    : { source: 'invalid', ms: 0 };
}

function parseTimestampMs(value: unknown): number {
  if (typeof value === 'number') return value > 10_000_000_000 ? value : value * 1000;
  if (typeof value !== 'string') return Number.NaN;
  const trimmed = value.trim();
  if (!trimmed) return Number.NaN;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
  return Date.parse(trimmed);
}

function pushBounded(samples: number[], value: number, limit: number): void {
  samples.push(value);
  if (samples.length > limit) samples.splice(0, samples.length - limit);
}

function projectIngestionSessionDiagnostics(
  diagnostics: MutableHookIngestionSessionDiagnostics,
): HookIngestionSessionDiagnostics {
  const lagCount = diagnostics.lagSamples.length;
  const lagTotalMs = diagnostics.lagSamples.reduce((sum, value) => sum + value, 0);
  return {
    kookrSessionId: diagnostics.kookrSessionId,
    totalArrivals: diagnostics.totalArrivals,
    dispatchedArrivals: diagnostics.dispatchedArrivals,
    duplicateArrivals: diagnostics.duplicateArrivals,
    missingWriteTimestampCount: diagnostics.missingWriteTimestampCount,
    invalidWriteTimestampCount: diagnostics.invalidWriteTimestampCount,
    futureWriteTimestampCount: diagnostics.futureWriteTimestampCount,
    notableLagCount: diagnostics.notableLagCount,
    startupReplayArrivalCount: diagnostics.startupReplayArrivalCount,
    lastProcessedAt: isoOrNull(diagnostics.lastProcessedAtMs),
    lastWriteTimestampAt: isoOrNull(diagnostics.lastWriteTimestampMs),
    lastWriteTimestampSource: diagnostics.lastWriteTimestampSource,
    lag: {
      count: lagCount,
      lastMs: diagnostics.lastLagMs,
      meanMs: lagCount === 0 ? null : Math.round(lagTotalMs / lagCount),
      maxMs: diagnostics.lagMaxMs,
      p95Ms: percentile(diagnostics.lagSamples, 0.95),
    },
    sourceCounts: { ...diagnostics.sourceCounts },
    writeTimestampSourceCounts: { ...diagnostics.writeTimestampSourceCounts },
  };
}

function percentile(samples: number[], pct: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * pct) - 1);
  return sorted[index];
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}
