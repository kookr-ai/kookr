/**
 * Bounded per-tool latency histogram for PreToolUse → PostToolUse durations.
 *
 * Mirrors the request-duration metrics pattern: retain a fixed-size ring of
 * samples per tool name (not an unbounded event list) and derive p50/p95/p99
 * from those samples. Tool-name cardinality is also capped.
 */

const DEFAULT_MAX_TOOLS = 64;
const DEFAULT_MAX_SAMPLES_PER_TOOL = 256;

export interface ToolLatencyMetricsOptions {
  maxTools?: number;
  maxSamplesPerTool?: number;
}

export interface ToolLatencySample {
  toolName: string;
  durationMs: number;
}

export interface ToolLatencyMetric {
  toolName: string;
  count: number;
  sampleCount: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface ToolLatencyMetricsSnapshot {
  schemaVersion: 'tool-latency-metrics.v1';
  maxTools: number;
  maxSamplesPerTool: number;
  toolCount: number;
  droppedToolCount: number;
  tools: ToolLatencyMetric[];
}

export class ToolLatencyMetrics {
  private readonly maxTools: number;
  private readonly maxSamplesPerTool: number;
  private readonly tools = new Map<string, ToolDurationBucket>();
  private droppedToolCount = 0;

  constructor(options: ToolLatencyMetricsOptions = {}) {
    this.maxTools = positiveInteger(options.maxTools, DEFAULT_MAX_TOOLS);
    this.maxSamplesPerTool = positiveInteger(options.maxSamplesPerTool, DEFAULT_MAX_SAMPLES_PER_TOOL);
  }

  record(sample: ToolLatencySample): void {
    if (!Number.isFinite(sample.durationMs) || sample.durationMs < 0) return;
    const toolName = normalizeToolName(sample.toolName);
    if (!toolName) return;

    let bucket = this.tools.get(toolName);
    if (!bucket) {
      if (this.tools.size >= this.maxTools) {
        this.droppedToolCount += 1;
        return;
      }
      bucket = new ToolDurationBucket(toolName, this.maxSamplesPerTool);
      this.tools.set(toolName, bucket);
    }
    bucket.record(sample.durationMs);
  }

  snapshot(): ToolLatencyMetricsSnapshot {
    return {
      schemaVersion: 'tool-latency-metrics.v1',
      maxTools: this.maxTools,
      maxSamplesPerTool: this.maxSamplesPerTool,
      toolCount: this.tools.size,
      droppedToolCount: this.droppedToolCount,
      tools: [...this.tools.values()]
        .map((bucket) => bucket.snapshot())
        .sort((a, b) => b.count - a.count || a.toolName.localeCompare(b.toolName)),
    };
  }
}

export function emptyToolLatencyMetricsSnapshot(): ToolLatencyMetricsSnapshot {
  return {
    schemaVersion: 'tool-latency-metrics.v1',
    maxTools: 0,
    maxSamplesPerTool: 0,
    toolCount: 0,
    droppedToolCount: 0,
    tools: [],
  };
}

function normalizeToolName(toolName: string): string {
  const normalized = toolName.trim();
  // Cap pathological tool-name lengths so a malicious/broken emitter cannot
  // inflate the Prometheus label set with multi-kilobyte strings.
  return normalized.length > 128 ? normalized.slice(0, 128) : normalized;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

class ToolDurationBucket {
  private count = 0;
  private nextIndex = 0;
  private readonly samples: number[] = [];

  constructor(
    private readonly toolName: string,
    private readonly maxSamples: number,
  ) {}

  record(durationMs: number): void {
    this.count += 1;
    if (this.samples.length < this.maxSamples) {
      this.samples.push(durationMs);
      return;
    }
    this.samples[this.nextIndex] = durationMs;
    this.nextIndex = (this.nextIndex + 1) % this.maxSamples;
  }

  snapshot(): ToolLatencyMetric {
    const sorted = [...this.samples].sort((a, b) => a - b);
    return {
      toolName: this.toolName,
      count: this.count,
      sampleCount: sorted.length,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
    };
  }
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
