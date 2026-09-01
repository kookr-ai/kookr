import { statfsSync } from 'node:fs';
import { cpus, freemem, totalmem } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { SystemResourceStatus } from '../shared/contracts/messages.js';
import {
  calculateMemoryUsage,
  CpuUsageTracker,
  normalizeDataDirectoryInodeCounts,
  type CpuCoreSample,
} from '../core/system-resource-metrics.js';

export const RESOURCE_STATUS_INTERVAL_MS = 2_000;
const EVENT_LOOP_RESOLUTION_MS = 20;
const NS_PER_MS = 1_000_000;

export interface EventLoopDelayMonitor {
  enable(): void;
  disable(): void;
  reset(): void;
  percentile(percentile: number): number;
  count?: number | bigint;
}

export interface DataDirectoryDiskUsage {
  path: string;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  diskFreePercent: number | null;
  diskFreeInodes: number | null;
  diskTotalInodes: number | null;
}

/** Minimal `statfs` shape used by the sampler and deterministic tests. */
export interface DataDirectoryStatfsSample {
  bsize: number;
  bavail: number;
  blocks: number;
  files?: number;
  ffree?: number;
}

export interface SystemResourceSamplerDeps {
  readCpus?: () => CpuCoreSample[];
  readTotalMemoryBytes?: () => number;
  readFreeMemoryBytes?: () => number;
  readProcessMemory?: () => NodeJS.MemoryUsage;
  nowMs?: () => number;
  nowIso?: () => string;
  createEventLoopMonitor?: () => EventLoopDelayMonitor;
  dataDirectoryPath?: string | null;
  readDataDirectoryDiskUsage?: (path: string) => DataDirectoryDiskUsage | null;
  intervalMs?: number;
}

export class SystemResourceSampler {
  private readonly cpuTracker: CpuUsageTracker;
  private readonly readCpus: () => CpuCoreSample[];
  private readonly readTotalMemoryBytes: () => number;
  private readonly readFreeMemoryBytes: () => number;
  private readonly readProcessMemory: () => NodeJS.MemoryUsage;
  private readonly nowMs: () => number;
  private readonly nowIso: () => string;
  private readonly eventLoopMonitor: EventLoopDelayMonitor;
  private readonly dataDirectoryPath: string | null;
  private readonly readDataDirectoryDiskUsage: (path: string) => DataDirectoryDiskUsage | null;
  private eventLoopEnabled = false;

