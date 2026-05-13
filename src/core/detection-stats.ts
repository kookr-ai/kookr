import type { AnomalyType } from './types.js';

/**
 * Configuration surface for the anomaly detector. Kept in this module alongside
 * the detection-stats counters so callers that only touch configuration/telemetry
 * (diagnostics routes, ws.ts feedback path, monitor wiring) do not pull the full
 * detection code graph.
 */
export interface AnomalyDetectorConfig {
  repeatedErrorThreshold: number; // default: 3
  windowSize: number; // how many recent events to analyze
}

/** Per-detector-type telemetry: how often checked vs how often fired, plus user feedback. */
export interface DetectionStats {
  checks: Record<AnomalyType, number>;
  fires: Record<AnomalyType, number>;
  falsePositives: Record<AnomalyType, number>;
  /** Anomalies returned null at the suppression layer (e.g. needs_input while subagents running). */
  suppressed: Record<AnomalyType, number>;
  /** Outstanding subagent entries dropped at session/agent end (lost SubagentStop). */
  subagentOrphans: number;
  /** Distinct sessions that ended with at least one orphan — correct denominator for orphan-rate. */
  subagentSessionsWithOrphans: number;
  /** Outstanding subagent entries dropped by the lazy TTL eviction. */
  subagentTtlEvictions: number;
}

const ZERO_COUNTS: Record<AnomalyType, number> = {
  needs_input: 0,
  permission_blocked: 0,
  repeated_error: 0,
  merge_conflict: 0,
  stale_agent: 0,
  hook_disconnected: 0,
  hook_missing: 0,
  tmux_unresponsive: 0,
  api_error: 0,
  budget_exceeded: 0,
};

const stats: DetectionStats = {
  checks: { ...ZERO_COUNTS },
  fires: { ...ZERO_COUNTS },
  falsePositives: { ...ZERO_COUNTS },
  suppressed: { ...ZERO_COUNTS },
  subagentOrphans: 0,
  subagentSessionsWithOrphans: 0,
  subagentTtlEvictions: 0,
};

/** Get cumulative detection telemetry (checks performed vs anomalies fired per type). */
export function getDetectionStats(): DetectionStats {
  return {
    checks: { ...stats.checks },
    fires: { ...stats.fires },
    falsePositives: { ...stats.falsePositives },
    suppressed: { ...stats.suppressed },
    subagentOrphans: stats.subagentOrphans,
    subagentSessionsWithOrphans: stats.subagentSessionsWithOrphans,
    subagentTtlEvictions: stats.subagentTtlEvictions,
  };
}

/** Record a user-reported false positive for a detector type. */
export function recordFalsePositive(type: AnomalyType): void {
  stats.falsePositives[type]++;
}

/** Record a suppressed anomaly (returned null at the suppression layer). */
export function recordSuppression(type: AnomalyType): void {
  stats.suppressed[type]++;
}

/** Record a session ending with outstanding subagents. Pass distinct session count separately. */
export function recordSubagentOrphans(orphanCount: number, sessionsAffected: number): void {
  stats.subagentOrphans += orphanCount;
  stats.subagentSessionsWithOrphans += sessionsAffected;
}

/** Record a TTL-driven eviction of stale outstanding subagents. */
export function recordSubagentTtlEviction(count: number): void {
  stats.subagentTtlEvictions += count;
}

/**
 * Internal hook for detection code: increment a per-type `checks` counter.
 * Exported (rather than re-implemented via getDetectionStats) so the detection
 * module does not need to know the shape of the counter storage.
 */
export function recordDetectionCheck(type: AnomalyType): void {
  stats.checks[type]++;
}

/** Internal hook for detection code: increment a per-type `fires` counter. */
export function recordDetectionFire(type: AnomalyType): void {
  stats.fires[type]++;
}

/** Reset stats (for testing). */
export function resetDetectionStats(): void {
  for (const key of Object.keys(stats.checks) as AnomalyType[]) {
    stats.checks[key] = 0;
    stats.fires[key] = 0;
    stats.falsePositives[key] = 0;
    stats.suppressed[key] = 0;
  }
  stats.subagentOrphans = 0;
  stats.subagentSessionsWithOrphans = 0;
  stats.subagentTtlEvictions = 0;
}
