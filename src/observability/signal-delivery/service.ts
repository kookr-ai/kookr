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
  delivered: string[];
  channelResults: ChannelDeliveryResult[];
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
      return { pending: 0, throttled: false, delivered: [], channelResults: [] };
    }
    this.running = true;
    try {
      return await this.runTick();
    } finally {
      this.running = false;
    }
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

    if (pending.length === 0) {
      return { pending: 0, throttled: false, delivered: [], channelResults: [] };
    }

    const nowMs = this.now().getTime();
    if (this.lastSendAt !== null && nowMs - this.lastSendAt < this.config.minSendIntervalMs) {
      return { pending: pending.length, throttled: true, delivered: [], channelResults: [] };
    }

    const message = formatBatch(pending.map((s) => s.signal));
    const channelResults = await this.send(message);
    const anySuccess = this.config.dryRun || channelResults.some((r) => r.ok);

    if (!anySuccess) {
      const errs = channelResults.map((r) => `${r.channel}:${r.error ?? 'fail'}`).join(', ');
      this.log(`[signal-delivery] all channels failed (${errs}); ${pending.length} signal(s) stay pending`);
      return { pending: pending.length, throttled: false, delivered: [], channelResults };
    }

    this.lastSendAt = nowMs;
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

    return { pending: 0, throttled: false, delivered: deliveredNames, channelResults };
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
