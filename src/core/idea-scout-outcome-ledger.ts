/**
 * Idea-scout cross-run outcome ledger helpers (issue #1758).
 *
 * The scout already stamps `idea-scout` + `idea:<n>` provenance labels on every
 * published idea issue so conversion is computable from labels alone
 * (issue #1587). Nothing consumed those labels across runs: the scout optimized
 * for "reads well in an issue," not "gets shipped."
 *
 * This module is the pure math for:
 *   1. classifying a published idea's terminal outcome from issue + PR state;
 *   2. rolling up per-dimension conversion rates for the run summary;
 *   3. a *bounded* conversion credit used as a secondary term in the
 *      coverage-ordered dimension rotation (issue #1749 / #1759), so dimensions
 *      whose ideas actually convert earn modestly more slots — without
 *      reintroducing the starvation loop coverage rotation fixed.
 *
 * The playbook owns the durable file shape and the `gh` refresh/record steps;
 * these helpers stay side-effect free so contract tests can pin the formulas.
 */

/** Terminal (or still-in-flight) outcome of one published idea issue. */
export type IdeaTerminalOutcome =
  | 'merged-pr'
  | 'closed-unimplemented'
  | 'open-aged'
  | 'open';

/** One published idea as stored in the repo-level outcome ledger. */
export interface IdeaOutcomeEntry {
  issueNumber: number;
  /** Diversity dimension (ideas-log `category`) at publish time. */
  dimension: string;
  authority: string;
  publishedAt: string;
  outcome: IdeaTerminalOutcome;
  outcomeAt: string;
  mergedPrNumber?: number | null;
}

/** Per-dimension conversion rollup for the run-summary report. */
export interface DimensionConversionStats {
  dimension: string;
  published: number;
  merged: number;
  closedUnimplemented: number;
  openAged: number;
  open: number;
  /**
   * `merged / published`. Zero when nothing has been published in this
   * dimension yet (avoids NaN; not a claim that conversion is "bad").
   */
  conversionRate: number;
}

/** Defaults shared with the playbook shell/jq snippets — keep in sync. */
export const DEFAULT_OPEN_AGED_DAYS = 14;
/** Max reduction of `coveredCount` a dimension can earn from conversion. */
export const DEFAULT_CONVERSION_CREDIT_CAP = 1;
/** Scales conversionRate into a credit before the cap is applied. */
export const DEFAULT_CONVERSION_WEIGHT = 1;
/**
 * Below this many published ideas in a dimension, conversion is ignored for
 * rotation weighting (noise floor). The conversion *report* still shows the
 * raw rate at any sample size.
 */
export const DEFAULT_MIN_SAMPLES_FOR_CONVERSION_WEIGHT = 2;

export interface ClassifyIdeaOutcomeInput {
  issueState: 'open' | 'closed';
  /** True when a merged PR carries the matching `idea:<n>` join label. */
  hasMergedPr: boolean;
  /** Whole days since the idea issue was created / published. */
  ageDays: number;
  openAgedDays?: number;
}

/**
 * Derive the terminal outcome for one published idea from live GitHub state.
 *
 * Precedence: a merged join-key PR always wins (even if the issue is still
 * open — some workflows leave the idea issue open after merge). Closed without
 * a merged join PR is `closed-unimplemented`. Still-open past the age threshold
 * is `open-aged`. Otherwise `open`.
 */
export function classifyIdeaOutcome(input: ClassifyIdeaOutcomeInput): IdeaTerminalOutcome {
  if (input.hasMergedPr) return 'merged-pr';
  if (input.issueState === 'closed') return 'closed-unimplemented';
  const threshold = input.openAgedDays ?? DEFAULT_OPEN_AGED_DAYS;
  const age = Number.isFinite(input.ageDays) ? Math.max(0, input.ageDays) : 0;
  if (age >= threshold) return 'open-aged';
  return 'open';
}

/**
 * Roll idea outcomes up by dimension. Dimensions are ordered by first
 * appearance in the input (stable) so report lines don't thrash run-to-run.
 */
export function aggregateDimensionConversion(
  ideas: Iterable<Pick<IdeaOutcomeEntry, 'dimension' | 'outcome'>>,
): DimensionConversionStats[] {
  const byDim = new Map<
    string,
    {
      published: number;
      merged: number;
      closedUnimplemented: number;
      openAged: number;
      open: number;
    }
  >();
  const order: string[] = [];

  for (const idea of ideas) {
    const dim =
      typeof idea.dimension === 'string' && idea.dimension.length > 0
        ? idea.dimension
        : 'unknown';
    let row = byDim.get(dim);
    if (!row) {
      row = {
        published: 0,
        merged: 0,
        closedUnimplemented: 0,
        openAged: 0,
        open: 0,
      };
      byDim.set(dim, row);
      order.push(dim);
    }
    row.published += 1;
    switch (idea.outcome) {
      case 'merged-pr':
        row.merged += 1;
        break;
      case 'closed-unimplemented':
        row.closedUnimplemented += 1;
        break;
      case 'open-aged':
        row.openAged += 1;
        break;
      case 'open':
        row.open += 1;
        break;
      default: {
        // Exhaustive: treat unexpected values as still-open so a bad record
        // never inflates conversion.
        const _exhaustive: never = idea.outcome;
        void _exhaustive;
        row.open += 1;
      }
    }
  }

  return order.map((dimension) => {
    const row = byDim.get(dimension)!;
    return {
      dimension,
      ...row,
      conversionRate: row.published === 0 ? 0 : row.merged / row.published,
    };
  });
}

