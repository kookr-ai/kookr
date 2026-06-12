/**
 * Self-diagnostic for rate anomalies.
 *
 * A pure function that examines current system counters and computes
 * window-delta rates. Reports findings only when rates are pathologically
 * high — values so far out of normal range they indicate a bug.
 *
 * See docs/rfc/rfc-self-diagnostic-rate-anomalies.md
 */

import type { DetectionStats } from './detection-stats.js';
import type { HelperLlmDiagnosticsSnapshot } from './llm-types.js';
import type { AnomalyType } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = 'warning' | 'critical';

/** A single finding from the self-diagnostic. */
export interface DiagnosticFinding {
  /** Machine-readable check identifier (e.g., "detection-fire-rate"). */
  checkId: string;
  /** Human-readable title (e.g., "needs_input firing 26,333/hr"). */
  title: string;
  /** What's wrong, with context — includes observed rate, threshold,
   *  normal range, and what to investigate. */
  description: string;
  severity: DiagnosticSeverity;
  /** The observed value (for programmatic comparison). */
  observed: number;
  /** The threshold that was exceeded (for programmatic comparison). */
  threshold: number;
  /** Which agent, anomaly type, or subsystem is affected. */
  scope: string;
}

/** Input to the diagnostic function — current system counters. */
export interface DiagnosticInput {
  /** Server uptime in milliseconds. */
  uptimeMs: number;
  /** Number of registered agents. */
  agentCount: number;
  /** Per-type detection stats from getDetectionStats(). */
  detectionStats: DetectionStats;
  /** WebSocket broadcast counter (monotonic since startup). */
  wsBroadcastCount: number;
  /** Event pipeline counter per agent (monotonic since startup). */
  eventCounts: Record<string, number>;
  /** Last snapshot payload size in bytes. */
  lastSnapshotSizeBytes: number;
  /** Aggregate diagnostics for Kookr's own helper-LLM calls. */
  helperLlm: HelperLlmDiagnosticsSnapshot;
}

