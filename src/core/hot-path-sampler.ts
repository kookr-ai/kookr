import { performance } from 'node:perf_hooks';

/**
 * Route serving {@link HotPathSampler.snapshot}. Kept here so the diagnostics
 * route module and any client share one source of truth.
 */
export const HOT_PATHS_ROUTE = '/api/diagnostics/hot-paths';

export const HOT_PATH_SAMPLER_SCHEMA_VERSION = 'hot-path-sampler.v1';

/** Default recent-window pair (minutes) surfaced by a snapshot. */
export const DEFAULT_HOT_PATH_WINDOWS_MINUTES = [5, 15] as const;
/** Ring capacity (total labeled timings retained across all labels). */
const DEFAULT_HOT_PATH_CAPACITY = 8_192;
/** Cardinality cap: a typo'd or attacker-supplied label can't explode memory. */
const DEFAULT_HOT_PATH_MAX_LABELS = 64;
/** Default number of top contributors reported per window. */
const DEFAULT_HOT_PATH_TOP_K = 10;
const MS_PER_MINUTE = 60_000;

export interface HotPathSamplerOptions {
  /** Total labeled timings retained in the ring (oldest overwritten). */
  capacity?: number;
  /** Maximum distinct labels; records for a new label past this are dropped. */
  maxLabels?: number;
  /** Recent windows, in minutes, reported by {@link HotPathSampler.snapshot}. */
  windowsMinutes?: readonly number[];
  /** Top-K contributors reported per window. */
  topK?: number;
  /** Monotonic clock in ms. Defaults to `performance.now`. Injected in tests. */
  nowMs?: () => number;
  /** Wall-clock ISO stamp for `generatedAt`. Injected in tests. */
  nowIso?: () => string;
}

export interface HotPathEntry {
  label: string;
  /** Number of timings recorded for this label within the window. */
  count: number;
  /** Sum of durations (ms) — the ranking key ("what burned the loop"). */
  totalMs: number;
  meanMs: number;
  p95Ms: number;
  maxMs: number;
}

export interface HotPathWindowMetric {
  windowMinutes: number;
  windowMs: number;
  /** Total timings across all labels within the window. */
  sampleCount: number;
  /** Top-K labels by `totalMs`, descending. */
  paths: HotPathEntry[];
}

export interface HotPathSnapshot {
  schemaVersion: typeof HOT_PATH_SAMPLER_SCHEMA_VERSION;
  generatedAt: string;
  /** Ring capacity (total retained timings). */
  capacity: number;
  /** Timings currently retained in the ring. */
  retainedCount: number;
  /** Distinct labels currently tracked. */
  labelCount: number;
  /** Records dropped because the label cap was already reached. */
  droppedLabelCount: number;
  topK: number;
  windows: HotPathWindowMetric[];
}

export interface HotPathSnapshotOverrides {
  windowsMinutes?: readonly number[];
  topK?: number;
}

/**
 * Bounded, allocation-free ring of labeled timings around known heavy functions
 * (snapshot rebuild, task save, VT reconstruct, hook parse, …). A snapshot ranks
 * the top contributors by total time burned over the last N minutes so, after a
 * lag/OOM incident, an operator has a ranked list instead of a forensic log dive
 * (issue #1781).
 *
 * Recording is O(1) with no per-call allocation (parallel typed arrays written
 * in place), so instrumentation is cheap enough to leave on. Aggregation cost is
 * paid only when a diagnostics request calls {@link snapshot}.
 */
export class HotPathSampler {
  private readonly capacity: number;
  private readonly maxLabels: number;
  private readonly defaultWindowsMinutes: readonly number[];
  private readonly defaultTopK: number;
  private readonly nowMs: () => number;
  private readonly nowIso: () => string;

  private readonly labelSlots: (string | undefined)[];
  private readonly durations: Float64Array;
  private readonly stamps: Float64Array;
  private readonly knownLabels = new Set<string>();
  private writeIndex = 0;
  private size = 0;
  private droppedLabelCount = 0;

  constructor(options: HotPathSamplerOptions = {}) {
    this.capacity = positiveInteger(options.capacity, DEFAULT_HOT_PATH_CAPACITY);
    this.maxLabels = positiveInteger(options.maxLabels, DEFAULT_HOT_PATH_MAX_LABELS);
    this.defaultWindowsMinutes = normalizeWindows(options.windowsMinutes) ?? DEFAULT_HOT_PATH_WINDOWS_MINUTES;
    this.defaultTopK = positiveInteger(options.topK, DEFAULT_HOT_PATH_TOP_K);
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.labelSlots = new Array<string | undefined>(this.capacity).fill(undefined);
    this.durations = new Float64Array(this.capacity);
    this.stamps = new Float64Array(this.capacity);
  }

