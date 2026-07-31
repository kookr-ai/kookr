/**
 * Shadow detection report — offline analysis of shadow vs. real detection.
 *
 * Reads shadow-detection.jsonl, reconstructs anomaly intervals from
 * transitions + heartbeats, and computes per-strategy coverage metrics.
 */

import { closeSync, createReadStream, fstatSync, openSync, readSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { ShadowLogEntry, ShadowTransition, ShadowHeartbeat, ShadowSource } from './shadow-detector.js';
import type { AnomalyType } from './types.js';

/**
 * Bounds for per-request shadow-log reads (issue #1764).
 * Unbounded full-file parse of multi-hundred-MB shadow-detection.jsonl
 * OOM-wedged prod: one request inflates GBs of parsed rows, dashboard
 * retries stack concurrent parses, and the heap climbs to the limit.
 */
/** Default tail-window across all generations (most recent bytes first). */
export const DEFAULT_SHADOW_REPORT_MAX_BYTES = 4 * 1024 * 1024;
/** Hard cap on parsed JSONL rows retained for a report. */
export const DEFAULT_SHADOW_REPORT_MAX_ENTRIES = 50_000;
/** Drop entries older than this relative to the newest retained entry. */
export const DEFAULT_SHADOW_REPORT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ParseShadowLogFromFileOptions {
  /** Max raw bytes to read across generations, newest-first. */
  maxBytes?: number;
  /** Max parsed entries to keep (newest retained). */
  maxEntries?: number;
  /** Drop entries older than this many ms vs newest entry (0 = no age filter). */
  maxAgeMs?: number;
}

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

  // Math.min(...arr) overflows V8's spread-args limit (RangeError) once
  // entries.length passes ~100k; iterate instead.
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
 * Read a bounded tail of the shadow log (+ rotated generations).
 *
 * History: full-file `readFile` hit V8's ~512MB string cap; line streaming
 * sidestepped that but still loaded every row into the heap. Issue #1764:
 * prod had 172 MB live + 536 MB rotations — one report request inflated GBs
 * of parsed objects. This path only reads the newest `maxBytes`, keeps at
 * most `maxEntries` rows, and drops entries older than `maxAgeMs`.
 */
export async function parseShadowLogFromFile(
  filePath: string,
  options: ParseShadowLogFromFileOptions = {},
): Promise<{ entries: ShadowLogEntry[]; errors: number; truncated: boolean }> {
  const maxBytesOpt = options.maxBytes ?? DEFAULT_SHADOW_REPORT_MAX_BYTES;
  const maxEntriesOpt = options.maxEntries ?? DEFAULT_SHADOW_REPORT_MAX_ENTRIES;
  // POSITIVE_INFINITY / non-finite → unbounded (offline CLI / promotion analysis).
  const unboundedBytes = !Number.isFinite(maxBytesOpt);
  const unboundedEntries = !Number.isFinite(maxEntriesOpt);
  const maxBytes = unboundedBytes ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(maxBytesOpt));
  const maxEntries = unboundedEntries ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(maxEntriesOpt));
  const maxAgeMs = Math.max(0, Math.floor(options.maxAgeMs ?? DEFAULT_SHADOW_REPORT_MAX_AGE_MS));

  // Newest-first so the byte/row budget retains the recent window.
  const paths = (await listShadowLogPaths(filePath)).reverse();
  const newestFirst: ShadowLogEntry[] = [];
  let errors = 0;
  let bytesRemaining = maxBytes;
  let truncated = false;

  for (const path of paths) {
    if ((!unboundedBytes && bytesRemaining <= 0) || (!unboundedEntries && newestFirst.length >= maxEntries)) {
      truncated = true;
      break;
    }
    const entryBudget = unboundedEntries
      ? Number.POSITIVE_INFINITY
      : maxEntries - newestFirst.length;
    const parsed = unboundedBytes
      ? await parseShadowLogFileStream(path, entryBudget)
      : parseShadowLogFileTail(path, bytesRemaining, entryBudget);
    // parsed.entries are chronological within the file; reverse so we keep
    // prepending older generations behind the already-collected newer ones.
    for (let i = parsed.entries.length - 1; i >= 0; i--) {
      newestFirst.push(parsed.entries[i]!);
    }
    errors += parsed.errors;
    if (!unboundedBytes) bytesRemaining -= parsed.bytesRead;
    if (parsed.truncatedByBytes || parsed.truncatedByEntries) truncated = true;
  }

  // newestFirst is newest→oldest; restore chronological order for intervals.
  const chronological = newestFirst.reverse();

  if (maxAgeMs > 0 && chronological.length > 0) {
    let newestTs = Number.NEGATIVE_INFINITY;
    for (const e of chronological) {
      const ts = Date.parse(e.timestamp);
      if (Number.isFinite(ts) && ts > newestTs) newestTs = ts;
    }
    if (Number.isFinite(newestTs) && newestTs > Number.NEGATIVE_INFINITY) {
      const cutoff = newestTs - maxAgeMs;
      const filtered = chronological.filter((e) => {
        const ts = Date.parse(e.timestamp);
        return !Number.isFinite(ts) || ts >= cutoff;
      });
      if (filtered.length < chronological.length) truncated = true;
      return { entries: filtered, errors, truncated };
    }
  }

  return { entries: chronological, errors, truncated };
}

