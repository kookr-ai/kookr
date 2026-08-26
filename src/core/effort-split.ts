/**
 * Effort-split vs 80/20 target (issue #1718).
 *
 * Measures output share between a primary repo (default `jeanibarz/lucy`) and a
 * secondary repo (default `kookr-ai/kookr`) from gh-sourced metrics — not the
 * contribution ledger. The daily-report playbook calls `kookr effort-split` and
 * pastes the formatted section into the Discord digest.
 *
 * Target split is 80% primary / 20% secondary. A deviation flag fires when the
 * secondary share on any metric falls outside the band
 * `[target − deviationPts, target + deviationPts]` (default 5%–35%).
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const EFFORT_SPLIT_SCHEMA = 'effort-split.v1' as const;

export const DEFAULT_PRIMARY_REPO = 'jeanibarz/lucy';
export const DEFAULT_SECONDARY_REPO = 'kookr-ai/kookr';
/** Secondary (kookr) target share of output. Primary target is 1 − this. */
export const DEFAULT_SECONDARY_TARGET_SHARE = 0.2;
/** Allowed absolute deviation from the secondary target (0.15 → band 5%–35%). */
export const DEFAULT_DEVIATION_PTS = 0.15;
export const DEFAULT_WINDOW_HOURS = 24;
export const EFFORT_SPLIT_FILENAME = 'effort-split.jsonl';

export type EffortMetricKey = 'nonMergeCommits' | 'prsMerged' | 'linesChanged';

export const EFFORT_METRIC_LABELS: Record<EffortMetricKey, string> = {
  nonMergeCommits: 'non-merge commits',
  prsMerged: 'PRs merged',
  linesChanged: 'lines changed',
};

export const EFFORT_METRIC_KEYS: readonly EffortMetricKey[] = [
  'nonMergeCommits',
  'prsMerged',
  'linesChanged',
] as const;

export interface RepoEffortMetrics {
  /** `owner/name` GitHub repo id. */
  repo: string;
  nonMergeCommits: number;
  prsMerged: number;
  /** additions + deletions over the window. */
  linesChanged: number;
  additions?: number;
  deletions?: number;
}

export interface EffortShareSlice {
  count: number;
  /** 0–100, one decimal. */
  sharePct: number;
}

export interface EffortShareMetric {
  metric: EffortMetricKey;
  label: string;
  total: number;
  byRepo: Record<string, EffortShareSlice>;
}

export interface EffortDeviation {
  metric: EffortMetricKey;
  label: string;
  /** Secondary-repo share as a fraction 0–1. */
  secondaryShare: number;
  /** Secondary-repo share as 0–100. */
  secondarySharePct: number;
  targetShare: number;
  minShare: number;
  maxShare: number;
  direction: 'above' | 'below';
  /** Human-readable warning naming the metric. */
  message: string;
}

export interface EffortSplitThresholds {
  /** Secondary-repo target share (default 0.20). */
  secondaryTargetShare: number;
  /** Allowed absolute deviation in share points (default 0.15 → band 5%–35%). */
  deviationPts: number;
}

export interface EffortSplitReport {
  schemaVersion: typeof EFFORT_SPLIT_SCHEMA;
  /** Calendar day (UTC) used as the JSONL upsert key. */
  date: string;
  windowHours: number;
  sinceIso: string;
  untilIso: string;
  primaryRepo: string;
  secondaryRepo: string;
  repos: RepoEffortMetrics[];
  metrics: EffortShareMetric[];
  deviations: EffortDeviation[];
  target: {
    primaryShare: number;
    secondaryShare: number;
    deviationPts: number;
    secondaryMinShare: number;
    secondaryMaxShare: number;
  };
  computedAt: string;
}

export interface ComputeEffortSplitInput {
  repos: RepoEffortMetrics[];
  /** End of window (inclusive upper bound for display). */
  now?: Date;
  windowHours?: number;
  primaryRepo?: string;
  secondaryRepo?: string;
  thresholds?: Partial<EffortSplitThresholds>;
  /** Override the UTC calendar day key (YYYY-MM-DD). */
  date?: string;
}

