import { describe, expect, test, vi } from 'vitest';
import {
  readDataDirectoryDiskUsageWithStatfs,
  SystemResourceSampler,
  type DataDirectoryDiskUsage,
  type EventLoopDelayMonitor,
} from './system-resource-sampler.js';
import type { CpuCoreSample } from '../core/system-resource-metrics.js';

function cpu(user: number, idle: number): CpuCoreSample {
  return { times: { user, nice: 0, sys: 0, idle, irq: 0 } };
}

function monitor(count = 1, p95Ns = 21_000_000): EventLoopDelayMonitor {
  return {
    count,
    enable: vi.fn(),
    disable: vi.fn(),
    reset: vi.fn(),
    percentile: vi.fn(() => p95Ns),
  };
}

describe('SystemResourceSampler', () => {
  test('maps host and process metrics into the shared DTO', () => {
    let now = 1_000;
    let cpuSamples = [cpu(100, 900)];
    const sampler = new SystemResourceSampler({
      readCpus: () => cpuSamples,
      readTotalMemoryBytes: () => 1_000,
      readFreeMemoryBytes: () => 250,
      readProcessMemory: () => ({ rss: 500, heapUsed: 200, heapTotal: 400, external: 0, arrayBuffers: 0 }),
      nowMs: () => now,
      nowIso: () => '2026-05-13T00:00:00.000Z',
      createEventLoopMonitor: () => monitor(1, 25_000_000),
      dataDirectoryPath: '/tmp/kookr-data',
      readDataDirectoryDiskUsage: (path): DataDirectoryDiskUsage => ({
        path,
        diskFreeBytes: 3_000,
        diskTotalBytes: 10_000,
        diskFreePercent: 30,
      }),
    });

    sampler.start();
    sampler.sample();
    now = 3_000;
    cpuSamples = [cpu(160, 940)];
    const status = sampler.sample(2_900);

    expect(status.source).toEqual({ kind: 'server-host' });
    expect(status.host.cpuUsagePercent).toBeCloseTo(60);
    expect(status.sampleGapMs).toBe(2_000);
    expect(status.timerDriftMs).toBe(100);
    expect(status.host.memoryUsedPercent).toBe(75);
    expect(status.server.eventLoopDelayP95Ms).toBe(25);
    expect(status.server.processRssBytes).toBe(500);
    expect(status.host.dataDirectory).toEqual({
      path: '/tmp/kookr-data',
      diskFreeBytes: 3_000,
      diskTotalBytes: 10_000,
      diskFreePercent: 30,
    });
    expect(status.unavailable).toEqual([]);
  });

  test('reports unavailable metrics as null, not zero', () => {
    const sampler = new SystemResourceSampler({
      readCpus: () => [],
      readTotalMemoryBytes: () => 0,
      readFreeMemoryBytes: () => 0,
      readProcessMemory: () => ({ rss: 500, heapUsed: 200, heapTotal: 400, external: 0, arrayBuffers: 0 }),
      nowMs: () => 1_000,
      nowIso: () => '2026-05-13T00:00:00.000Z',
      createEventLoopMonitor: () => monitor(0),
      dataDirectoryPath: '/tmp/kookr-data',
      readDataDirectoryDiskUsage: () => null,
    });

    const status = sampler.sample();

    expect(status.host.cpuUsagePercent).toBeNull();
    expect(status.host.memoryUsedPercent).toBeNull();
    expect(status.server.eventLoopDelayP95Ms).toBeNull();
    expect(status.host.dataDirectory).toEqual({
      path: '/tmp/kookr-data',
      diskFreeBytes: null,
      diskTotalBytes: null,
      diskFreePercent: null,
    });
    expect(status.unavailable).toEqual([
      'cpu_unavailable',
      'memory_unavailable',
      'event_loop_unavailable',
      'data_directory_disk_unavailable',
    ]);
  });

  test('omits data-directory disk sampling when no path is configured', () => {
    const readDataDirectoryDiskUsage = vi.fn();
    const sampler = new SystemResourceSampler({
      readCpus: () => [cpu(100, 900)],
      readTotalMemoryBytes: () => 1_000,
      readFreeMemoryBytes: () => 250,
      readProcessMemory: () => ({ rss: 500, heapUsed: 200, heapTotal: 400, external: 0, arrayBuffers: 0 }),
      nowMs: () => 1_000,
      nowIso: () => '2026-05-13T00:00:00.000Z',
      createEventLoopMonitor: () => monitor(1, 25_000_000),
      readDataDirectoryDiskUsage,
    });

    const status = sampler.sample();

    expect(readDataDirectoryDiskUsage).not.toHaveBeenCalled();
    expect(status.host.dataDirectory).toEqual({
      path: null,
      diskFreeBytes: null,
      diskTotalBytes: null,
      diskFreePercent: null,
    });
    expect(status.unavailable).toEqual([
      'cpu_warming_up',
      'data_directory_disk_unavailable',
    ]);
  });

  test('reads data-directory disk usage through the default statfs helper', () => {
    const usage = readDataDirectoryDiskUsageWithStatfs(process.cwd());

    expect(usage).not.toBeNull();
    expect(usage?.path).toBe(process.cwd());
    expect(usage?.diskFreeBytes).toEqual(expect.any(Number));
    expect(usage?.diskTotalBytes).toEqual(expect.any(Number));
    expect(usage?.diskFreePercent).toBeCloseTo(
      (usage!.diskFreeBytes! / usage!.diskTotalBytes!) * 100,
    );
  });

  test('statfs helper fails open to null when the directory is unreadable', () => {
    expect(readDataDirectoryDiskUsageWithStatfs('/tmp/kookr-missing-statfs-target')).toBeNull();
  });
});