/** Output of the diagnostic function. */
export interface DiagnosticReport {
  /** When the diagnostic ran (ms since epoch). */
  timestamp: number;
  /** List of findings (empty = healthy). */
  findings: DiagnosticFinding[];
  /** Diagnostics-only accounting for Kookr's own helper-LLM calls. */
  helperLlm: HelperLlmDiagnosticsSnapshot;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const MIN_UPTIME_MS = 5 * 60 * 1000; // 5 minutes

/** Per anomaly-type per hour. */
const DETECTION_FIRE_RATE_WARNING = 1_000;
const DETECTION_FIRE_RATE_CRITICAL = 10_000;

/** Per agent per hour. */
const EVENT_PIPELINE_RATE_WARNING = 5_000;
const EVENT_PIPELINE_RATE_CRITICAL = 50_000;

/** System-wide per hour. */
const WS_BROADCAST_RATE_WARNING = 10_000;
const WS_BROADCAST_RATE_CRITICAL = 100_000;

/** Absolute bytes. */
const SNAPSHOT_SIZE_WARNING = 500 * 1024;       // 500 KB
const SNAPSHOT_SIZE_CRITICAL = 2 * 1024 * 1024;  // 2 MB

// ---------------------------------------------------------------------------
// Rate computation helpers
// ---------------------------------------------------------------------------

export interface PreviousSnapshot {
  timestamp: number;
  detectionStats: DetectionStats;
  wsBroadcastCount: number;
  eventCounts: Record<string, number>;
}

/**
 * Compute hourly rate from a counter delta over an interval.
 * Returns the rate as events/hr.
 */
function toHourlyRate(delta: number, intervalMs: number): number {
  if (intervalMs <= 0) return 0;
  return (delta / intervalMs) * 3_600_000;
}

// ---------------------------------------------------------------------------
// Core diagnostic function
// ---------------------------------------------------------------------------

/**
 * Pure function. Takes current counters + optional previous snapshot,
 * computes window-delta rates, and returns findings for any pathological values.
 *
 * No side effects, no I/O, no persistent state.
 */
export function runDiagnostic(
  input: DiagnosticInput,
  previous?: PreviousSnapshot | null,
): DiagnosticReport {
  const findings: DiagnosticFinding[] = [];
  const now = Date.now();

  // --- snapshot-size: absolute check, always runs (not a rate) ---
  checkSnapshotSize(input, findings);

  // --- Rate checks: skip if uptime < 5 min ---
  if (input.uptimeMs >= MIN_UPTIME_MS) {
    const intervalMs = previous ? (now - previous.timestamp) : input.uptimeMs;

    // Only compute rates if interval is meaningful (at least 60s)
    if (intervalMs >= 60_000) {
      checkDetectionFireRate(input, previous, intervalMs, findings);
      checkEventPipelineRate(input, previous, intervalMs, findings);
      checkWsBroadcastRate(input, previous, intervalMs, findings);
    }
  }

  return { timestamp: now, findings, helperLlm: input.helperLlm };
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkSnapshotSize(input: DiagnosticInput, findings: DiagnosticFinding[]): void {
  const size = input.lastSnapshotSizeBytes;
  if (size <= SNAPSHOT_SIZE_WARNING) return;

  const severity: DiagnosticSeverity = size > SNAPSHOT_SIZE_CRITICAL ? 'critical' : 'warning';
  const sizeKB = Math.round(size / 1024);

  findings.push({
    checkId: 'snapshot-size',
    title: `Snapshot payload is ${sizeKB} KB`,
    description:
      `WebSocket snapshot payload is ${sizeKB} KB (threshold: ${Math.round(SNAPSHOT_SIZE_WARNING / 1024)} KB warning, ` +
      `${Math.round(SNAPSHOT_SIZE_CRITICAL / 1024)} KB critical). ` +
      `Normal for 10 agents: ~15 KB. ` +
      `Investigate event window leaks in monitor.ts or serialization bugs in get-snapshot.ts.`,
    severity,
    observed: size,
    threshold: severity === 'critical' ? SNAPSHOT_SIZE_CRITICAL : SNAPSHOT_SIZE_WARNING,
    scope: 'snapshot (system-wide)',
  });
}

function checkDetectionFireRate(
  input: DiagnosticInput,
  previous: PreviousSnapshot | null | undefined,
  intervalMs: number,
  findings: DiagnosticFinding[],
): void {
  const currentFires = input.detectionStats.fires;
  const previousFires = previous?.detectionStats.fires;

  for (const anomalyType of Object.keys(currentFires) as AnomalyType[]) {
    const current = currentFires[anomalyType];
    const prev = previousFires?.[anomalyType] ?? 0;
    const delta = current - prev;
    if (delta <= 0) continue;

    const rate = toHourlyRate(delta, intervalMs);
    if (rate <= DETECTION_FIRE_RATE_WARNING) continue;

    const severity: DiagnosticSeverity = rate > DETECTION_FIRE_RATE_CRITICAL ? 'critical' : 'warning';
    const rateStr = Math.round(rate).toLocaleString();

    findings.push({
      checkId: 'detection-fire-rate',
      title: `${anomalyType} firing ${rateStr}/hr`,
      description:
        `Anomaly detector fires for ${anomalyType}: ${rateStr}/hr ` +
        `(threshold: ${DETECTION_FIRE_RATE_WARNING.toLocaleString()}/hr warning, ` +
        `${DETECTION_FIRE_RATE_CRITICAL.toLocaleString()}/hr critical). ` +
        `Normal: 10-50/hr per type. ` +
        `Check the detector logic for ${anomalyType} in anomaly-detector.ts and watchdog.ts.`,
      severity,
      observed: Math.round(rate),
      threshold: severity === 'critical' ? DETECTION_FIRE_RATE_CRITICAL : DETECTION_FIRE_RATE_WARNING,
      scope: anomalyType,
    });
  }
}

function checkEventPipelineRate(
  input: DiagnosticInput,
  previous: PreviousSnapshot | null | undefined,
  intervalMs: number,
  findings: DiagnosticFinding[],
): void {
  if (input.agentCount === 0) return;

  const currentCounts = input.eventCounts;
  const previousCounts = previous?.eventCounts;

  for (const [agentId, current] of Object.entries(currentCounts)) {
    const prev = previousCounts?.[agentId] ?? 0;
    const delta = current - prev;
    if (delta <= 0) continue;

    const rate = toHourlyRate(delta, intervalMs);
    if (rate <= EVENT_PIPELINE_RATE_WARNING) continue;

    const severity: DiagnosticSeverity = rate > EVENT_PIPELINE_RATE_CRITICAL ? 'critical' : 'warning';
    const rateStr = Math.round(rate).toLocaleString();

    findings.push({
      checkId: 'event-pipeline-rate',
      title: `${agentId} processing ${rateStr} events/hr`,
      description:
        `Event pipeline for ${agentId}: ${rateStr} events/hr ` +
        `(threshold: ${EVENT_PIPELINE_RATE_WARNING.toLocaleString()}/hr warning, ` +
        `${EVENT_PIPELINE_RATE_CRITICAL.toLocaleString()}/hr critical). ` +
        `Normal: 50-200 events/hr per agent. ` +
        `Check for duplicate event ingestion in hook-watcher.ts or event-pipeline.ts.`,
      severity,
      observed: Math.round(rate),
      threshold: severity === 'critical' ? EVENT_PIPELINE_RATE_CRITICAL : EVENT_PIPELINE_RATE_WARNING,
      scope: agentId,
    });
  }
}

function checkWsBroadcastRate(
  input: DiagnosticInput,
  previous: PreviousSnapshot | null | undefined,
  intervalMs: number,
  findings: DiagnosticFinding[],
): void {
  const delta = input.wsBroadcastCount - (previous?.wsBroadcastCount ?? 0);
  if (delta <= 0) return;

  const rate = toHourlyRate(delta, intervalMs);
  if (rate <= WS_BROADCAST_RATE_WARNING) return;

  const severity: DiagnosticSeverity = rate > WS_BROADCAST_RATE_CRITICAL ? 'critical' : 'warning';
  const rateStr = Math.round(rate).toLocaleString();

  findings.push({
    checkId: 'ws-broadcast-rate',
    title: `WebSocket broadcasting ${rateStr}/hr`,
    description:
      `WebSocket broadcasts: ${rateStr}/hr ` +
      `(threshold: ${WS_BROADCAST_RATE_WARNING.toLocaleString()}/hr warning, ` +
      `${WS_BROADCAST_RATE_CRITICAL.toLocaleString()}/hr critical). ` +
      `Normal for 3 agents at 5s intervals: ~2,160/hr. ` +
      `Check for runaway state updates in lifecycle-timers.ts or event-pipeline.ts.`,
    severity,
    observed: Math.round(rate),
    threshold: severity === 'critical' ? WS_BROADCAST_RATE_CRITICAL : WS_BROADCAST_RATE_WARNING,
    scope: 'websocket (system-wide)',
  });
}