export interface ConversionCreditOptions {
  weight?: number;
  cap?: number;
  minSamples?: number;
}

/**
 * Bounded conversion credit to *subtract* from `coveredCount` when ordering
 * the rotation. High-converting dimensions sort slightly earlier (earn modestly
 * more slots). The credit is hard-capped so conversion can never dominate the
 * coverage term — one fully-converting dimension only shaves
 * {@link DEFAULT_CONVERSION_CREDIT_CAP} off its coveredCount, which is the
 * floor that keeps exploration from starving low-conversion dimensions.
 *
 * Returns 0 when the sample is below {@link DEFAULT_MIN_SAMPLES_FOR_CONVERSION_WEIGHT}
 * so a single lucky merge cannot re-bias rotation.
 */
export function conversionSortCredit(
  stats: Pick<DimensionConversionStats, 'published' | 'conversionRate'>,
  opts: ConversionCreditOptions = {},
): number {
  const weight = opts.weight ?? DEFAULT_CONVERSION_WEIGHT;
  const cap = opts.cap ?? DEFAULT_CONVERSION_CREDIT_CAP;
  const minSamples = opts.minSamples ?? DEFAULT_MIN_SAMPLES_FOR_CONVERSION_WEIGHT;
  const published = Number.isFinite(stats.published) ? Math.max(0, Math.floor(stats.published)) : 0;
  if (published < minSamples) return 0;
  const rate = Number.isFinite(stats.conversionRate)
    ? Math.min(1, Math.max(0, stats.conversionRate))
    : 0;
  const raw = weight * rate;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(cap, raw);
}

/** Effective rotation key: lower sorts first (least covered / modest conversion boost). */
export function rotationSortKey(coveredCount: number, conversionCredit: number): number {
  const covered = Number.isFinite(coveredCount) ? Math.max(0, coveredCount) : 0;
  const credit = Number.isFinite(conversionCredit) ? Math.max(0, conversionCredit) : 0;
  return covered - credit;
}

/**
 * Order dimensions by ascending effective coverage (coveredCount − conversion
 * credit). Ties keep the input (canonical) order — `sort` is stable in modern
 * JS / matches jq's stable `sort_by`.
 */
export function orderDimensionsByCoverageAndConversion(
  dimensions: readonly string[],
  coverage: Readonly<Record<string, { coveredCount?: number } | undefined>>,
  conversionByDim: Readonly<
    Record<string, Pick<DimensionConversionStats, 'published' | 'conversionRate'> | undefined>
  >,
  opts?: ConversionCreditOptions,
): string[] {
  return dimensions
    .map((dim, index) => {
      const coveredCount = coverage[dim]?.coveredCount ?? 0;
      const stats = conversionByDim[dim] ?? { published: 0, conversionRate: 0 };
      const credit = conversionSortCredit(stats, opts);
      return {
        dim,
        index,
        key: rotationSortKey(coveredCount, credit),
      };
    })
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .map((row) => row.dim);
}

/**
 * One human-readable summary line for the portfolio report. Empty ledger → a
 * stable "none" sentence so Phase 8 can require the line without special cases.
 */
export function formatConversionSummaryLine(stats: readonly DimensionConversionStats[]): string {
  if (stats.length === 0) {
    return 'Conversion rates: none (no published idea outcomes yet)';
  }
  let published = 0;
  let merged = 0;
  const parts: string[] = [];
  for (const s of stats) {
    // Skip the unknown bucket from the per-dim list in the summary line; it
    // still contributes to the overall totals.
    if (s.dimension !== 'unknown') {
      const pct = Math.round(s.conversionRate * 100);
      parts.push(`${s.dimension} ${pct}% (${s.merged}/${s.published})`);
    }
    published += s.published;
    merged += s.merged;
  }
  const overallPct = published === 0 ? 0 : Math.round((merged / published) * 100);
  const overall = `overall ${overallPct}% (${merged}/${published})`;
  if (parts.length === 0) {
    return `Conversion rates: ${overall}`;
  }
  return `Conversion rates: ${parts.join('; ')}; ${overall}`;
}

/** Schema-shape check matching the playbook's self-heal guard. */
export function isValidIdeaOutcomeLedger(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.ideas !== 'object' || obj.ideas === null || Array.isArray(obj.ideas)) {
    return false;
  }
  if (!Array.isArray(obj.recordedRuns) || !Array.isArray(obj.refreshedRuns)) {
    return false;
  }
  for (const value of Object.values(obj.ideas as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) return false;
    const entry = value as Record<string, unknown>;
    if (typeof entry.issueNumber !== 'number' || !Number.isFinite(entry.issueNumber)) {
      return false;
    }
    if (typeof entry.dimension !== 'string') return false;
    if (typeof entry.outcome !== 'string') return false;
  }
  return true;
}

export function emptyIdeaOutcomeLedger(): {
  ideas: Record<string, never>;
  recordedRuns: string[];
  refreshedRuns: string[];
} {
  return { ideas: {}, recordedRuns: [], refreshedRuns: [] };
}
