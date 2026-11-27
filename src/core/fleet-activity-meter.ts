/**
 * Pure rate meters behind the dashboard's fleet vitals: how many tool calls
 * agents make per minute and how many tokens they read and generate per second.
 *
 * Both meters work on a sliding time window, hold only what is inside that
 * window, and take the current time as an argument, so tests drive them with a
 * fake clock.
 */

/** Window over which token rates are averaged. Token counts arrive in bursts (one
 * transcript scan every few seconds, a whole reply at once), so a shorter window
 * makes the rate jump between zero and a spike. */
export const TOKEN_RATE_WINDOW_MS = 30_000;
/** Window over which tool calls are counted. */
export const TOOL_CALL_WINDOW_MS = 60_000;

const TOOL_CALL_BUCKET_MS = 1_000;

/**
 * Counts events in the trailing window, in one-second buckets: memory is bounded
 * by the window length whatever the event rate.
 */
export class SlidingEventCounter {
  private readonly windowMs: number;
  /** Bucket start (ms) -> events in that bucket, in insertion (time) order. */
  private readonly buckets = new Map<number, number>();
  private firstEventAtMs: number | null = null;

  constructor(windowMs: number = TOOL_CALL_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  record(nowMs: number, count: number = 1): void {
    if (this.firstEventAtMs === null) this.firstEventAtMs = nowMs;
    const bucket = Math.floor(nowMs / TOOL_CALL_BUCKET_MS) * TOOL_CALL_BUCKET_MS;
    this.buckets.set(bucket, (this.buckets.get(bucket) ?? 0) + count);
    this.prune(nowMs);
  }

  /** Events in the trailing window ending at `nowMs`. */
  count(nowMs: number): number {
    this.prune(nowMs);
    let total = 0;
    for (const value of this.buckets.values()) total += value;
    return total;
  }

  private prune(nowMs: number): void {
    const oldestKept = nowMs - this.windowMs;
    for (const bucket of this.buckets.keys()) {
      // Buckets are inserted in time order, so the first one still inside the
      // window ends the scan. A bucket is dropped only once it lies wholly
      // outside the window.
      if (bucket + TOOL_CALL_BUCKET_MS > oldestKept) break;
      this.buckets.delete(bucket);
    }
  }
}

/** Cumulative token counts for one task, as the token tracker reports them. */
export interface TokenTotals {
  /** Input tokens that were neither read from nor written to the prompt cache. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** Tokens per second, averaged over the trailing window. */
export interface TokenRates {
  /** Output tokens: what the models wrote. */
  generatedPerSec: number;
  /** Everything the models were sent: fresh input + cache writes + cache reads. */
  readPerSec: number;
  /** The part of `readPerSec` served from the prompt cache. */
  cacheReadPerSec: number;
}

interface TokenDelta {
  atMs: number;
  generated: number;
  read: number;
  cacheRead: number;
}

/**
 * Turns per-task cumulative token counts into fleet-wide rates.
 *
 * Each `observe` call receives the current totals of every tracked task. The
 * meter adds up how much each task grew since its previous observation and
 * averages that growth over the trailing window.
 *
 * - A task seen for the first time only sets its baseline. Its existing total is
 *   history (a resumed transcript can hold millions of tokens), not throughput.
 * - A task whose total went down (its transcripts were dropped and registered
 *   again) is given a new baseline and contributes nothing for that observation.
 * - A task missing from an observation is forgotten, so a finished task leaves
 *   no entry behind.
 */
export class TokenRateMeter {
  private readonly windowMs: number;
  private readonly baselines = new Map<string, TokenTotals>();
  private deltas: TokenDelta[] = [];
  private firstObservedAtMs: number | null = null;

  constructor(windowMs: number = TOKEN_RATE_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  observe(totalsByTask: ReadonlyMap<string, TokenTotals>, nowMs: number): void {
    if (this.firstObservedAtMs === null) this.firstObservedAtMs = nowMs;
    let generated = 0;
    let read = 0;
    let cacheRead = 0;
    for (const [taskId, totals] of totalsByTask) {
      const previous = this.baselines.get(taskId);
      this.baselines.set(taskId, { ...totals });
      if (!previous) continue;
      const dOut = totals.outputTokens - previous.outputTokens;
      const dIn = totals.inputTokens - previous.inputTokens;
      const dCacheRead = totals.cacheReadTokens - previous.cacheReadTokens;
      const dCacheWrite = totals.cacheWriteTokens - previous.cacheWriteTokens;
      if (dOut < 0 || dIn < 0 || dCacheRead < 0 || dCacheWrite < 0) continue;
      generated += dOut;
      read += dIn + dCacheRead + dCacheWrite;
      cacheRead += dCacheRead;
    }
    for (const taskId of this.baselines.keys()) {
      if (!totalsByTask.has(taskId)) this.baselines.delete(taskId);
    }
    if (generated > 0 || read > 0) {
      this.deltas.push({ atMs: nowMs, generated, read, cacheRead });
    }
    this.prune(nowMs);
  }

  /**
   * Rates over the trailing window ending at `nowMs`, or `null` until the meter
   * has watched for at least one observation interval (nothing to divide by yet).
   */
  rates(nowMs: number): TokenRates | null {
    if (this.firstObservedAtMs === null) return null;
    this.prune(nowMs);
    // Until a full window has elapsed, divide by the time actually watched, so
    // the first seconds after a restart are not under-reported.
    const spanMs = Math.min(this.windowMs, nowMs - this.firstObservedAtMs);
    if (spanMs <= 0) return null;
    let generated = 0;
    let read = 0;
    let cacheRead = 0;
    for (const delta of this.deltas) {
      generated += delta.generated;
      read += delta.read;
      cacheRead += delta.cacheRead;
    }
    const seconds = spanMs / 1000;
    return {
      generatedPerSec: generated / seconds,
      readPerSec: read / seconds,
      cacheReadPerSec: cacheRead / seconds,
    };
  }

  private prune(nowMs: number): void {
    const oldestKept = nowMs - this.windowMs;
    if (this.deltas.length > 0 && this.deltas[0].atMs <= oldestKept) {
      this.deltas = this.deltas.filter((delta) => delta.atMs > oldestKept);
    }
  }
}
