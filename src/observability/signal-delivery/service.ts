/**
 * SignalDeliveryService — the delivery bridge for operator signals (issue #1716).
 *
 * Tails the operator-signal outbox on a short interval and pushes newly-spooled
 * signals to the configured channels (Discord / Telegram). Each channel is its
 * own lane: it has its own batch, send spacing, back-off and delivered record,
 * so one channel's outage never holds back or loses the other's signals. The
 * guarantees that matter:
 *  - **At-least-once per channel, no duplicate re-post.** Each delivered
 *    occurrence is recorded in the persisted `.delivered.json` marker, so a
 *    daemon restart never re-posts an already-delivered occurrence — while a
 *    genuine re-emit (same key, fresh `createdAt`) does re-deliver. A plain
 *    `<file name> → createdAt` entry means every channel is done with that
 *    occurrence (maintenance-prune reads it). While only some channels have it,
 *    the marker holds `<channel>:<file name>` entries instead, and only the
 *    missing channels retry. A crash *between* a successful POST and the marker
 *    save can re-post that batch once on restart (an inherent outbox trade-off).
 *  - **≤1 message per minute per channel.** Every eligible tick drains *all*
 *    of a channel's pending signals into one batched message, and its sends are
 *    spaced by `minSendIntervalMs`.
 *  - **Telegram gets decisions only** (by default). Telegram takes just the
 *    signals an agent is waiting on the operator for (decision-signals.ts);
 *    Discord takes everything. A signal no configured channel takes is
 *    acknowledged without a send, so it never waits behind the throttle.
 *  - **Dry-run.** With `dryRun`, each batch is formatted and logged but never
 *    POSTed; entries are still marked delivered so the log does not loop.
 *
 * Failure back-off & health (issue #3046): when a channel rejects its batch,
 * the service no longer re-POSTs it every poll interval. Instead it spaces that
 * channel's next attempt with capped exponential back-off (honoring a 429
 * `Retry-After` as a lower bound); the channel's first success resets it.
 * {@link SignalDeliveryService.status} exposes a sync, secret-free health
 * snapshot (configured / consecutiveFailures / pending / last send / last
 * failure, the worst channel winning) so a silently-failing bridge is visible
 * on GET `/api/health`.
 */

import {
  deliverToDiscord,
  deliverToTelegram,
  type ChannelDeliveryResult,
  type ChannelName,
} from './channels.js';
import type { SignalDeliveryConfig } from './config.js';
import { sendsToTelegram } from './decision-signals.js';
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
  /** Signals at least one channel accepted this tick (another may still owe them). */
  delivered: string[];
  /**
   * Signals no configured channel takes (a status signal on a Telegram-only
   * install that gets decisions only). They are acknowledged without a send.
   * Absent when there were none.
   */
  withheld?: string[];
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
  /** Consecutive failures of the worst channel since its last success (0 when healthy). */
  consecutiveFailures: number;
  /** Readable signals pending as of the most recent tick; excludes unreadable files. */
  pending: number;
  /** File-read failures since this service started, including repeated failed reads. */
  scanFailures: number;
  /** Unreadable signal files in the latest completed scan, independent of channel health. */
  scanFailedFiles: number;
  /** ISO time of the latest per-file read failure; retained after recovery, or null. */
  lastScanFailureAt: string | null;
  /** Fixed summary, without paths or signal content; absent after a fault-free scan. */
  lastScanError?: string;
  /** ISO time of the last successful delivery, or null. */
  lastSendAt: string | null;
  /** ISO time of the last failed send on any channel, or null. */
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

/** One outbound channel with its own batch, spacing, back-off and delivered record. */
interface ChannelLane {
  readonly name: ChannelName;
  /** Whether this channel takes the signal at all (Telegram: decisions only, by default). */
  takes: (signal: OperatorSignal) => boolean;
  deliver: (text: string) => Promise<ChannelDeliveryResult>;
  lastSendAt: number | null;
  // Failure back-off state (issue #3046), per channel: after a failed send the
  // next attempt is spaced by capped exponential back-off (or an honored
  // Retry-After) instead of re-POSTing every poll; a success resets it.
  consecutiveFailures: number;
  lastFailureAt: number | null;
  lastError: string | null;
  nextAttemptAt: number | null;
}

/** Marker key recording that `channel` delivered `fileName` while another channel has not yet. */
function laneKey(channel: ChannelName, fileName: string): string {
  return `${channel}:${fileName}`;
}

