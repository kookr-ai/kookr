/**
 * Shadow detection report — offline analysis of shadow vs. real detection.
 *
 * Reads shadow-detection.jsonl, reconstructs anomaly intervals from
 * transitions + heartbeats, and computes per-strategy coverage metrics.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ShadowLogEntry, ShadowTransition, ShadowHeartbeat, ShadowSource } from './shadow-detector.js';
import type { AnomalyType } from './types.js';

// --- Interval types ---

interface AnomalyInterval {
  agentId: string;
  anomalyType: AnomalyType;
  startMs: number;
  endMs: number; // Infinity if still active at end of observation
}

// --- Report types ---

export interface StrategyReport {
  source: ShadowSource;
  /** Total observation time across all agents (ms) */
  totalObservationMs: number;
  /** Number of distinct anomaly intervals detected by real detector */
  realIntervals: number;
  /** Number of real intervals that shadow also detected (even partially) */
  matchedIntervals: number;
  /** Number of shadow-only intervals (not matched by real) */
  unmatchedShadowIntervals: number;
  /** Coverage: fraction of real-anomaly-time covered by shadow */
  coverage: number | null;
  /** Precision: fraction of shadow-anomaly-time that was actual anomaly */
  precision: number | null;
  /** Total real anomaly time (ms) */
  realAnomalyMs: number;
  /** Total shadow anomaly time (ms) */
  shadowAnomalyMs: number;
  /** Overlap time (ms) */
  overlapMs: number;
  /** Per-transition detection latency (shadow start - real start, ms). Positive = shadow lagged. */
  detectionDelays: number[];
  /** Per-transition clearing latency (shadow end - real end, ms). Positive = shadow lagged. */
  clearingDelays: number[];
  /** Heartbeat count processed */
  heartbeatCount: number;
  /** Transition count processed */
  transitionCount: number;
}

export interface ShadowReport {
  generatedAt: string;
  observationWindow: { startMs: number; endMs: number } | null;
  strategies: StrategyReport[];
  totalEntries: number;
  parseErrors: number;
}

// --- Parsing ---

export function parseShadowLog(content: string): { entries: ShadowLogEntry[]; errors: number } {
  const entries: ShadowLogEntry[] = [];
  let errors = 0;

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as ShadowLogEntry;
      if (entry.kind === 'transition' || entry.kind === 'heartbeat') {
        entries.push(entry);
      } else {
        errors++;
      }
    } catch {
      errors++;
    }
  }

  return { entries, errors };
}

// --- Interval reconstruction ---

/**
 * Reconstruct anomaly intervals from a series of heartbeats and transitions.
 * Heartbeats provide periodic state snapshots; transitions mark exact state changes.
 * Together they allow interval reconstruction even if some transitions are lost.
 */
function reconstructIntervals(
  entries: ShadowLogEntry[],
  source: ShadowSource,
  stateField: 'shadowState' | 'realState',
): AnomalyInterval[] {
  // Group entries by agentId, sorted by timestamp
  const byAgent = new Map<string, ShadowLogEntry[]>();
  for (const entry of entries) {
    if (entry.source !== source) continue;
    const list = byAgent.get(entry.agentId) ?? [];
    list.push(entry);
    byAgent.set(entry.agentId, list);
  }

  const intervals: AnomalyInterval[] = [];

  for (const [agentId, agentEntries] of byAgent) {
    agentEntries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    let currentType: AnomalyType | null = null;
    let intervalStart = 0;

    for (const entry of agentEntries) {
      const ts = new Date(entry.timestamp).getTime();
      let stateNow: AnomalyType | null;

      if (entry.kind === 'heartbeat') {
        stateNow = stateField === 'shadowState' ? entry.shadowState : entry.realState;
      } else {
        // For transitions, determine state from transition type
        if (stateField === 'shadowState') {
          stateNow = entry.transition === 'entered_anomaly' ? entry.anomalyType : null;
        } else {
          stateNow = entry.realState.anomaly;
        }
      }

      if (stateNow !== currentType) {
        // Close previous interval
        if (currentType !== null) {
          intervals.push({ agentId, anomalyType: currentType, startMs: intervalStart, endMs: ts });
        }
        // Open new interval
        if (stateNow !== null) {
          intervalStart = ts;
        }
        currentType = stateNow;
      }
    }

    // Close any open interval at the last entry timestamp
    if (currentType !== null && agentEntries.length > 0) {
      const lastTs = new Date(agentEntries[agentEntries.length - 1].timestamp).getTime();
      intervals.push({ agentId, anomalyType: currentType, startMs: intervalStart, endMs: lastTs });
    }
  }

  return intervals;
}

