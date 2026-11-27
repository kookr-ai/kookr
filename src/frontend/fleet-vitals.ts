/**
 * Dashboard-side logic for the machine + fleet vitals: checking what arrives on
 * the wire, judging pressure, and formatting numbers. No React here, so every
 * rule can be tested as a plain function.
 */
import type {
  FleetVitalsHistoryPoint,
  FleetVitalsSample,
} from '../shared/protocol.js';

/** Without a fresh sample for this long, the readings are shown as out of date. */
export const FLEET_VITALS_STALE_AFTER_MS = 10_000;

const GIB = 1_073_741_824;
const MIB = 1_048_576;
/** Memory is only called "full" when this little is actually free (mirrors `memorySeverity`). */
const LOW_FREE_MEMORY_BYTES = GIB;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function hasNullableNumbers(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => isNullableNumber(value[field]));
}

const MACHINE_NUMBER_FIELDS = [
  'cpuUsagePercent',
  'loadAverage1m',
  'logicalCpuCount',
  'memoryUsedPercent',
  'memoryUsedBytes',
  'memoryTotalBytes',
  'serverLoopDelayP95Ms',
] as const;

const GPU_NUMBER_FIELDS = [
  'utilizationPercent',
  'memoryUsedBytes',
  'memoryTotalBytes',
  'memoryUsedPercent',
  'temperatureC',
  'powerWatts',
] as const;

const HISTORY_NULLABLE_FIELDS = ['cpu', 'mem', 'gpu', 'vram', 'gen', 'read'] as const;

/**
 * Runtime check of a `fleetVitals` sample. A message that fails is ignored and
 * the previous sample stays until it goes stale: a malformed number must not
 * reach a meter width or a chart path.
 */
export function isFleetVitalsSample(value: unknown): value is FleetVitalsSample {
  if (!isObject(value) || !isCount(value.sampledAtMs)) return false;
  const { machine, fleet } = value;
  if (!isObject(machine) || !hasNullableNumbers(machine, MACHINE_NUMBER_FIELDS)) return false;
  if (machine.gpuUnavailable !== null && typeof machine.gpuUnavailable !== 'string') return false;
  if (machine.gpu !== null) {
    if (!isObject(machine.gpu) || !hasNullableNumbers(machine.gpu, GPU_NUMBER_FIELDS)) return false;
    if (!isCount(machine.gpu.deviceCount)) return false;
    if (machine.gpu.name !== null && typeof machine.gpu.name !== 'string') return false;
  }
  if (!isObject(fleet)) return false;
  if (!isCount(fleet.agents) || !isCount(fleet.subagents) || !isCount(fleet.toolCallsPerMin)) return false;
  if (fleet.tokens !== null) {
    if (!isObject(fleet.tokens)) return false;
    if (!isCount(fleet.tokens.generatedPerSec) || !isCount(fleet.tokens.readPerSec) || !isCount(fleet.tokens.cacheReadPerSec)) {
      return false;
    }
  }
  if (!Array.isArray(fleet.topTools)) return false;
  return fleet.topTools.every((entry) => isObject(entry) && typeof entry.tool === 'string' && isCount(entry.calls));
}

export function isFleetVitalsHistoryPoint(value: unknown): value is FleetVitalsHistoryPoint {
  if (!isObject(value)) return false;
  if (!isCount(value.t) || !isCount(value.run) || !isCount(value.tools)) return false;
  return hasNullableNumbers(value, HISTORY_NULLABLE_FIELDS);
}

/** Keep the valid points of a history array; anything else (not an array, a bad point) is dropped. */
export function sanitizeFleetVitalsHistory(value: unknown): FleetVitalsHistoryPoint[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isFleetVitalsHistoryPoint);
}

export function isFleetVitalsStale(receivedAtMs: number | null, nowMs: number): boolean {
  return receivedAtMs === null || nowMs - receivedAtMs > FLEET_VITALS_STALE_AFTER_MS;
}

/* ------------------------------------------------------------------ */
/* Pressure                                                            */
/* ------------------------------------------------------------------ */

/**
 * How a reading is doing. `watch` and `bad` are the two states that colour a
 * readout (amber and red); both always come with an icon and words.
 */
export type VitalsLevel = 'unknown' | 'ok' | 'watch' | 'bad';

