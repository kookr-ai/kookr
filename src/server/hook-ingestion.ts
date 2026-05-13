import { createHash } from 'node:crypto';
import type { HttpPushTracker } from '../core/http-push-tracker.js';

/**
 * Narrow surface the {@link HookIngestion} service needs from an adapter.
 * Decouples the watcher and HTTP route from the full {@link AgentAdapter}
 * interface so ingestion can be tested in isolation with a 1-method stub.
 */
export interface HookEventInjector {
  injectHookEvent(tmuxName: string, rawJson: string): void;
}

export interface HookIngestionDeps {
  adapter: HookEventInjector;
  httpPushTracker?: HttpPushTracker;
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
export class HookIngestion implements HookEventInjector {
  private cache = new Map<string, number>();
  private adapter: HookEventInjector;
  private httpPushTracker?: HttpPushTracker;
  private dedupTtlMs: number;
  private now: () => number;

  constructor(deps: HookIngestionDeps) {
    this.adapter = deps.adapter;
    this.httpPushTracker = deps.httpPushTracker;
    this.dedupTtlMs = deps.dedupTtlMs ?? 5000;
    this.now = deps.now ?? Date.now;
  }

  /** HookFileWatcher-compatible alias. Treats the call as file-source. */
  injectHookEvent(tmuxName: string, rawJson: string): void {
    this.ingest({ kookrSessionId: tmuxName, raw: rawJson, source: 'file' });
  }

  /** HTTP /api/hook-event/:sessionId entry point. */
  ingestFromHttp(sessionId: string, body: string): IngestResult {
    return this.ingest({ kookrSessionId: sessionId, raw: body, source: 'http' });
  }

  ingest({ kookrSessionId, raw, source }: IngestInput): IngestResult {
    const normalized = raw.trim();
    const contentHash = createHash('sha256').update(normalized).digest('hex');
    if (!normalized) return { dispatched: false, reason: 'empty', contentHash };

    const key = `${kookrSessionId}::${contentHash}`;
    const now = this.now();
    this.gcExpired(now);

    const httpTrackerCall = () => {
      if (source === 'http' && this.httpPushTracker) {
        this.httpPushTracker.recordHttpArrival(kookrSessionId, raw);
      }
    };

    if (this.cache.has(key)) {
      // The other source already delivered this record. Note the arrival for
      // latency telemetry but do not re-inject.
      httpTrackerCall();
      return { dispatched: false, reason: 'duplicate', contentHash };
    }

    this.cache.set(key, now);
    httpTrackerCall();

    try {
      this.adapter.injectHookEvent(kookrSessionId, normalized);
    } catch (err) {
      // Allow a retry from the other source on transient failures.
      this.cache.delete(key);
      throw err;
    }
    return { dispatched: true, contentHash };
  }

  private gcExpired(now: number): void {
    const threshold = now - this.dedupTtlMs;
    for (const [key, ts] of this.cache) {
      if (ts < threshold) this.cache.delete(key);
    }
  }
}