/** Share as 0–100 with one decimal place. Zero total → 0. */
export function sharePct(part: number, whole: number): number {
  if (!(whole > 0) || !(part >= 0)) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

export function resolveThresholds(
  overrides: Partial<EffortSplitThresholds> = {},
): EffortSplitThresholds & { secondaryMinShare: number; secondaryMaxShare: number } {
  const secondaryTargetShare =
    overrides.secondaryTargetShare ?? DEFAULT_SECONDARY_TARGET_SHARE;
  const deviationPts = overrides.deviationPts ?? DEFAULT_DEVIATION_PTS;
  const secondaryMinShare = Math.max(0, secondaryTargetShare - deviationPts);
  const secondaryMaxShare = Math.min(1, secondaryTargetShare + deviationPts);
  return {
    secondaryTargetShare,
    deviationPts,
    secondaryMinShare,
    secondaryMaxShare,
  };
}

function nonNegInt(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

function normalizeRepoMetrics(raw: RepoEffortMetrics): RepoEffortMetrics {
  const additions = raw.additions == null ? undefined : nonNegInt(raw.additions);
  const deletions = raw.deletions == null ? undefined : nonNegInt(raw.deletions);
  const linesFromParts =
    additions != null && deletions != null ? additions + deletions : undefined;
  return {
    repo: String(raw.repo).trim(),
    nonMergeCommits: nonNegInt(raw.nonMergeCommits),
    prsMerged: nonNegInt(raw.prsMerged),
    linesChanged: linesFromParts ?? nonNegInt(raw.linesChanged),
    ...(additions != null ? { additions } : {}),
    ...(deletions != null ? { deletions } : {}),
  };
}

/**
 * Pure: compute shares + deviation flags from already-gathered per-repo metrics.
 * Does not shell out to gh and does not touch the contribution ledger.
 */
export function computeEffortSplit(input: ComputeEffortSplitInput): EffortSplitReport {
  const now = input.now ?? new Date();
  const windowHours =
    input.windowHours != null && input.windowHours > 0
      ? input.windowHours
      : DEFAULT_WINDOW_HOURS;
  const untilMs = now.getTime();
  const sinceMs = untilMs - windowHours * 3_600_000;
  const untilIso = new Date(untilMs).toISOString();
  const sinceIso = new Date(sinceMs).toISOString();
  const date =
    input.date ??
    untilIso.slice(0, 10);

  const primaryRepo = input.primaryRepo ?? DEFAULT_PRIMARY_REPO;
  const secondaryRepo = input.secondaryRepo ?? DEFAULT_SECONDARY_REPO;
  const thresholds = resolveThresholds(input.thresholds);

  const repos = (input.repos ?? []).map(normalizeRepoMetrics).filter((r) => r.repo !== '');

  const metrics: EffortShareMetric[] = EFFORT_METRIC_KEYS.map((metric) => {
    const label = EFFORT_METRIC_LABELS[metric];
    const total = repos.reduce((sum, r) => sum + r[metric], 0);
    const byRepo: Record<string, EffortShareSlice> = {};
    for (const r of repos) {
      byRepo[r.repo] = {
        count: r[metric],
        sharePct: sharePct(r[metric], total),
      };
    }
    return { metric, label, total, byRepo };
  });

  const deviations: EffortDeviation[] = [];
  for (const m of metrics) {
    if (m.total <= 0) continue;
    const secondary = m.byRepo[secondaryRepo];
    if (!secondary) continue;
    const secondaryShare = secondary.count / m.total;
    if (secondaryShare > thresholds.secondaryMaxShare) {
      const secondarySharePct = sharePct(secondary.count, m.total);
      deviations.push({
        metric: m.metric,
        label: m.label,
        secondaryShare,
        secondarySharePct,
        targetShare: thresholds.secondaryTargetShare,
        minShare: thresholds.secondaryMinShare,
        maxShare: thresholds.secondaryMaxShare,
        direction: 'above',
        message:
          `DEVIATION: ${secondaryRepo} share of ${m.label} is ${formatPct(secondarySharePct)} ` +
          `(target ${formatPct(thresholds.secondaryTargetShare * 100)}, ` +
          `band ${formatPct(thresholds.secondaryMinShare * 100)}–${formatPct(thresholds.secondaryMaxShare * 100)}).`,
      });
    } else if (secondaryShare < thresholds.secondaryMinShare) {
      const secondarySharePct = sharePct(secondary.count, m.total);
      deviations.push({
        metric: m.metric,
        label: m.label,
        secondaryShare,
        secondarySharePct,
        targetShare: thresholds.secondaryTargetShare,
        minShare: thresholds.secondaryMinShare,
        maxShare: thresholds.secondaryMaxShare,
        direction: 'below',
        message:
          `DEVIATION: ${secondaryRepo} share of ${m.label} is ${formatPct(secondarySharePct)} ` +
          `(target ${formatPct(thresholds.secondaryTargetShare * 100)}, ` +
          `band ${formatPct(thresholds.secondaryMinShare * 100)}–${formatPct(thresholds.secondaryMaxShare * 100)}).`,
      });
    }
  }

  return {
    schemaVersion: EFFORT_SPLIT_SCHEMA,
    date,
    windowHours,
    sinceIso,
    untilIso,
    primaryRepo,
    secondaryRepo,
    repos,
    metrics,
    deviations,
    target: {
      primaryShare: 1 - thresholds.secondaryTargetShare,
      secondaryShare: thresholds.secondaryTargetShare,
      deviationPts: thresholds.deviationPts,
      secondaryMinShare: thresholds.secondaryMinShare,
      secondaryMaxShare: thresholds.secondaryMaxShare,
    },
    computedAt: untilIso,
  };
}

function formatPct(n: number): string {
  // Integers print without decimals; one-decimal otherwise.
  if (Number.isInteger(n)) return `${n}%`;
  return `${n.toFixed(1)}%`;
}

/**
 * Discord-ready section for the daily report. Prominent deviation warnings when
 * any metric falls outside the configured secondary-share band.
 */
export function formatEffortSplitSection(report: EffortSplitReport): string {
  const primaryTarget = Math.round(report.target.primaryShare * 100);
  const secondaryTarget = Math.round(report.target.secondaryShare * 100);
  const lines: string[] = [];
  lines.push(
    `**Effort split vs ${primaryTarget}/${secondaryTarget}** ` +
      `(target ${report.primaryRepo} ${primaryTarget}% / ${report.secondaryRepo} ${secondaryTarget}%)`,
  );
  lines.push(
    `_window ${report.windowHours}h · ${report.sinceIso.slice(0, 16)}Z → ${report.untilIso.slice(0, 16)}Z_`,
  );

  // Compact table: repo × three metrics with share %.
  const header =
    'repo'.padEnd(22) +
    'commits'.padStart(14) +
    'PRs'.padStart(14) +
    'lines'.padStart(16);
  lines.push('```');
  lines.push(header);
  for (const r of report.repos) {
    const commits = report.metrics.find((m) => m.metric === 'nonMergeCommits')?.byRepo[r.repo];
    const prs = report.metrics.find((m) => m.metric === 'prsMerged')?.byRepo[r.repo];
    const linesM = report.metrics.find((m) => m.metric === 'linesChanged')?.byRepo[r.repo];
    const cell = (slice: EffortShareSlice | undefined): string => {
      if (!slice) return '—';
      return `${slice.count} (${formatPct(slice.sharePct)})`;
    };
    lines.push(
      r.repo.padEnd(22) +
        cell(commits).padStart(14) +
        cell(prs).padStart(14) +
        cell(linesM).padStart(16),
    );
  }
  lines.push('```');

  if (report.deviations.length === 0) {
    lines.push(
      `✓ within band ` +
        `(${formatPct(report.target.secondaryMinShare * 100)}–${formatPct(report.target.secondaryMaxShare * 100)} ` +
        `${report.secondaryRepo} share on every metric)`,
    );
  } else {
    for (const d of report.deviations) {
      lines.push(`⚠️ **${d.message}**`);
    }
  }

  return lines.join('\n');
}

export function defaultEffortSplitPath(kookrDir?: string): string {
  const root = kookrDir ?? join(homedir(), '.kookr');
  return join(root, EFFORT_SPLIT_FILENAME);
}

/**
 * Persist one JSONL row per calendar day. Same-day re-run overwrites the existing
 * row for that date (does not append a duplicate). Atomic via temp + rename.
 */
export async function persistEffortSplit(
  filePath: string,
  report: EffortSplitReport,
): Promise<{ path: string; overwritten: boolean }> {
  await mkdir(dirname(filePath), { recursive: true });
  const existing = await readEffortSplitRows(filePath);
  const kept = existing.filter((row) => row.date !== report.date);
  const overwritten = kept.length !== existing.length;
  const next = [...kept, report];
  // Stable order by date for week-over-week grepping.
  next.sort((a, b) => a.date.localeCompare(b.date));
  const body = next.map((row) => JSON.stringify(row)).join('\n') + (next.length > 0 ? '\n' : '');
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  let renamed = false;
  try {
    await writeFile(tmp, body, 'utf8');
    await rename(tmp, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try { await unlink(tmp); } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  }
  return { path: filePath, overwritten };
}

export async function readEffortSplitRows(filePath: string): Promise<EffortSplitReport[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    throw err;
  }
  const rows: EffortSplitReport[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as EffortSplitReport;
      if (parsed && typeof parsed === 'object' && typeof parsed.date === 'string') {
        rows.push(parsed);
      }
    } catch {
      // Skip corrupt lines rather than fail the whole file.
    }
  }
  return rows;
}

/**
 * Parse optional share thresholds from env.
 * - `KOOKR_EFFORT_SPLIT_MIN` / `KOOKR_EFFORT_SPLIT_MAX`: secondary-share band (0–1 or 0–100).
 * - Or `KOOKR_EFFORT_SPLIT_TARGET` + `KOOKR_EFFORT_SPLIT_DEVIATION_PTS`.
 */
export function thresholdsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Partial<EffortSplitThresholds> {
  const out: Partial<EffortSplitThresholds> = {};
  const min = parseShare(env.KOOKR_EFFORT_SPLIT_MIN);
  const max = parseShare(env.KOOKR_EFFORT_SPLIT_MAX);
  if (min != null && max != null && max >= min) {
    // Reconstruct target as midpoint and deviation as half-width.
    // Round to 4 decimals so 5%–35% → target 0.2 / pts 0.15 exactly.
    out.secondaryTargetShare = roundShare((min + max) / 2);
    out.deviationPts = roundShare((max - min) / 2);
    return out;
  }
  const target = parseShare(env.KOOKR_EFFORT_SPLIT_TARGET);
  if (target != null) out.secondaryTargetShare = target;
  const pts = parseShare(env.KOOKR_EFFORT_SPLIT_DEVIATION_PTS);
  if (pts != null) out.deviationPts = pts;
  return out;
}

function parseShare(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  // Accept either 0–1 fractions or 0–100 percentages.
  if (n > 1) return Math.min(1, n / 100);
  return n;
}

function roundShare(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