/** The readings the verdict judges. GPU load is deliberately not one of them. */
export type VitalsResource = 'cpu' | 'ram' | 'vram' | 'lag';

function levelFromThresholds(value: number | null, watch: number, bad: number): VitalsLevel {
  if (value === null) return 'unknown';
  if (value >= bad) return 'bad';
  if (value >= watch) return 'watch';
  return 'ok';
}

/** CPU: busy from 85 %, saturated from 95 % (the thresholds the System indicator already uses). */
export function cpuLevel(sample: FleetVitalsSample): VitalsLevel {
  return levelFromThresholds(sample.machine.cpuUsagePercent, 85, 95);
}

/**
 * Memory: tight from 90 %; full only from 95 % with less than 1 GB really free.
 * The percentage is an estimate that counts reclaimable cache as used, so a
 * high percentage alone stays at "tight".
 */
export function ramLevel(sample: FleetVitalsSample): VitalsLevel {
  const { memoryUsedPercent, memoryUsedBytes, memoryTotalBytes } = sample.machine;
  const level = levelFromThresholds(memoryUsedPercent, 90, 95);
  if (level !== 'bad') return level;
  const freeBytes = memoryUsedBytes === null || memoryTotalBytes === null ? null : memoryTotalBytes - memoryUsedBytes;
  return freeBytes !== null && freeBytes <= LOW_FREE_MEMORY_BYTES ? 'bad' : 'watch';
}

/** Video memory: tight from 90 %, nearly full from 97 % (the next model load will fail). */
export function vramLevel(sample: FleetVitalsSample): VitalsLevel {
  return levelFromThresholds(sample.machine.gpu?.memoryUsedPercent ?? null, 90, 97);
}

/** Dashboard lag (the server's own timer delay): slow from 150 ms, very slow from 500 ms. */
export function lagLevel(sample: FleetVitalsSample): VitalsLevel {
  return levelFromThresholds(sample.machine.serverLoopDelayP95Ms, 150, 500);
}

/**
 * GPU load is shown but never judged: 100 % is the normal state of a training
 * or inference run, not a problem to look at.
 */
export function gpuLoadLevel(sample: FleetVitalsSample): VitalsLevel {
  return sample.machine.gpu?.utilizationPercent == null ? 'unknown' : 'ok';
}

export interface VitalsIssue {
  resource: VitalsResource;
  level: 'watch' | 'bad';
  /** Short phrase, sentence case when it starts the headline: "CPU saturated". */
  label: string;
}

const ISSUE_LABELS: Record<VitalsResource, { watch: string; bad: string }> = {
  cpu: { watch: 'CPU busy', bad: 'CPU saturated' },
  ram: { watch: 'Memory tight', bad: 'Memory full' },
  vram: { watch: 'VRAM tight', bad: 'VRAM nearly full' },
  lag: { watch: 'Dashboard slow', bad: 'Dashboard very slow' },
};

/** Fixed order: the same issue never changes place between two samples. */
const ISSUE_ORDER: readonly VitalsResource[] = ['cpu', 'ram', 'vram', 'lag'];

/** Everything currently under pressure, worst first, then in fixed resource order. */
export function fleetVitalsIssues(sample: FleetVitalsSample): VitalsIssue[] {
  const levels: Record<VitalsResource, VitalsLevel> = {
    cpu: cpuLevel(sample),
    ram: ramLevel(sample),
    vram: vramLevel(sample),
    lag: lagLevel(sample),
  };
  const issues: VitalsIssue[] = [];
  for (const wanted of ['bad', 'watch'] as const) {
    for (const resource of ISSUE_ORDER) {
      if (levels[resource] === wanted) {
        issues.push({ resource, level: wanted, label: ISSUE_LABELS[resource][wanted] });
      }
    }
  }
  return issues;
}

export interface VitalsVerdict {
  level: VitalsLevel;
  /** "Machine comfortable", "CPU saturated", "VRAM nearly full, CPU busy". Names at most two issues. */
  headline: string;
  /**
   * The short second read. At rest, the resource closest to its limit
   * ("Tightest: CPU 66%"). Under pressure the headline already names the
   * problem, so this only adds what did not fit: the third issue by name
   * ("+ dashboard very slow"), a count beyond that ("+2 more"), or nothing.
   */
  detail: string | null;
  issues: VitalsIssue[];
}

/**
 * One plain sentence about the machine, computed only from the current sample
 * (no prediction): what is under pressure, or that nothing is, and which
 * resource is closest to its limit.
 */