/**
 * List rotated generations + live file, oldest-first (`.N` high → `.1` → live).
 * Callers that want a tail window reverse this list.
 */
async function listShadowLogPaths(filePath: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dirname(filePath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return [filePath];
  }

  const base = basename(filePath);
  const generations = names
    .map((name) => {
      if (!name.startsWith(`${base}.`)) return null;
      const suffix = name.slice(base.length + 1);
      if (!/^[1-9][0-9]*$/.test(suffix)) return null;
      return { generation: Number(suffix), path: join(dirname(filePath), name) };
    })
    .filter((item): item is { generation: number; path: string } => item !== null)
    .sort((a, b) => b.generation - a.generation)
    .map((item) => item.path);

  return [...generations, filePath];
}

type FileParseResult = {
  entries: ShadowLogEntry[];
  errors: number;
  bytesRead: number;
  truncatedByBytes: boolean;
  truncatedByEntries: boolean;
};

/**
 * Stream-parse an entire shadow log file (offline / unbounded path).
 * Used when maxBytes is POSITIVE_INFINITY so the CLI can still analyze
 * full promotion corpora without the HTTP route's tight defaults.
 */
async function parseShadowLogFileStream(
  filePath: string,
  maxEntries: number,
): Promise<FileParseResult> {
  const entries: ShadowLogEntry[] = [];
  let errors = 0;
  let truncatedByEntries = false;
  const entryCap = Number.isFinite(maxEntries) ? maxEntries : Number.POSITIVE_INFINITY;
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as ShadowLogEntry;
        if (entry.kind === 'transition' || entry.kind === 'heartbeat') {
          entries.push(entry);
          // Sliding window: file is chronological, so drop the oldest when capped.
          if (entries.length > entryCap) {
            entries.shift();
            truncatedByEntries = true;
          }
        } else {
          errors++;
        }
      } catch {
        errors++;
      }
    }
  } catch {
    // ENOENT or mid-stream I/O failure: return whatever was parsed.
  } finally {
    rl.close();
  }
  return {
    entries,
    errors,
    bytesRead: 0,
    truncatedByBytes: false,
    truncatedByEntries,
  };
}

/**
 * Read at most `maxBytes` from the end of `filePath` and parse JSONL lines.
 * Drops a leading partial line only when the tail starts mid-line
 * (byte before `start` is not `\n`). Returns chronological entries.
 */
function parseShadowLogFileTail(
  filePath: string,
  maxBytes: number,
  maxEntries: number,
): FileParseResult {
  const entries: ShadowLogEntry[] = [];
  let errors = 0;
  let bytesRead = 0;
  let truncatedByBytes = false;
  let truncatedByEntries = false;
  let fd: number | undefined;

  try {
    fd = openSync(filePath, 'r');
    const size = fstatSync(fd).size;
    if (size <= 0) {
      return { entries, errors, bytesRead: 0, truncatedByBytes: false, truncatedByEntries: false };
    }

    const budget = Math.max(1, Math.floor(maxBytes));
    const start = size > budget ? size - budget : 0;
    truncatedByBytes = start > 0;
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    bytesRead = readSync(fd, buf, 0, length, start);
    let text = buf.subarray(0, bytesRead).toString('utf-8');
    // Only drop a leading partial line when the cut is mid-line. If the
    // byte immediately before `start` is `\n` (or start===0), the first
    // character of `text` is already a complete line start.
    if (start > 0) {
      const prev = Buffer.allocUnsafe(1);
      const prevRead = readSync(fd, prev, 0, 1, start - 1);
      const startsOnLineBoundary = prevRead === 1 && prev[0] === 0x0a;
      if (!startsOnLineBoundary) {
        const nl = text.indexOf('\n');
        if (nl >= 0 && nl + 1 < text.length) {
          text = text.slice(nl + 1);
        } else if (nl < 0) {
          // Entire tail is one partial line — nothing parseable.
          return { entries, errors, bytesRead, truncatedByBytes: true, truncatedByEntries: false };
        } else {
          // Tail ends at the first newline only (no complete subsequent line).
          text = '';
        }
      }
    }

    const lines = text.split('\n');
    // Walk newest→oldest so maxEntries keeps the recent end of this file.
    const newestFirst: ShadowLogEntry[] = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      if (Number.isFinite(maxEntries) && newestFirst.length >= maxEntries) {
        truncatedByEntries = true;
        break;
      }
      try {
        const entry = JSON.parse(line) as ShadowLogEntry;
        if (entry.kind === 'transition' || entry.kind === 'heartbeat') {
          newestFirst.push(entry);
        } else {
          errors++;
        }
      } catch {
        errors++;
      }
    }
    // Restore chronological order within the file window.
    for (let i = newestFirst.length - 1; i >= 0; i--) {
      entries.push(newestFirst[i]!);
    }
  } catch {
    // ENOENT or I/O failure: return whatever was parsed.
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }

  return { entries, errors, bytesRead, truncatedByBytes, truncatedByEntries };
}

export async function generateReportFromFile(
  filePath: string,
  options: ParseShadowLogFromFileOptions = {},
): Promise<ShadowReport> {
  const { entries, errors } = await parseShadowLogFromFile(filePath, options);
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
