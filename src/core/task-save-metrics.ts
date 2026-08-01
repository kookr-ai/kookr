/**
 * Always-on ring buffer for tasks.json / tasks.sqlite save timing (issue #1777).
 *
 * saveTasks already computes serializeMs/writeMs/totalMs/bytes but historically
 * only logged under KOOKR_LOG_TASK_SAVE_METRICS=1. This recorder keeps the last N
 * samples process-wide so /metrics can expose p95 serialize/write and last bytes
 * without an env flag. Recording is fire-and-forget — never throws, never blocks.
 */

export const DEFAULT_TASK_SAVE_METRICS_MAX_SAMPLES = 64;

export type TaskSaveBackend = 'json' | 'sqlite';

export interface TaskSaveSample {
  serializeMs: number;
  writeMs: number;
  totalMs: number;
  bytes: number;
  taskCount: number;
  relationCount: number;
  backend: TaskSaveBackend;
}

export interface TaskSaveLastSample {
  serializeMs: number;
  writeMs: number;
  totalMs: number;
  bytes: number;
  taskCount: number;
  relationCount: number;
  backend: TaskSaveBackend;
}

export interface TaskSaveMetricsSnapshot {
  schemaVersion: 'task-save-metrics.v1';
  maxSamples: number;
  sampleCount: number;
  totalObservations: number;
  p95SerializeMs: number;
  p95WriteMs: number;
  p95TotalMs: number;
  last: TaskSaveLastSample | null;
}

export interface TaskSaveMetricsRecorderOptions {
  maxSamples?: number;
}

export class TaskSaveMetricsRecorder {
  private readonly maxSamples: number;
  private readonly samples: TaskSaveSample[] = [];
  private nextIndex = 0;
  private totalObservations = 0;
  private last: TaskSaveLastSample | null = null;

  constructor(options: TaskSaveMetricsRecorderOptions = {}) {
    this.maxSamples = positiveInteger(options.maxSamples, DEFAULT_TASK_SAVE_METRICS_MAX_SAMPLES);
  }

  record(sample: TaskSaveSample): void {
    if (!isFiniteNonNegative(sample.serializeMs)
      || !isFiniteNonNegative(sample.writeMs)
      || !isFiniteNonNegative(sample.totalMs)
      || !isFiniteNonNegative(sample.bytes)
      || !isFiniteNonNegative(sample.taskCount)
      || !isFiniteNonNegative(sample.relationCount)
    ) {
      return;
    }
    if (sample.backend !== 'json' && sample.backend !== 'sqlite') return;

    const normalized: TaskSaveSample = {
      serializeMs: roundMs(sample.serializeMs),
      writeMs: roundMs(sample.writeMs),
      totalMs: roundMs(sample.totalMs),
      bytes: Math.round(sample.bytes),
      taskCount: Math.round(sample.taskCount),
      relationCount: Math.round(sample.relationCount),
      backend: sample.backend,
    };

    this.totalObservations += 1;
    this.last = { ...normalized };

    if (this.samples.length < this.maxSamples) {
      this.samples.push(normalized);
      return;
    }
    this.samples[this.nextIndex] = normalized;
    this.nextIndex = (this.nextIndex + 1) % this.maxSamples;
  }

  snapshot(): TaskSaveMetricsSnapshot {
    const serialize = this.samples.map((s) => s.serializeMs).sort((a, b) => a - b);
    const write = this.samples.map((s) => s.writeMs).sort((a, b) => a - b);
    const total = this.samples.map((s) => s.totalMs).sort((a, b) => a - b);
    return {
      schemaVersion: 'task-save-metrics.v1',
      maxSamples: this.maxSamples,
      sampleCount: this.samples.length,
      totalObservations: this.totalObservations,
      p95SerializeMs: percentile(serialize, 95),
      p95WriteMs: percentile(write, 95),
      p95TotalMs: percentile(total, 95),
      last: this.last ? { ...this.last } : null,
    };
  }

  /** Test helper — drop retained samples without changing maxSamples. */
  reset(): void {
    this.samples.length = 0;
    this.nextIndex = 0;
    this.totalObservations = 0;
    this.last = null;
  }
}

/** Process-wide recorder so free-function save paths stay always-on. */
export const taskSaveMetrics = new TaskSaveMetricsRecorder();

export function emptyTaskSaveMetricsSnapshot(): TaskSaveMetricsSnapshot {
  return {
    schemaVersion: 'task-save-metrics.v1',
    maxSamples: 0,
    sampleCount: 0,
    totalObservations: 0,
    p95SerializeMs: 0,
    p95WriteMs: 0,
    p95TotalMs: 0,
    last: null,
  };
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function percentile(sortedSamples: number[], percentileRank: number): number {
  if (sortedSamples.length === 0) return 0;
  const index = Math.min(
    sortedSamples.length - 1,
    Math.max(0, Math.ceil((percentileRank / 100) * sortedSamples.length) - 1),
  );
  return roundMs(sortedSamples[index]!);
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}