export function fleetVitalsVerdict(sample: FleetVitalsSample): VitalsVerdict {
  const issues = fleetVitalsIssues(sample);
  const { cpuUsagePercent, memoryUsedPercent, gpu } = sample.machine;
  const shares: Array<{ name: string; percent: number }> = [];
  if (cpuUsagePercent !== null) shares.push({ name: 'CPU', percent: cpuUsagePercent });
  if (memoryUsedPercent !== null) shares.push({ name: 'RAM', percent: memoryUsedPercent });
  if (gpu?.memoryUsedPercent != null) shares.push({ name: 'VRAM', percent: gpu.memoryUsedPercent });
  // First of equals wins, so the named resource does not flicker between two tied readings.
  const tightest = shares.reduce<{ name: string; percent: number } | null>(
    (best, share) => (best === null || share.percent > best.percent ? share : best),
    null,
  );
  const detail = tightest ? `Tightest: ${tightest.name} ${Math.round(tightest.percent)}%` : null;

  if (issues.length === 0) {
    // CPU needs two samples before it has a value. Until then the machine
    // cannot be called comfortable, whatever the other readings say.
    if (cpuUsagePercent === null) return { level: 'unknown', headline: 'Measuring', detail: null, issues };
    return { level: 'ok', headline: 'Machine comfortable', detail, issues };
  }
  const named = issues.slice(0, 2).map((issue, index) => (index === 0 ? issue.label : lowerFirstWord(issue.label)));
  return {
    level: issues[0].level,
    headline: named.join(', '),
    detail: extraIssuesLabel(issues.slice(2)),
    issues,
  };
}

/** What the headline had no room for: the one remaining issue by name, or a count. */
function extraIssuesLabel(extra: readonly VitalsIssue[]): string | null {
  if (extra.length === 0) return null;
  if (extra.length === 1) return `+ ${lowerFirstWord(extra[0].label)}`;
  return `+${extra.length} more`;
}