export class SignalDeliveryService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastPending = 0;
  private scanFailures = 0;
  private scanFailedFiles = 0;
  private lastScanFailureAt: string | null = null;
  private readonly lanes: ChannelLane[];
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
    const fresh = { lastSendAt: null, consecutiveFailures: 0, lastFailureAt: null, lastError: null, nextAttemptAt: null };
    const { discord, telegram, telegramSignals } = this.config;
    this.lanes = [
      ...(discord
        ? [{
          name: 'discord' as const,
          takes: () => true,
          deliver: (text: string) => deliverToDiscord(discord, text, { fetchImpl: this.fetchImpl }),
          ...fresh,
        }]
        : []),
      ...(telegram
        ? [{
          name: 'telegram' as const,
          takes: (signal: OperatorSignal) => sendsToTelegram(signal, telegramSignals),
          deliver: (text: string) => deliverToTelegram(telegram, text, { fetchImpl: this.fetchImpl }),
          ...fresh,
        }]
        : []),
    ];
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
   * never scans the outbox — so GET `/api/health` can project it cheaply. With
   * two channels the worst one wins: the most consecutive failures, the latest
   * send and failure, every failing channel's error, the earliest retry.
   */
  status(): SignalDeliveryStatus {
    const nowMs = this.now().getTime();
    const latest = (values: Array<number | null>): number | null =>
      values.reduce<number | null>((max, v) => (v !== null && (max === null || v > max) ? v : max), null);
    const lastSendAt = latest(this.lanes.map((l) => l.lastSendAt));
    const lastFailureAt = latest(this.lanes.map((l) => l.lastFailureAt));
    const errors = this.lanes.filter((l) => l.lastError).map((l) => l.lastError as string);
    // Only surface nextAttemptAt while it is still in the future — a past value
    // no longer suppresses an attempt, so reporting it would misdescribe the
    // gate. consecutiveFailures remains the durable unhealthy signal.
    const suppressing = this.lanes
      .map((l) => l.nextAttemptAt)
      .filter((t): t is number => t !== null && t > nowMs);
    return {
      configured: this.lanes.length > 0,
      consecutiveFailures: Math.max(0, ...this.lanes.map((l) => l.consecutiveFailures)),
      pending: this.lastPending,
      scanFailures: this.scanFailures,
      scanFailedFiles: this.scanFailedFiles,
      lastScanFailureAt: this.lastScanFailureAt,
      ...(this.scanFailedFiles > 0 ? { lastScanError: 'Unable to read one or more signal files' } : {}),
      lastSendAt: lastSendAt !== null ? new Date(lastSendAt).toISOString() : null,
      lastFailureAt: lastFailureAt !== null ? new Date(lastFailureAt).toISOString() : null,
      ...(errors.length > 0 ? { lastError: errors.join(', ') } : {}),
      ...(suppressing.length > 0 ? { nextAttemptAt: new Date(Math.min(...suppressing)).toISOString() } : {}),
    };
  }

  private async runTick(): Promise<SignalDeliveryTickResult> {
    const files = await listSignalFiles(this.dir);
    const marker = await loadDeliveredMarker(this.dir);

    // A signal is undelivered when its CURRENT occurrence is not settled.
    // Dedup is keyed on (file name → delivered `createdAt`), not file name
    // alone: emitters reuse a stable key and OVERWRITE the file when the same
    // condition re-fires (a flapping alert, or the 6h liveness re-emit), which
    // stamps a fresh `createdAt`. Comparing `createdAt` lets that re-emit
    // re-deliver, while a restart with an unchanged file stays deduped. Invalid
    // / partially-written files read as null and are simply skipped this tick.
    const undelivered: Array<{ fileName: string; signal: OperatorSignal }> = [];
    let scanFailedFiles = 0;
    for (const fileName of files) {
      let signal: OperatorSignal | null;
      try {
        signal = await readSignal(this.dir, fileName);
      } catch {
        // Leave this entry unacknowledged for retry while healthy alerts proceed.
        // Directory listing and deduplication marker errors still reject the tick.
        scanFailedFiles += 1;
        continue;
      }
      if (!signal) continue;
      if (marker[fileName] === signal.createdAt) continue;
      undelivered.push({ fileName, signal });
    }

    this.scanFailedFiles = scanFailedFiles;
    this.scanFailures += scanFailedFiles;
    if (scanFailedFiles > 0) this.lastScanFailureAt = this.now().toISOString();

    const laneDone = (lane: ChannelLane, { fileName, signal }: { fileName: string; signal: OperatorSignal }): boolean =>
      !lane.takes(signal) || marker[laneKey(lane.name, fileName)] === signal.createdAt;
    let markerChanged = false;
    /** Settle every signal all channels are done with: one plain entry replaces the per-channel ones. */
    const settle = (): Array<{ fileName: string; signal: OperatorSignal }> => {
      const settled = undelivered.filter((p) => marker[p.fileName] !== p.signal.createdAt && this.lanes.every((l) => laneDone(l, p)));
      for (const { fileName, signal } of settled) {
        marker[fileName] = signal.createdAt;
        for (const lane of this.lanes) delete marker[laneKey(lane.name, fileName)];
        markerChanged = true;
      }
      return settled;
    };

    // A signal no channel takes is not waiting on any send: acknowledge it now,
    // before the back-off and throttle gates, so it never counts as pending and
    // a later switch to `all` does not replay it.
    const withheld = settle();
    if (withheld.length > 0) {
      this.log(
        `[signal-delivery] kept ${withheld.length} status signal(s) off Telegram `
          + `(it gets decisions only; KOOKR_SIGNAL_TELEGRAM_LEVEL=all sends everything): `
          + withheld.map((p) => p.signal.source).join(', '),
      );
    }

    const nowMs = this.now().getTime();
    const channelResults: ChannelDeliveryResult[] = [];
    const deliveredNow = new Set<string>();
    let throttled = false;
    let backoff = false;
    for (const lane of this.lanes) {
      const batch = undelivered.filter((p) => marker[p.fileName] !== p.signal.createdAt && !laneDone(lane, p));
      if (batch.length === 0) continue;
      // Failure back-off gate (issue #3046). While this channel's back-off
      // window is open its batch is NOT re-POSTed — this is what replaces the
      // every-poll retry storm against a failing endpoint. The other channel
      // is not held back.
      if (lane.nextAttemptAt !== null && nowMs < lane.nextAttemptAt) {
        backoff = true;
        continue;
      }
      if (lane.lastSendAt !== null && nowMs - lane.lastSendAt < this.config.minSendIntervalMs) {
        throttled = true;
        continue;
      }
      const message = formatBatch(batch.map((p) => p.signal));
      let result: ChannelDeliveryResult | null = null;
      if (this.config.dryRun) {
        this.log(`[signal-delivery] DRY-RUN would deliver to ${lane.name}:\n${message}`);
      } else {
        result = await lane.deliver(message);
        channelResults.push(result);
      }
      if (result && !result.ok) {
        this.registerFailure(lane, nowMs, result);
        const waitMs = lane.nextAttemptAt !== null ? Math.max(0, lane.nextAttemptAt - nowMs) : 0;
        this.log(
          `[signal-delivery] ${lane.name} failed (${lane.lastError}); ${batch.length} signal(s) stay pending for it, `
            + `backing off ${Math.round(waitMs / 1000)}s (failure #${lane.consecutiveFailures})`,
        );
        continue;
      }
      // Success: clear this channel's back-off immediately so recovery is never delayed.
      lane.consecutiveFailures = 0;
      lane.lastError = null;
      lane.nextAttemptAt = null;
      lane.lastSendAt = nowMs;
      for (const { fileName, signal } of batch) {
        marker[laneKey(lane.name, fileName)] = signal.createdAt;
        deliveredNow.add(fileName);
      }
      markerChanged = true;
      this.log(`[signal-delivery] delivered ${batch.length} signal(s) via ${this.config.dryRun ? 'dry-run ' : ''}${lane.name}`);
    }

    settle();
    if (markerChanged) await saveDeliveredMarker(this.dir, marker);

    const pending = undelivered.filter((p) => marker[p.fileName] !== p.signal.createdAt).length;
    this.lastPending = pending;
    return {
      pending,
      throttled,
      backoff,
      delivered: undelivered.filter((p) => deliveredNow.has(p.fileName)).map((p) => p.fileName),
      ...(withheld.length > 0 ? { withheld: withheld.map((p) => p.fileName) } : {}),
      channelResults,
    };
  }

  /**
   * Record a failed send on `lane` and schedule its next attempt (issue #3046).
   * Spacing is capped exponential back-off from the base window, doubling per
   * consecutive failure; a `Retry-After` from a 429 raises it (as a lower bound)
   * but is itself capped so a hostile value cannot stall recovery indefinitely.
   */
  private registerFailure(lane: ChannelLane, nowMs: number, result: ChannelDeliveryResult): void {
    lane.consecutiveFailures += 1;
    lane.lastFailureAt = nowMs;
    lane.lastError = `${lane.name}:${result.error ?? 'fail'}`;

    const exponent = lane.consecutiveFailures - 1;
    // Cap the exponent before shifting so 2 ** exponent cannot overflow to Infinity.
    const cappedExponent = Math.min(exponent, 30);
    const backoffMs = Math.min(
      this.config.backoffBaseMs * 2 ** cappedExponent,
      this.config.backoffMaxMs,
    );
    const retryAfterMs = typeof result.retryAfterMs === 'number' ? result.retryAfterMs : 0;
    const waitMs = Math.max(backoffMs, Math.min(retryAfterMs, this.config.backoffMaxMs));
    lane.nextAttemptAt = nowMs + waitMs;
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
