const DEFAULT_MAX_SAMPLES = 512;

export interface TerminalInputRttMetricsOptions {
  /** Ring-buffer capacity. Fixed so per-keystroke recording never grows unbounded. */
  maxSamples?: number;
  /** Injectable monotonic clock (ms). Defaults to performance.now(). */
  nowMs?: () => number;
}

export interface TerminalInputRttMetricsSnapshot {
  schemaVersion: 'terminal-input-rtt-metrics.v1';
  /** Ring-buffer capacity. */
  maxSamples: number;
  /** Total observations recorded since process start (monotonic). */
  count: number;
  /** Number of samples retained in the ring buffer (≤ maxSamples). */
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

/**
 * Bounded ring-buffer histogram for terminal-input write round-trip latency
 * (issue #1773). Measures keystroke-enqueue → backend write-ack so operators
 * can see the p50/p95/p99 typing lag users actually feel.
 *
 * Deliberately allocation-light on the hot path: `record` pushes a single
 * number into a fixed-size array and never builds strings, so it is safe to
 * call per keystroke. Percentiles are computed lazily in `snapshot()`.
 */
export class TerminalInputRttMetrics {
  private readonly maxSamples: number;
  private readonly nowMs: () => number;
  private readonly samples: number[] = [];
  private count = 0;
  private nextIndex = 0;

  constructor(options: TerminalInputRttMetricsOptions = {}) {
    this.maxSamples = positiveInteger(options.maxSamples, DEFAULT_MAX_SAMPLES);
    this.nowMs = options.nowMs ?? (() => performance.now());
  }

  now(): number {
    return this.nowMs();
  }

  record(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    this.count += 1;
    if (this.samples.length < this.maxSamples) {
      this.samples.push(durationMs);
      return;
    }
    this.samples[this.nextIndex] = durationMs;
    this.nextIndex = (this.nextIndex + 1) % this.maxSamples;
  }

  snapshot(): TerminalInputRttMetricsSnapshot {
    const sorted = [...this.samples].sort((a, b) => a - b);
    return {
      schemaVersion: 'terminal-input-rtt-metrics.v1',
      maxSamples: this.maxSamples,
      count: this.count,
      sampleCount: sorted.length,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
    };
  }
}

export const EMPTY_TERMINAL_INPUT_RTT_SNAPSHOT: TerminalInputRttMetricsSnapshot = {
  schemaVersion: 'terminal-input-rtt-metrics.v1',
  maxSamples: 0,
  count: 0,
  sampleCount: 0,
  p50Ms: 0,
  p95Ms: 0,
  p99Ms: 0,
};

function percentile(sortedSamples: number[], percentileRank: number): number {
  if (sortedSamples.length === 0) return 0;
  const index = Math.min(
    sortedSamples.length - 1,
    Math.max(0, Math.ceil((percentileRank / 100) * sortedSamples.length) - 1),
  );
  return roundMs(sortedSamples[index]);
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}