  /**
   * Record a single labeled timing. Silently ignores non-finite/negative
   * durations and records for new labels once the cardinality cap is reached
   * (counted as `droppedLabelCount`). Never throws.
   */
  record(label: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const normalized = label.trim();
    if (!normalized) return;
    if (!this.knownLabels.has(normalized)) {
      if (this.knownLabels.size >= this.maxLabels) {
        this.droppedLabelCount += 1;
        return;
      }
      this.knownLabels.add(normalized);
    }
    const idx = this.writeIndex;
    this.labelSlots[idx] = normalized;
    this.durations[idx] = durationMs;
    this.stamps[idx] = this.nowMs();
    this.writeIndex = (idx + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  /**
   * Time a synchronous function, recording its duration under `label`. The
   * timing is recorded even if `fn` throws (via `finally`), then the error
   * propagates unchanged.
   */
  time<T>(label: string, fn: () => T): T {
    const startedAt = this.nowMs();
    try {
      return fn();
    } finally {
      this.record(label, this.nowMs() - startedAt);
    }
  }

  snapshot(overrides: HotPathSnapshotOverrides = {}): HotPathSnapshot {
    const now = this.nowMs();
    const windowsMinutes = normalizeWindows(overrides.windowsMinutes) ?? this.defaultWindowsMinutes;
    const topK = positiveInteger(overrides.topK, this.defaultTopK);
    return {
      schemaVersion: HOT_PATH_SAMPLER_SCHEMA_VERSION,
      generatedAt: this.nowIso(),
      capacity: this.capacity,
      retainedCount: this.size,
      labelCount: this.knownLabels.size,
      droppedLabelCount: this.droppedLabelCount,
      topK,
      windows: windowsMinutes.map((minutes) => this.computeWindow(minutes, now, topK)),
    };
  }

  private computeWindow(windowMinutes: number, now: number, topK: number): HotPathWindowMetric {
    const windowMs = windowMinutes * MS_PER_MINUTE;
    const cutoff = now - windowMs;
    const buckets = new Map<string, { count: number; totalMs: number; maxMs: number; durations: number[] }>();
    let sampleCount = 0;
    for (let i = 0; i < this.size; i += 1) {
      if (this.stamps[i] < cutoff) continue;
      const label = this.labelSlots[i];
      if (label === undefined) continue;
      const ms = this.durations[i];
      let bucket = buckets.get(label);
      if (!bucket) {
        bucket = { count: 0, totalMs: 0, maxMs: 0, durations: [] };
        buckets.set(label, bucket);
      }
      bucket.count += 1;
      bucket.totalMs += ms;
      if (ms > bucket.maxMs) bucket.maxMs = ms;
      bucket.durations.push(ms);
      sampleCount += 1;
    }
    const paths = [...buckets.entries()]
      .map(([label, bucket]) => ({
        label,
        count: bucket.count,
        totalMs: roundMs(bucket.totalMs),
        meanMs: roundMs(bucket.totalMs / bucket.count),
        p95Ms: percentile(bucket.durations, 95),
        maxMs: roundMs(bucket.maxMs),
      }))
      .sort((a, b) => b.totalMs - a.totalMs || a.label.localeCompare(b.label))
      .slice(0, topK);
    return { windowMinutes, windowMs, sampleCount, paths };
  }
}

let defaultSampler: HotPathSampler | undefined;

/** Process-wide default sampler that instrumentation call sites write into. */
export function getHotPathSampler(): HotPathSampler {
  return (defaultSampler ??= new HotPathSampler());
}

/** Convenience for instrumentation: record into the process-wide sampler. */
export function recordHotPath(label: string, durationMs: number): void {
  getHotPathSampler().record(label, durationMs);
}

/** Test seam: reset the process-wide sampler so a test starts from empty. */
export function resetHotPathSamplerForTests(): void {
  defaultSampler = undefined;
}

function percentile(samples: number[], percentileRank: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileRank / 100) * sorted.length) - 1),
  );
  return roundMs(sorted[index]);
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeWindows(windows: readonly number[] | undefined): readonly number[] | undefined {
  if (!windows) return undefined;
  const cleaned = windows.filter((w) => Number.isFinite(w) && w > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}
