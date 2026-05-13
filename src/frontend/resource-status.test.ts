import { describe, expect, test } from 'vitest';
import {
  cpuSeverity,
  eventLoopSeverity,
  formatResourcePercent,
  isResourceStatusStale,
  isSystemResourceStatus,
  memorySeverity,
} from './resource-status.js';
import type { SystemResourceStatus } from '../shared/protocol.js';

function status(overrides: Partial<SystemResourceStatus> = {}): SystemResourceStatus {
  return {
    source: { kind: 'server-host' },
    sampledAt: '2026-05-13T00:00:00.000Z',
    sampleGapMs: null,
    timerDriftMs: null,
    host: {
      cpuUsagePercent: 42,
      memoryUsedPercent: 68,
      memoryFreeBytes: 4_000_000_000,
      memoryTotalBytes: 12_000_000_000,
    },
    server: {
      eventLoopDelayP95Ms: 20,
      processRssBytes: 200_000_000,
      processHeapUsedBytes: 80_000_000,
      processHeapTotalBytes: 100_000_000,
    },
    unavailable: [],
    ...overrides,
  };
}

describe('resource status helpers', () => {
  test('validates the server-host resource DTO shape', () => {
    expect(isSystemResourceStatus(status())).toBe(true);
    expect(isSystemResourceStatus({ ...status(), source: { kind: 'other' } })).toBe(false);
    expect(isSystemResourceStatus({ ...status(), host: { cpuUsagePercent: '42' } })).toBe(false);
  });

  test('formats null metrics as unavailable instead of zero', () => {
    expect(formatResourcePercent(null)).toBe('--');
    expect(formatResourcePercent(0)).toBe('0%');
  });

  test('derives frontend-owned CPU and event-loop severities', () => {
    expect(cpuSeverity(42)).toBe('normal');
    expect(cpuSeverity(88)).toBe('high');
    expect(cpuSeverity(99)).toBe('critical');
    expect(eventLoopSeverity(160)).toBe('high');
    expect(eventLoopSeverity(600)).toBe('critical');
  });

  test('keeps RAM critical styling muted unless free bytes are low', () => {
    expect(memorySeverity(status({ host: { ...status().host, memoryUsedPercent: 96, memoryFreeBytes: 4_000_000_000 } }))).toBe('high');
    expect(memorySeverity(status({ host: { ...status().host, memoryUsedPercent: 96, memoryFreeBytes: 500_000_000 } }))).toBe('critical');
  });

  test('marks resource status stale from browser receive time', () => {
    expect(isResourceStatusStale(1_000, 10_999)).toBe(false);
    expect(isResourceStatusStale(1_000, 11_001)).toBe(true);
  });
});
