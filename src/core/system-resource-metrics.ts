export interface CpuTimesSample {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

export interface CpuCoreSample {
  times: CpuTimesSample;
}

export type CpuUnavailableReason =
  | 'cpu_warming_up'
  | 'cpu_unavailable'
  | 'cpu_delta_invalid';

export interface CpuUsageResult {
  usagePercent: number | null;
  sampleGapMs: number | null;
  unavailable: CpuUnavailableReason[];
}

export interface CpuUsageTrackerOptions {
  intervalMs?: number;
  resetGapMs?: number;
}

interface CpuBaseline {
  cores: CpuTimesSample[];
  monotonicMs: number;
}

const DEFAULT_RESOURCE_STATUS_INTERVAL_MS = 2_000;

function totalCpuTime(times: CpuTimesSample): number {
  return times.user + times.nice + times.sys + times.idle + times.irq;
}

function hasNegativeCounterDelta(prev: CpuTimesSample, next: CpuTimesSample): boolean {
  return next.user < prev.user
    || next.nice < prev.nice
    || next.sys < prev.sys
    || next.idle < prev.idle
    || next.irq < prev.irq;
}

function cloneCpuTimes(times: CpuTimesSample): CpuTimesSample {
  return {
    user: times.user,
    nice: times.nice,
    sys: times.sys,
    idle: times.idle,
    irq: times.irq,
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

export class CpuUsageTracker {
  private previous: CpuBaseline | null = null;
  private readonly resetGapMs: number;

  constructor(options: CpuUsageTrackerOptions = {}) {
    const intervalMs = options.intervalMs ?? DEFAULT_RESOURCE_STATUS_INTERVAL_MS;
    this.resetGapMs = options.resetGapMs ?? Math.max(30_000, 10 * intervalMs);
  }

  update(cores: CpuCoreSample[], monotonicMs: number): CpuUsageResult {
    const current = cores.map((core) => cloneCpuTimes(core.times));
    if (current.length === 0) {
      this.previous = null;
      return { usagePercent: null, sampleGapMs: null, unavailable: ['cpu_unavailable'] };
    }

    if (!this.previous) {
      this.previous = { cores: current, monotonicMs };
      return { usagePercent: null, sampleGapMs: null, unavailable: ['cpu_warming_up'] };
    }

    const sampleGapMs = monotonicMs - this.previous.monotonicMs;
    if (current.length !== this.previous.cores.length || sampleGapMs > this.resetGapMs) {
      this.previous = { cores: current, monotonicMs };
      return { usagePercent: null, sampleGapMs, unavailable: ['cpu_delta_invalid'] };
    }

    let idleDelta = 0;
    let totalDelta = 0;

    for (let i = 0; i < current.length; i += 1) {
      const prev = this.previous.cores[i];
      const next = current[i];
      const prevTotal = totalCpuTime(prev);
      const nextTotal = totalCpuTime(next);
      const coreTotalDelta = nextTotal - prevTotal;
      const coreIdleDelta = next.idle - prev.idle;

      if (hasNegativeCounterDelta(prev, next) || coreTotalDelta < 0 || coreIdleDelta < 0) {
        this.previous = { cores: current, monotonicMs };
        return { usagePercent: null, sampleGapMs, unavailable: ['cpu_delta_invalid'] };
      }

      idleDelta += coreIdleDelta;
      totalDelta += coreTotalDelta;
    }

    this.previous = { cores: current, monotonicMs };

    if (totalDelta <= 0) {
      return { usagePercent: null, sampleGapMs, unavailable: ['cpu_delta_invalid'] };
    }

    const usagePercent = clampPercent(100 * (1 - idleDelta / totalDelta));
    return { usagePercent, sampleGapMs, unavailable: [] };
  }
}

export interface MemoryUsageResult {
  memoryUsedPercent: number | null;
  memoryFreeBytes: number | null;
  memoryTotalBytes: number | null;
  unavailable: 'memory_unavailable'[];
}

export function calculateMemoryUsage(totalBytes: number, freeBytes: number): MemoryUsageResult {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isFinite(freeBytes)) {
    return {
      memoryUsedPercent: null,
      memoryFreeBytes: null,
      memoryTotalBytes: null,
      unavailable: ['memory_unavailable'],
    };
  }

  const boundedFreeBytes = Math.min(Math.max(freeBytes, 0), totalBytes);
  return {
    memoryUsedPercent: clampPercent(100 * (1 - boundedFreeBytes / totalBytes)),
    memoryFreeBytes: boundedFreeBytes,
    memoryTotalBytes: totalBytes,
    unavailable: [],
  };
}