// --- Interval comparison ---

function computeOverlapMs(a: AnomalyInterval[], b: AnomalyInterval[]): number {
  let total = 0;
  for (const ai of a) {
    for (const bi of b) {
      if (ai.agentId !== bi.agentId) continue;
      const overlapStart = Math.max(ai.startMs, bi.startMs);
      const overlapEnd = Math.min(ai.endMs, bi.endMs);
      if (overlapEnd > overlapStart) {
        total += overlapEnd - overlapStart;
      }
    }
  }
  return total;
}

function totalDurationMs(intervals: AnomalyInterval[]): number {
  return intervals.reduce((sum, i) => sum + (i.endMs - i.startMs), 0);
}

/**
 * Count how many intervals in `target` are at least partially overlapped by any interval in `reference`.
 */
function countMatchedIntervals(target: AnomalyInterval[], reference: AnomalyInterval[]): number {
  let matched = 0;
  for (const t of target) {
    const hasOverlap = reference.some((r) =>
      r.agentId === t.agentId &&
      Math.max(t.startMs, r.startMs) < Math.min(t.endMs, r.endMs),
    );
    if (hasOverlap) matched++;
  }
  return matched;
}

/**
 * Compute detection delays: for each real interval that was matched by shadow,
 * how much later (or earlier) did the shadow interval start?
 */
function computeDetectionDelays(realIntervals: AnomalyInterval[], shadowIntervals: AnomalyInterval[]): number[] {
  const delays: number[] = [];
  for (const ri of realIntervals) {
    // Find the first shadow interval that overlaps this real interval
    const match = shadowIntervals.find((si) =>
      si.agentId === ri.agentId &&
      Math.max(ri.startMs, si.startMs) < Math.min(ri.endMs, si.endMs),
    );
    if (match) {
      delays.push(match.startMs - ri.startMs);
    }
  }
  return delays;
}

function computeClearingDelays(realIntervals: AnomalyInterval[], shadowIntervals: AnomalyInterval[]): number[] {
  const delays: number[] = [];
  for (const ri of realIntervals) {
    const match = shadowIntervals.find((si) =>
      si.agentId === ri.agentId &&
      Math.max(ri.startMs, si.startMs) < Math.min(ri.endMs, si.endMs),
    );
    if (match) {
      delays.push(match.endMs - ri.endMs);
    }
  }
  return delays;
}

// --- Report generation ---

