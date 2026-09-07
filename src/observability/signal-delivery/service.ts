/**
 * SignalDeliveryService — the delivery bridge for operator signals (issue #1716).
 *
 * Tails the operator-signal outbox on a short interval and pushes newly-spooled
 * signals to the configured channels (Discord / Telegram). The guarantees that
 * matter:
 *  - **At-least-once, no duplicate re-post.** Each delivered occurrence is
 *    recorded in the persisted `.delivered.json` marker (file name → the
 *    delivered signal's `createdAt`), so a daemon restart never re-posts an
 *    already-delivered occurrence — while a genuine re-emit (same key, fresh
 *    `createdAt`) does re-deliver. The one exception to no-duplicate is a crash
 *    *between* a successful POST and the marker save, which can re-post that
 *    batch once on restart (an inherent outbox trade-off).
 *  - **≤1 message per minute.** Every eligible tick drains *all* pending signals
 *    into a single batched message, and outbound sends are spaced by
 *    `minSendIntervalMs`.
 *  - **Dry-run.** With `dryRun`, the batch is formatted and logged but never
 *    POSTed; entries are still marked delivered so the log does not loop.
 *
 * Partial-failure policy: a batch is marked delivered when *at least one*
 * channel accepts it. This trades a possible single-channel miss (logged) for a
 * hard no-duplicate-repost guarantee, which is the property the incident that
 * motivated this issue actually needed.
 *
 * Failure back-off & health (issue #3046): when *every* channel rejects a batch,
 * the service no longer re-POSTs it every poll interval. Instead it spaces the
 * next attempt with capped exponential back-off (honoring a 429 `Retry-After` as
 * a lower bound); the first success resets the counter and resumes normal
 * cadence. {@link SignalDeliveryService.status} exposes a sync, secret-free
 * health snapshot (configured / consecutiveFailures / pending / last send /
 * last failure) so a silently-failing bridge is visible on GET `/api/health`.
 */

import {
  deliverToDiscord,
  deliverToTelegram,
  type ChannelDeliveryResult,
} from './channels.js';
import type { SignalDeliveryConfig } from './config.js';
import {
  loadDeliveredMarker,
  listSignalFiles,
  readSignal,
  saveDeliveredMarker,
  type OperatorSignal,
  type OperatorSignalKind,
} from './operator-signal.js';

export interface SignalDeliveryServiceOptions {
  dir: string;
  config: SignalDeliveryConfig;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface SignalDeliveryTickResult {
  pending: number;
  /** True when the min-send interval gated this tick (signals left pending). */
  throttled: boolean;
  /**
   * True when a failure back-off window gated this tick (issue #3046). Distinct
   * from `throttled`: the batch is not re-POSTed while the bridge is failing, so
   * a revoked webhook / 429 / network fault no longer produces a retry storm.
   */
  backoff: boolean;
  delivered: string[];
  channelResults: ChannelDeliveryResult[];
}

/**
 * Delivery-bridge health snapshot (issue #3046). Sync + secret-free so it can be
 * projected null-safely onto GET `/api/health`, mirroring the sibling sink
 * pattern in {@link file://../../server/operational-alert-sink.ts}. Timestamps
 * are ISO strings (null when the event never happened); counts are plain.
 */
export interface SignalDeliveryStatus {
  /** True when at least one channel (Discord / Telegram) is configured. */
  configured: boolean;
  /** Consecutive all-channel failures since the last success (0 when healthy). */
  consecutiveFailures: number;
  /** Signals pending as of the most recent tick (in-memory; no dir re-scan). */
  pending: number;
  /** ISO time of the last successful delivery, or null. */
  lastSendAt: string | null;
  /** ISO time of the last all-channel failure, or null. */
  lastFailureAt: string | null;
  /** Last failure summary (channel:error, …). Absent when healthy. */
  lastError?: string;
  /** ISO time before which the back-off gate suppresses the next attempt. Absent when healthy. */
  nextAttemptAt?: string;
}

const KIND_EMOJI: Record<OperatorSignalKind, string> = {
  alert: '🚨',
  clear: '✅',
  info: 'ℹ️',
};

export class SignalDeliveryService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastSendAt: number | null = null;
  // Failure back-off state (issue #3046). On an all-channel failure the next
  // attempt is spaced by capped exponential back-off (or an honored Retry-After)
  // instead of re-POSTing every poll; a single success resets all of it.
  private consecutiveFailures = 0;
  private lastFailureAt: number | null = null;
  private lastError: string | null = null;
  private nextAttemptAt: number | null = null;
  private lastPending = 0;
  private readonly dir: string;
  private readonly config: SignalDeliveryConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;

