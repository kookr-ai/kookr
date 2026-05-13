import type { SystemResourceStatus } from '../shared/protocol.js';

export type ResourceSeverity = 'normal' | 'elevated' | 'high' | 'critical' | 'unavailable';

export const RESOURCE_STATUS_STALE_AFTER_MS = 10_000;
const LOW_FREE_MEMORY_BYTES = 1_073_741_824;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function hasNullableNumberFields(value: unknown, fields: string[]): value is Record<string, number | null> {
  if (!isObject(value)) return false;
  return fields.every((field) => isNullableNumber(value[field]));
}

export function isSystemResourceStatus(value: unknown): value is SystemResourceStatus {
  if (!isObject(value)) return false;
  if (!isObject(value.source) || value.source.kind !== 'server-host') return false;
  if (typeof value.sampledAt !== 'string') return false;
  if (!isNullableNumber(value.sampleGapMs) || !isNullableNumber(value.timerDriftMs)) return false;
  if (!hasNullableNumberFields(value.host, [
    'cpuUsagePercent',
    'memoryUsedPercent',
    'memoryFreeBytes',
    'memoryTotalBytes',
  ])) return false;
  if (!hasNullableNumberFields(value.server, [
    'eventLoopDelayP95Ms',
    'processRssBytes',
    'processHeapUsedBytes',
    'processHeapTotalBytes',
  ])) return false;
  return Array.isArray(value.unavailable) && value.unavailable.every((reason) => typeof reason === 'string');
}

export function percentSeverity(value: number | null, thresholds: { elevated: number; high: number; critical: number }): ResourceSeverity {
  if (value === null) return 'unavailable';
  if (value >= thresholds.critical) return 'critical';
  if (value >= thresholds.high) return 'high';
  if (value >= thresholds.elevated) return 'elevated';
  return 'normal';
}

export function cpuSeverity(value: number | null): ResourceSeverity {
  return percentSeverity(value, { elevated: 70, high: 85, critical: 95 });
}

export function memorySeverity(status: SystemResourceStatus | null): ResourceSeverity {
  if (!status || status.host.memoryUsedPercent === null) return 'unavailable';
  const base = percentSeverity(status.host.memoryUsedPercent, { elevated: 80, high: 90, critical: 95 });
  if (
    base === 'critical'
    && status.host.memoryFreeBytes !== null
    && status.host.memoryFreeBytes <= LOW_FREE_MEMORY_BYTES
  ) {
    return 'critical';
  }
  if (base === 'critical') return 'high';
  return base;
}

export function eventLoopSeverity(value: number | null): ResourceSeverity {
  if (value === null) return 'unavailable';
  if (value >= 500) return 'critical';
  if (value >= 150) return 'high';
  if (value >= 50) return 'elevated';
  return 'normal';
}

export function isResourceStatusStale(receivedAtMs: number | null, nowMs: number): boolean {
  return receivedAtMs === null || nowMs - receivedAtMs > RESOURCE_STATUS_STALE_AFTER_MS;
}

export function formatResourcePercent(value: number | null): string {
  return value === null ? '--' : `${Math.round(value)}%`;
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '--';
  const gib = bytes / 1_073_741_824;
  if (gib >= 1) return `${gib.toFixed(gib >= 10 ? 0 : 1)} GB`;
  const mib = bytes / 1_048_576;
  return `${mib.toFixed(0)} MB`;
}

export function formatResourceAge(sampledAt: string, nowMs: number): string {
  const sampledMs = Date.parse(sampledAt);
  if (!Number.isFinite(sampledMs)) return 'unknown age';
  const ageSeconds = Math.max(0, Math.round((nowMs - sampledMs) / 1_000));
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  return `${Math.round(ageSeconds / 60)}m ago`;
}

export function formatResourceDetails(status: SystemResourceStatus, nowMs: number): string[] {
  const lines = [
    `Server loop p95 ${status.server.eventLoopDelayP95Ms === null ? '--' : `${Math.round(status.server.eventLoopDelayP95Ms)} ms`}`,
    `Kookr RSS ${formatBytes(status.server.processRssBytes)}`,
    `RAM ${formatBytes(status.host.memoryFreeBytes)} free / ${formatBytes(status.host.memoryTotalBytes)} total`,
    `Sampled ${formatResourceAge(status.sampledAt, nowMs)}`,
    'Approximate physical memory reported by Node; not OS memory pressure.',
  ];
  if (status.sampleGapMs !== null) lines.push(`CPU sample gap ${Math.round(status.sampleGapMs)} ms`);
  if (status.timerDriftMs !== null && status.timerDriftMs > 0) lines.push(`Sampler drift ${Math.round(status.timerDriftMs)} ms`);
  return lines;
}