export function generateReport(entries: ShadowLogEntry[]): ShadowReport {
  if (entries.length === 0) {
    return {
      generatedAt: new Date().toISOString(),
      observationWindow: null,
      strategies: [],
      totalEntries: 0,
      parseErrors: 0,
    };
  }

  // Determine observation window. Iterate instead of spreading into Math.min/max:
  // entries.length above ~100k overflows JS's spread-args limit and throws
  // RangeError("Maximum call stack size exceeded"), which made multi-day logs
  // silently unanalyzable.
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  for (const e of entries) {
    const ts = new Date(e.timestamp).getTime();
    if (ts < startMs) startMs = ts;
    if (ts > endMs) endMs = ts;
  }

  // Find all unique sources
  const sources = new Set<ShadowSource>();
  for (const e of entries) sources.add(e.source);

  const strategies: StrategyReport[] = [];

  for (const source of sources) {
    const sourceEntries = entries.filter((e) => e.source === source);
    const heartbeats = sourceEntries.filter((e): e is ShadowHeartbeat => e.kind === 'heartbeat');
    const transitions = sourceEntries.filter((e): e is ShadowTransition => e.kind === 'transition');

    // Reconstruct intervals
    const realIntervals = reconstructIntervals(sourceEntries, source, 'realState');
    const shadowIntervals = reconstructIntervals(sourceEntries, source, 'shadowState');

    const realMs = totalDurationMs(realIntervals);
    const shadowMs = totalDurationMs(shadowIntervals);
    const overlapMs = computeOverlapMs(realIntervals, shadowIntervals);

    const matchedReal = countMatchedIntervals(realIntervals, shadowIntervals);
    const unmatchedShadow = shadowIntervals.length - countMatchedIntervals(shadowIntervals, realIntervals);

    strategies.push({
      source,
      totalObservationMs: endMs - startMs,
      realIntervals: realIntervals.length,
      matchedIntervals: matchedReal,
      unmatchedShadowIntervals: unmatchedShadow,
      coverage: realMs > 0 ? overlapMs / realMs : null,
      precision: shadowMs > 0 ? overlapMs / shadowMs : null,
      realAnomalyMs: realMs,
      shadowAnomalyMs: shadowMs,
      overlapMs,
      detectionDelays: computeDetectionDelays(realIntervals, shadowIntervals),
      clearingDelays: computeClearingDelays(realIntervals, shadowIntervals),
      heartbeatCount: heartbeats.length,
      transitionCount: transitions.length,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    observationWindow: { startMs, endMs },
    strategies,
    totalEntries: entries.length,
    parseErrors: 0,
  };
}

// --- File-based report ---

/**
 * Read the shadow log line-by-line. readFile(path, 'utf-8') exceeds V8's
 * ~512MB string-length limit on multi-day logs, so the previous
 * implementation silently returned an empty report. Streaming sidesteps
 * the string-length cap; in-memory entry size is still bounded by JS heap.
 */
export async function parseShadowLogFromFile(
  filePath: string,
): Promise<{ entries: ShadowLogEntry[]; errors: number }> {
  const entries: ShadowLogEntry[] = [];
  let errors = 0;

  let stream;
  try {
    stream = createReadStream(filePath, { encoding: 'utf-8' });
  } catch {
    return { entries, errors };
  }

  try {
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as ShadowLogEntry;
        if (entry.kind === 'transition' || entry.kind === 'heartbeat') {
          entries.push(entry);
        } else {
          errors++;
        }
      } catch {
        errors++;
      }
    }
  } catch {
    // ENOENT or stream error: return whatever was parsed.
  }

  return { entries, errors };
}

export async function generateReportFromFile(filePath: string): Promise<ShadowReport> {
  const { entries, errors } = await parseShadowLogFromFile(filePath);
  const report = generateReport(entries);
  report.parseErrors = errors;
  return report;
}

// --- Text formatting ---

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function fmtMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function fmtPct(value: number | null): string {
  if (value === null) return 'N/A';
  return `${(value * 100).toFixed(1)}%`;
}

export function formatReport(report: ShadowReport): string {
  const lines: string[] = [];
  const window = report.observationWindow;

  if (!window) {
    lines.push('Shadow Detection Report');
    lines.push('=======================');
    lines.push('No data available.');
    return lines.join('\n');
  }

  const durationMs = window.endMs - window.startMs;
  lines.push(`Shadow Detection Report (${fmtMs(durationMs)} observation window)`);
  lines.push('='.repeat(60));
  lines.push(`Total entries: ${report.totalEntries}  Parse errors: ${report.parseErrors}`);
  lines.push('');

  for (const s of report.strategies) {
    lines.push(`Strategy: ${s.source}`);
    lines.push(`  Real anomaly intervals: ${s.realIntervals}`);
    lines.push(`  Matched by shadow:      ${s.matchedIntervals}/${s.realIntervals}`);
    lines.push(`  Shadow-only intervals:  ${s.unmatchedShadowIntervals}`);
    lines.push('');
    lines.push(`  Coverage (recall):  ${fmtPct(s.coverage)}  (${fmtMs(s.overlapMs)} / ${fmtMs(s.realAnomalyMs)})`);
    lines.push(`  Precision:          ${fmtPct(s.precision)}  (${fmtMs(s.overlapMs)} / ${fmtMs(s.shadowAnomalyMs)})`);
    lines.push('');

    if (s.detectionDelays.length > 0) {
      lines.push(`  Detection latency:  median ${fmtMs(median(s.detectionDelays)!)}  p95 ${fmtMs(percentile(s.detectionDelays, 95)!)}`);
    }
    if (s.clearingDelays.length > 0) {
      lines.push(`  Clearing latency:   median ${fmtMs(median(s.clearingDelays)!)}  p95 ${fmtMs(percentile(s.clearingDelays, 95)!)}`);
    }

    lines.push(`  Heartbeats: ${s.heartbeatCount}  Transitions: ${s.transitionCount}`);
    lines.push('');
  }

  return lines.join('\n');
}