  constructor(opts: SignalDeliveryServiceOptions) {
    this.dir = opts.dir;
    this.config = opts.config;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((msg) => console.log(msg));
  }

  start(): void {
    if (this.timer) return;
    const channels = [
      this.config.discord ? 'discord' : null,
      this.config.telegram ? 'telegram' : null,
    ].filter(Boolean).join('+');
    this.log(
      `[signal-delivery] started (interval=${this.config.pollIntervalMs}ms, channels=${channels}, `
        + `dryRun=${this.config.dryRun}, dir=${this.dir})`,
    );
    this.bootTimer = setTimeout(() => {
      void this.tick().catch((err) => this.logErr('initial tick', err));
    }, this.config.bootDelayMs);
    this.unref(this.bootTimer);
    this.timer = setInterval(() => {
      void this.tick().catch((err) => this.logErr('tick', err));
    }, this.config.pollIntervalMs);
    this.unref(this.timer);
  }

  stop(): void {
    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<SignalDeliveryTickResult> {
    if (this.running) {
      return { pending: 0, throttled: false, backoff: false, delivered: [], channelResults: [] };
    }
    this.running = true;
    try {
      return await this.runTick();
    } finally {
      this.running = false;
    }
  }

  /**
   * Delivery-bridge health snapshot (issue #3046). Sync in-memory read only —
   * never scans the outbox — so GET `/api/health` can project it cheaply.
   */
  status(): SignalDeliveryStatus {
    // Only surface nextAttemptAt while it is still in the future — a past value
    // no longer suppresses an attempt, so reporting it would misdescribe the
    // gate. consecutiveFailures remains the durable unhealthy signal.
    const isSuppressing =
      this.nextAttemptAt !== null && this.nextAttemptAt > this.now().getTime();
    return {
      configured: Boolean(this.config.discord || this.config.telegram),
      consecutiveFailures: this.consecutiveFailures,
      pending: this.lastPending,
      lastSendAt: this.lastSendAt !== null ? new Date(this.lastSendAt).toISOString() : null,
      lastFailureAt: this.lastFailureAt !== null ? new Date(this.lastFailureAt).toISOString() : null,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(isSuppressing ? { nextAttemptAt: new Date(this.nextAttemptAt as number).toISOString() } : {}),
    };
  }

  private async runTick(): Promise<SignalDeliveryTickResult> {
    const files = await listSignalFiles(this.dir);
    const delivered = await loadDeliveredMarker(this.dir);

    // A signal is pending when its CURRENT occurrence has not been delivered.
    // Dedup is keyed on (file name → delivered `createdAt`), not file name
    // alone: emitters reuse a stable key and OVERWRITE the file when the same
    // condition re-fires (a flapping alert, or the 6h liveness re-emit), which
    // stamps a fresh `createdAt`. Comparing `createdAt` lets that re-emit
    // re-deliver, while a restart with an unchanged file stays deduped. Invalid
    // / partially-written files read as null and are simply skipped this tick.
    const pending: Array<{ fileName: string; signal: OperatorSignal }> = [];
    for (const fileName of files) {
      const signal = await readSignal(this.dir, fileName);
      if (!signal) continue;
      if (delivered[fileName] === signal.createdAt) continue;
      pending.push({ fileName, signal });
    }

    this.lastPending = pending.length;

    if (pending.length === 0) {
      return { pending: 0, throttled: false, backoff: false, delivered: [], channelResults: [] };
    }

    const nowMs = this.now().getTime();

    // Failure back-off gate (issue #3046). While a back-off window is open the
    // batch is NOT re-POSTed — this is what replaces the every-poll retry storm
    // against a failing endpoint. Signals stay pending; the window is cleared by
    // the first success.
    if (this.nextAttemptAt !== null && nowMs < this.nextAttemptAt) {
      return { pending: pending.length, throttled: false, backoff: true, delivered: [], channelResults: [] };
    }

    if (this.lastSendAt !== null && nowMs - this.lastSendAt < this.config.minSendIntervalMs) {
      return { pending: pending.length, throttled: true, backoff: false, delivered: [], channelResults: [] };
    }

    const message = formatBatch(pending.map((s) => s.signal));
    const channelResults = await this.send(message);
    const anySuccess = this.config.dryRun || channelResults.some((r) => r.ok);

    if (!anySuccess) {
      const errs = channelResults.map((r) => `${r.channel}:${r.error ?? 'fail'}`).join(', ');
      this.registerFailure(nowMs, errs, channelResults);
      const waitMs = this.nextAttemptAt !== null ? Math.max(0, this.nextAttemptAt - nowMs) : 0;
      this.log(
        `[signal-delivery] all channels failed (${errs}); ${pending.length} signal(s) stay pending, `
          + `backing off ${Math.round(waitMs / 1000)}s (failure #${this.consecutiveFailures})`,
      );
      return { pending: pending.length, throttled: false, backoff: false, delivered: [], channelResults };
    }

    // Success: clear any back-off immediately so recovery is never delayed.
    this.consecutiveFailures = 0;
    this.lastError = null;
    this.nextAttemptAt = null;
    this.lastSendAt = nowMs;
    this.lastPending = 0;
    const deliveredNames: string[] = [];
    for (const { fileName, signal } of pending) {
      delivered[fileName] = signal.createdAt;
      deliveredNames.push(fileName);
    }
    await saveDeliveredMarker(this.dir, delivered);

    const failed = channelResults.filter((r) => !r.ok);
    const okChannels = channelResults.filter((r) => r.ok).map((r) => r.channel).join('+') || (this.config.dryRun ? 'dry-run' : 'none');
    this.log(
      `[signal-delivery] delivered ${pending.length} signal(s) via ${okChannels}`
        + (failed.length ? ` (failed: ${failed.map((r) => `${r.channel}:${r.error ?? 'fail'}`).join(', ')})` : ''),
    );

    return { pending: 0, throttled: false, backoff: false, delivered: deliveredNames, channelResults };
  }

  /**
   * Record an all-channel failure and schedule the next attempt (issue #3046).
   * Spacing is capped exponential back-off from the base window, doubling per
   * consecutive failure; a `Retry-After` from a 429 raises it (as a lower bound)
   * but is itself capped so a hostile value cannot stall recovery indefinitely.
   */
  private registerFailure(nowMs: number, errs: string, results: readonly ChannelDeliveryResult[]): void {
    this.consecutiveFailures += 1;
    this.lastFailureAt = nowMs;
    this.lastError = errs;

    const exponent = this.consecutiveFailures - 1;
    // Cap the exponent before shifting so 2 ** exponent cannot overflow to Infinity.
    const cappedExponent = Math.min(exponent, 30);
    const backoffMs = Math.min(
      this.config.backoffBaseMs * 2 ** cappedExponent,
      this.config.backoffMaxMs,
    );
    const retryAfterMs = results.reduce<number>(
      (max, r) => (typeof r.retryAfterMs === 'number' ? Math.max(max, r.retryAfterMs) : max),
      0,
    );
    const waitMs = Math.max(backoffMs, Math.min(retryAfterMs, this.config.backoffMaxMs));
    this.nextAttemptAt = nowMs + waitMs;
  }

  private async send(message: string): Promise<ChannelDeliveryResult[]> {
    if (this.config.dryRun) {
      this.log(`[signal-delivery] DRY-RUN would deliver:\n${message}`);
      return [];
    }
    const jobs: Array<Promise<ChannelDeliveryResult>> = [];
    if (this.config.discord) {
      jobs.push(deliverToDiscord(this.config.discord, message, { fetchImpl: this.fetchImpl }));
    }
    if (this.config.telegram) {
      jobs.push(deliverToTelegram(this.config.telegram, message, { fetchImpl: this.fetchImpl }));
    }
    return Promise.all(jobs);
  }

  private unref(timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>): void {
    if (typeof timer === 'object' && timer && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
  }

  private logErr(where: string, err: unknown): void {
    this.log(`[signal-delivery] ${where} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Format a batch of signals into one channel message. Exported for tests. */
export function formatBatch(signals: readonly OperatorSignal[]): string {
  const header = signals.length === 1
    ? 'kookr signal'
    : `kookr signals (${signals.length})`;
  const lines = signals.map((s) => {
    const emoji = KIND_EMOJI[s.kind] ?? 'ℹ️';
    const head = `${emoji} [${s.source}] ${s.title}`;
    return s.detail ? `${head}\n    ${s.detail.replace(/\n/g, '\n    ')}` : head;
  });
  return `${header}\n${lines.join('\n')}`;
}