/** "Memory tight" -> "memory tight", but "CPU busy" and "VRAM tight" keep their acronym. */
function lowerFirstWord(label: string): string {
  const [first, ...rest] = label.split(' ');
  const lowered = first === first.toUpperCase() ? first : first.toLowerCase();
  return [lowered, ...rest].join(' ');
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** A reading that could not be measured. Never "0". */
export const VITALS_UNAVAILABLE = '--';

export function formatVitalsPercent(value: number | null | undefined): string {
  return value == null ? VITALS_UNAVAILABLE : `${Math.round(value)}%`;
}

/** 110 -> "110", 1_840 -> "1.8k", 13_860 -> "13.9k", 240_000 -> "240k", 1_250_000 -> "1.3M". */
export function formatVitalsCount(value: number | null | undefined): string {
  if (value == null) return VITALS_UNAVAILABLE;
  const rounded = Math.round(value);
  if (rounded < 1_000) return String(rounded);
  if (rounded < 100_000) return `${(rounded / 1_000).toFixed(1)}k`;
  if (rounded < 1_000_000) return `${Math.round(rounded / 1_000)}k`;
  return `${(rounded / 1_000_000).toFixed(1)}M`;
}

/**
 * Gigabytes with one decimal below 100 ("2.5", "23.3"), dropped when it is zero
 * ("24"). The decimal stays above 10 on purpose: 23.3 of 24 GB and 23.9 of
 * 24 GB are very different amounts of room left.
 */
function formatGigabytes(bytes: number): string {
  const gib = bytes / GIB;
  if (gib >= 100) return gib.toFixed(0);
  return gib.toFixed(1).replace(/\.0$/, '');
}

/** "2.5 / 24 GB": an amount against its limit. */
export function formatVitalsBytesOfTotal(usedBytes: number | null | undefined, totalBytes: number | null | undefined): string {
  if (usedBytes == null || totalBytes == null) return VITALS_UNAVAILABLE;
  if (totalBytes < GIB) return `${Math.round(usedBytes / MIB)} / ${Math.round(totalBytes / MIB)} MB`;
  return `${formatGigabytes(usedBytes)} / ${formatGigabytes(totalBytes)} GB`;
}

/**
 * A rate that can only be under-counted, as shown on the number: "≥110". Zero
 * is shown bare: "≥0" says nothing and reads as an error.
 */
export function formatVitalsLowerBound(value: number | null | undefined): string {
  if (value == null) return VITALS_UNAVAILABLE;
  const text = formatVitalsCount(value);
  return text === '0' ? text : `≥${text}`;
}

/** Share of the tokens read that came from the prompt cache, "98%"; `null` when nothing was read. */
export function cachedReadShare(sample: FleetVitalsSample): number | null {
  const tokens = sample.fleet.tokens;
  if (!tokens || tokens.readPerSec <= 0) return null;
  return Math.min(100, (100 * tokens.cacheReadPerSec) / tokens.readPerSec);
}

/** "NVIDIA GeForce RTX 3090" -> "RTX 3090": the part an operator recognises. */
export function shortGpuName(name: string | null | undefined): string | null {
  if (!name) return null;
  const short = name.replace(/^NVIDIA\s+/i, '').replace(/^GeForce\s+/i, '').trim();
  return short || name;
}

/* ------------------------------------------------------------------ */
/* Trend lines                                                         */
/* ------------------------------------------------------------------ */

export type VitalsSeries = 'gen' | 'read' | 'tools' | 'cpu' | 'mem' | 'gpu' | 'vram' | 'run';

/** One series out of the history, oldest first; unmeasured points stay `null`. */
export function vitalsSeries(history: readonly FleetVitalsHistoryPoint[], series: VitalsSeries): Array<number | null> {
  return history.map((point) => point[series]);
}

/** Highest measured value of a series, or `null` when it has none. */
export function seriesPeak(values: ReadonlyArray<number | null>): number | null {
  let peak: number | null = null;
  for (const value of values) {
    if (value !== null && (peak === null || value > peak)) peak = value;
  }
  return peak;
}

/**
 * SVG path of a trend line that always starts at a zero baseline: the bottom of
 * the box is 0 and the top is the series' own peak, so an idle fleet draws a
 * flat line on the floor instead of magnified noise. Unmeasured points break
 * the line. Returns `''` when there is nothing to draw.
 */
export function sparklinePath(
  values: ReadonlyArray<number | null>,
  width: number,
  height: number,
  slots: number = values.length,
): string {
  if (values.length === 0 || slots <= 0) return '';
  const peak = seriesPeak(values);
  if (peak === null) return '';
  // 1 px inset keeps a 1.5 px stroke inside the box at both extremes.
  const top = 1;
  const bottom = height - 1;
  const step = slots > 1 ? width / (slots - 1) : 0;
  // Right-align: the newest point sits at the right edge while the buffer fills.
  const offset = slots - values.length;
  let path = '';
  let penDown = false;
  values.forEach((value, index) => {
    if (value === null) {
      penDown = false;
      return;
    }
    const x = (offset + index) * step;
    const y = peak <= 0 ? bottom : bottom - (Math.max(0, value) / peak) * (bottom - top);
    path += `${penDown ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    penDown = true;
  });
  return path;
}

/**
 * How much time the trend lines cover, in words: "Last 5 min" once the buffer
 * is full, less while it fills after a server restart ("Last 40 s").
 */
export function historyWindowLabel(history: readonly FleetVitalsHistoryPoint[]): string {
  if (history.length < 2) return 'Just started';
  const spanMs = history[history.length - 1].t - history[0].t;
  if (spanMs < 60_000) return `Last ${Math.max(1, Math.round(spanMs / 1_000))} s`;
  return `Last ${Math.round(spanMs / 60_000)} min`;
}

/**
 * Where a trend line ends, for the dot that ties the line to the current
 * number: horizontal position as a share of the width (0-100) and vertical
 * position in the same units as `height`. `null` when the newest point is
 * unmeasured or there is nothing to draw. Uses the same zero-based scale as
 * `sparklinePath`.
 */
export function sparklineEnd(
  values: ReadonlyArray<number | null>,
  height: number,
  slots: number = values.length,
): { xPercent: number; y: number } | null {
  if (values.length === 0 || slots <= 0) return null;
  const last = values[values.length - 1];
  const peak = seriesPeak(values);
  if (last === null || peak === null) return null;
  const top = 1;
  const bottom = height - 1;
  const y = peak <= 0 ? bottom : bottom - (Math.max(0, last) / peak) * (bottom - top);
  // The newest point sits at the right edge (the series is right-aligned).
  return { xPercent: 100, y };
}
