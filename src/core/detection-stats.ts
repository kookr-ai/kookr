import type { AnomalyType } from './types.js';

export const SUPPRESSION_REASONS = [
  'subagent_running',
  'systemic_hook_stall',
  'snooze_false_positive',
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

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
  /**
   * User-reported missed findings: agent was shown as healthy but the user
   * had to intervene. Bucketed by the suspectedType the user picked; if the
   * user did not name a type, the report is not counted here (still persisted
   * in the supervisor-feedback case log).
   */
  falseNegatives: Record<AnomalyType, number>;
  /** Anomalies returned null at the suppression layer (e.g. needs_input while subagents running). */
  suppressed: Record<AnomalyType, number>;
  /** Suppressed anomalies split by bounded reason for post-hoc diagnostics. */
  suppressionReasons: Record<AnomalyType, Record<SuppressionReason, number>>;
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
  hook_parse_degraded: 0,
  tmux_unresponsive: 0,
  api_error: 0,
  budget_exceeded: 0,
};

const ZERO_SUPPRESSION_REASON_COUNTS: Record<SuppressionReason, number> = {
  subagent_running: 0,
  systemic_hook_stall: 0,
  snooze_false_positive: 0,
};

function createZeroSuppressionReasons(): Record<AnomalyType, Record<SuppressionReason, number>> {
  return Object.fromEntries(
    Object.keys(ZERO_COUNTS).map((type) => [type, { ...ZERO_SUPPRESSION_REASON_COUNTS }]),
  ) as Record<AnomalyType, Record<SuppressionReason, number>>;
}

const stats: DetectionStats = {
  checks: { ...ZERO_COUNTS },
  fires: { ...ZERO_COUNTS },
  falsePositives: { ...ZERO_COUNTS },
  falseNegatives: { ...ZERO_COUNTS },
  suppressed: { ...ZERO_COUNTS },
  suppressionReasons: createZeroSuppressionReasons(),
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
    falseNegatives: { ...stats.falseNegatives },
    suppressed: { ...stats.suppressed },
    suppressionReasons: Object.fromEntries(
      Object.entries(stats.suppressionReasons).map(([type, reasons]) => [type, { ...reasons }]),
    ) as Record<AnomalyType, Record<SuppressionReason, number>>,
    subagentOrphans: stats.subagentOrphans,
    subagentSessionsWithOrphans: stats.subagentSessionsWithOrphans,
    subagentTtlEvictions: stats.subagentTtlEvictions,
  };
}

/** Record a user-reported false positive for a detector type. */
export function recordFalsePositive(type: AnomalyType): void {
  stats.falsePositives[type]++;
}

/**
 * Record a user-reported missed finding for a detector type. The agent was
 * shown as healthy but the user had to intervene; the user identified what
 * kind of finding should have surfaced.
 */
export function recordFalseNegative(type: AnomalyType): void {
  stats.falseNegatives[type]++;
}

/** Record a suppressed anomaly (returned null at the suppression layer). */
export function recordSuppression(type: AnomalyType, reason: SuppressionReason): void {
  stats.suppressed[type]++;
  stats.suppressionReasons[type][reason]++;
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

/**
 * Replace the in-memory counters from a persisted snapshot (loaded at server
 * boot). Without this, the counters are process-local and reset on every
 * restart, so cumulative detector accuracy (FP/FN/suppression rates) is never
 * observable across the restarts that happen many times a day — leaving the
 * operator flying blind on detector quality.
 *
 * Defensive: only known per-type keys are copied, and only finite non-negative
 * numbers; a partial or stale snapshot (e.g. an AnomalyType added since it was
 * written) hydrates what it can and leaves the rest at zero. Unknown keys are
 * ignored.
 */
export function hydrateDetectionStats(snapshot: Partial<DetectionStats>): void {
  const perType: Array<keyof Pick<DetectionStats, 'checks' | 'fires' | 'falsePositives' | 'falseNegatives' | 'suppressed'>> = [
    'checks', 'fires', 'falsePositives', 'falseNegatives', 'suppressed',
  ];
  for (const bucket of perType) {
    const incoming = snapshot[bucket];
    if (!incoming || typeof incoming !== 'object') continue;
    for (const key of Object.keys(stats[bucket]) as AnomalyType[]) {
      const value = (incoming as Record<string, unknown>)[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        stats[bucket][key] = value;
      }
    }
  }
  const suppressionReasons = snapshot.suppressionReasons;
  if (suppressionReasons && typeof suppressionReasons === 'object') {
    for (const type of Object.keys(stats.suppressionReasons) as AnomalyType[]) {
      const incomingByReason = (suppressionReasons as Record<string, unknown>)[type];
      if (!incomingByReason || typeof incomingByReason !== 'object') continue;
      for (const reason of SUPPRESSION_REASONS) {
        const value = (incomingByReason as Record<string, unknown>)[reason];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          stats.suppressionReasons[type][reason] = value;
        }
      }
    }
  }
  const scalars: Array<keyof Pick<DetectionStats, 'subagentOrphans' | 'subagentSessionsWithOrphans' | 'subagentTtlEvictions'>> = [
    'subagentOrphans', 'subagentSessionsWithOrphans', 'subagentTtlEvictions',
  ];
  for (const key of scalars) {
    const value = snapshot[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      stats[key] = value;
    }
  }
}

/** Reset stats (for testing). */
export function resetDetectionStats(): void {
  for (const key of Object.keys(stats.checks) as AnomalyType[]) {
    stats.checks[key] = 0;
    stats.fires[key] = 0;
    stats.falsePositives[key] = 0;
    stats.falseNegatives[key] = 0;
    stats.suppressed[key] = 0;
    for (const reason of SUPPRESSION_REASONS) {
      stats.suppressionReasons[key][reason] = 0;
    }
  }
  stats.subagentOrphans = 0;
  stats.subagentSessionsWithOrphans = 0;
  stats.subagentTtlEvictions = 0;
}