  constructor(deps: SystemResourceSamplerDeps = {}) {
    const intervalMs = deps.intervalMs ?? RESOURCE_STATUS_INTERVAL_MS;
    this.cpuTracker = new CpuUsageTracker({ intervalMs });
    this.readCpus = deps.readCpus ?? (() => cpus());
    this.readTotalMemoryBytes = deps.readTotalMemoryBytes ?? totalmem;
    this.readFreeMemoryBytes = deps.readFreeMemoryBytes ?? freemem;
    this.readProcessMemory = deps.readProcessMemory ?? (() => process.memoryUsage());
    this.nowMs = deps.nowMs ?? (() => performance.now());
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
    this.eventLoopMonitor = (deps.createEventLoopMonitor ?? (() => monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS })))();
    this.dataDirectoryPath = deps.dataDirectoryPath ?? null;
    this.readDataDirectoryDiskUsage = deps.readDataDirectoryDiskUsage ?? readDataDirectoryDiskUsageWithStatfs;
  }

  start(): void {
    if (this.eventLoopEnabled) return;
    this.eventLoopMonitor.enable();
    this.eventLoopEnabled = true;
  }

  stop(): void {
    if (!this.eventLoopEnabled) return;
    this.eventLoopMonitor.disable();
    this.eventLoopEnabled = false;
  }

  sample(expectedAtMs: number | null = null): SystemResourceStatus {
    const nowMs = this.nowMs();
    const unavailable: SystemResourceStatus['unavailable'] = [];

    const cpu = this.cpuTracker.update(this.readCpus(), nowMs);
    unavailable.push(...cpu.unavailable);

    const memory = calculateMemoryUsage(this.readTotalMemoryBytes(), this.readFreeMemoryBytes());
    unavailable.push(...memory.unavailable);

    const eventLoopDelayP95Ms = this.readEventLoopDelayP95Ms();
    if (eventLoopDelayP95Ms === null) {
      unavailable.push('event_loop_unavailable');
    }

    const processMemory = this.readProcessMemory();
    const dataDirectory = this.readDataDirectory();
    if (dataDirectory.diskFreeBytes === null || dataDirectory.diskFreePercent === null) {
      unavailable.push('data_directory_disk_unavailable');
    }

    return {
      source: { kind: 'server-host' },
      sampledAt: this.nowIso(),
      sampleGapMs: cpu.sampleGapMs,
      timerDriftMs: expectedAtMs === null ? null : Math.max(0, nowMs - expectedAtMs),
      host: {
        cpuUsagePercent: cpu.usagePercent,
        memoryUsedPercent: memory.memoryUsedPercent,
        memoryFreeBytes: memory.memoryFreeBytes,
        memoryTotalBytes: memory.memoryTotalBytes,
        dataDirectory,
      },
      server: {
        eventLoopDelayP95Ms,
        processRssBytes: processMemory.rss,
        processHeapUsedBytes: processMemory.heapUsed,
        processHeapTotalBytes: processMemory.heapTotal,
      },
      unavailable,
    };
  }

  private readEventLoopDelayP95Ms(): number | null {
    const count = Number(this.eventLoopMonitor.count ?? 0);
    if (count <= 0) return null;
    const p95Ns = this.eventLoopMonitor.percentile(95);
    this.eventLoopMonitor.reset();
    if (!Number.isFinite(p95Ns)) return null;
    return p95Ns / NS_PER_MS;
  }

  private readDataDirectory(): SystemResourceStatus['host']['dataDirectory'] {
    if (this.dataDirectoryPath === null || this.dataDirectoryPath.trim() === '') {
      return {
        path: null,
        diskFreeBytes: null,
        diskTotalBytes: null,
        diskFreePercent: null,
        diskFreeInodes: null,
        diskTotalInodes: null,
      };
    }
    const usage = this.readDataDirectoryDiskUsage(this.dataDirectoryPath);
    return usage ?? {
      path: this.dataDirectoryPath,
      diskFreeBytes: null,
      diskTotalBytes: null,
      diskFreePercent: null,
      diskFreeInodes: null,
      diskTotalInodes: null,
    };
  }
}

export function createSystemResourceSampler(deps?: SystemResourceSamplerDeps): SystemResourceSampler {
  return new SystemResourceSampler(deps);
}

export function readDataDirectoryDiskUsageWithStatfs(
  path: string,
  readStatfs: (target: string) => DataDirectoryStatfsSample = (target) => statfsSync(target),
): DataDirectoryDiskUsage | null {
  if (typeof statfsSync !== 'function') return null;
  try {
    const stats = readStatfs(path);
    const blockSize = Number(stats.bsize);
    const availableBlocks = Number(stats.bavail);
    const totalBlocks = Number(stats.blocks);
    const diskFreeBytes = availableBlocks * blockSize;
    const diskTotalBytes = totalBlocks * blockSize;
    const bytesAvailable = !(
      !Number.isFinite(blockSize)
      || blockSize <= 0
      || !Number.isFinite(diskFreeBytes)
      || diskFreeBytes < 0
      || !Number.isFinite(diskTotalBytes)
      || diskTotalBytes <= 0
    );
    const inodeCounts = normalizeDataDirectoryInodeCounts({
      diskFreeInodes: stats.ffree == null ? null : Number(stats.ffree),
      diskTotalInodes: stats.files == null ? null : Number(stats.files),
    });
    if (!bytesAvailable && inodeCounts === null) {
      return null;
    }
    return {
      path,
      diskFreeBytes: bytesAvailable ? diskFreeBytes : null,
      diskTotalBytes: bytesAvailable ? diskTotalBytes : null,
      diskFreePercent: bytesAvailable ? (diskFreeBytes / diskTotalBytes) * 100 : null,
      diskFreeInodes: inodeCounts?.diskFreeInodes ?? null,
      diskTotalInodes: inodeCounts?.diskTotalInodes ?? null,
    };
  } catch {
    return null;
  }
}
