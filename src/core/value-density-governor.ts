/**
 * Value-density governor (issue #1846).
 *
 * Caps cosmetic-refactor / architecture-drift emission and spawn so a window of
 * high PR count is not mostly "share tinyHelper" consolidations while product
 * metric-blocking work starves. Pure math only — callers (CLI, playbooks,
 * orchestrators) gather live GitHub / ledger evidence and hand it here.
 *
 * Two complementary gates (both apply to cosmetic refactors; the cap is hard
 * for every refactor-class admit):
 *   1. Per-window refactor-class cap (default ≤4 admits) — hard ceiling
 *   2. Minimum drift-score-delta threshold (default 1.0) for cosmetic
 *      consolidations when a numeric score is supplied; cosmetics without a
 *      score are declined even when budget remains
 *
 * Sub-threshold cosmetic consolidations are declined with a stable reason code
 * so the next reflection can observe them. Surplus capacity is redirected to
 * product-metric-blocking candidates when the caller supplies a ranked pool.
 *
 * Composition metrics (refactor share, value-advancing count) make the
 * vanity-inflated flat PR-count target measurable against real mix.
 */

export const VALUE_DENSITY_SCHEMA = 'value-density.v1' as const;

/** Sliding window for refactor-class caps and composition (hours). */
export const DEFAULT_WINDOW_HOURS = 24;

/**
 * Max refactor-class admits (issue file OR implementation spawn) per window.
 * Matches the issue's "≤3–5" band; 4 is the safe mid default.
 */
export const DEFAULT_MAX_REFACTOR_PER_WINDOW = 4;

/**
 * When a candidate carries a numeric drift-score-delta, it must meet this
 * floor to clear the cosmetic bar. Callers that omit the score still go
 * through the cap gate (and the cosmetic-title patterns).
 */
export const DEFAULT_MIN_DRIFT_SCORE_DELTA = 1.0;

/**
 * Soft composition target: value-advancing PRs/window the reflection should
 * treat as the health signal alongside (not instead of) raw count.
 */
export const DEFAULT_VALUE_ADVANCING_TARGET_PER_DAY = 3;

/** Labels that mark an issue as product-metric-blocking (case-insensitive). */
export const DEFAULT_PRODUCT_METRIC_LABELS: readonly string[] = Object.freeze([
  'product-metric',
  'metric-blocking',
  'headline-metric',
  'sec-anchor',
  'sec-acceptance',
  // Acquisition / failover umbrellas (lucy#1587) rank with product metrics so
  // idle capacity is not spent on harness polish while report-fetch work waits.
  'acquisition',
]);

/**
 * Conventional-commit / issue work classes used for composition.
 * `arch` is treated as a refactor-class subclass (architecture-health-check
 * titles like `arch: share cleanHtmlText`).
 */
export type WorkClass =
  | 'feat'
  | 'fix'
  | 'refactor'
  | 'docs'
  | 'test'
  | 'chore'
  | 'perf'
  | 'ops'
  | 'other';

/** Classes counted against the refactor-class cap. */
export const REFACTOR_CLASSES: readonly WorkClass[] = Object.freeze(['refactor']);

/**
 * Classes that advance a product outcome rather than harness cosmetics.
 * `ops` is included because deploy/convergence fixes deliver user-visible value.
 */
export const VALUE_ADVANCING_CLASSES: readonly WorkClass[] = Object.freeze([
  'feat',
  'fix',
  'perf',
  'ops',
]);

export type AdmissionAction = 'admit' | 'decline' | 'redirect';

export type DeclineReasonCode =
  | 'refactor_cap_reached'
  | 'cosmetic_subthreshold'
  | 'drift_score_below_min'
  | 'not_applicable';

export interface ValueDensityConfig {
  maxRefactorPerWindow: number;
  minDriftScoreDelta: number;
  windowHours: number;
  valueAdvancingTargetPerDay: number;
  productMetricLabels: readonly string[];
}

export const DEFAULT_VALUE_DENSITY_CONFIG: Readonly<ValueDensityConfig> = Object.freeze({
  maxRefactorPerWindow: DEFAULT_MAX_REFACTOR_PER_WINDOW,
  minDriftScoreDelta: DEFAULT_MIN_DRIFT_SCORE_DELTA,
  windowHours: DEFAULT_WINDOW_HOURS,
  valueAdvancingTargetPerDay: DEFAULT_VALUE_ADVANCING_TARGET_PER_DAY,
  productMetricLabels: DEFAULT_PRODUCT_METRIC_LABELS,
});

export interface WorkItemInput {
  title: string;
  /** Label names only. */
  labels?: readonly string[];
  body?: string | null;
  /**
   * Optional drift-score improvement claimed for a consolidation. When
   * present, the min-delta gate applies; when absent, only the cap +
   * cosmetic-title heuristics apply.
   */
  driftScoreDelta?: number | null;
}

export interface WindowState {
  /**
   * How many refactor-class items have already been admitted in this window
   * (filed issues + spawned implementation tasks + merged refactor PRs —
   * whichever the caller wants to count; the governor is agnostic).
   */
  refactorAdmitted: number;
}

export interface Classification {
  workClass: WorkClass;
  /** True when title/body match one-helper-per-PR cosmetic consolidation patterns. */
  cosmetic: boolean;
  /** True when labels/title indicate a product-metric-blocking issue. */
  productMetricBlocking: boolean;
  /** True when workClass is in REFACTOR_CLASSES (or arch: titles classified as refactor). */
  refactorClass: boolean;
  /** True when the item advances product value (class or product-metric label). */
  valueAdvancing: boolean;
}

export interface AdmissionVerdict {
  schemaVersion: typeof VALUE_DENSITY_SCHEMA;
  action: AdmissionAction;
  reasonCode: DeclineReasonCode | 'admitted' | 'redirected_to_product_metric';
  /** Human-readable reason for the next reflection / JSONL log. */
  reason: string;
  classification: Classification;
  config: Pick<ValueDensityConfig, 'maxRefactorPerWindow' | 'minDriftScoreDelta'>;
  window: {
    refactorAdmitted: number;
    remainingRefactorBudget: number;
  };
}

export interface CompositionBucket {
  count: number;
  /** 0–100, one decimal. */
  sharePct: number;
}

export interface CompositionReport {
  schemaVersion: typeof VALUE_DENSITY_SCHEMA;
  total: number;
  byClass: Record<WorkClass, CompositionBucket>;
  refactorCount: number;
  refactorSharePct: number | null;
  cosmeticRefactorCount: number;
  valueAdvancingCount: number;
  valueAdvancingSharePct: number | null;
  productMetricBlockingCount: number;
  valueAdvancingTargetPerDay: number;
  /**
   * valueAdvancing vs target scaled to the window. Null only when the target
   * for the window is 0; empty windows with a positive target report `0`.
   */
  valueAdvancingAttainmentPct: number | null;
  windowHours: number;
}

export interface DeclineRecord {
  schemaVersion: typeof VALUE_DENSITY_SCHEMA;
  ts: string;
  repo: string;
  title: string;
  source: string;
  reasonCode: DeclineReasonCode | string;
  reason: string;
  workClass: WorkClass;
  cosmetic: boolean;
  productMetricBlocking: boolean;
  driftScoreDelta?: number | null;
  bodyPreview?: string | null;
}

export interface RankedCandidate extends WorkItemInput {
  /** Stable id for the caller (issue number, finding id, …). */
  id: string;
  /** Higher = preferred when filling surplus. Optional. */
  priority?: number;
}

export interface SelectionResult {
  admitted: Array<RankedCandidate & { classification: Classification; reason: string }>;
  declined: Array<
    RankedCandidate & {
      classification: Classification;
      reasonCode: DeclineReasonCode;
      reason: string;
    }
  >;
  /** Product-metric candidates admitted from surplus after refactor declines. */
  redirected: Array<RankedCandidate & { classification: Classification; reason: string }>;
  finalRefactorAdmitted: number;
}

const WORK_CLASSES: readonly WorkClass[] = [
  'feat',
  'fix',
  'refactor',
  'docs',
  'test',
  'chore',
  'perf',
  'ops',
  'other',
] as const;

/** Conventional-commit prefix, including `arch:` as a refactor synonym. */
const CLASS_PREFIX_RE =
  /^(feat|fix|refactor|docs|test|chore|perf|ops|arch|ci|build|style|revert)(\([^)]+\))?!?:\s*/i;

/**
 * Title patterns that mark one-helper-per-PR cosmetic consolidations — the
 * exact class of work that dominated the 2026-08-01 Lucy window.
 */
const COSMETIC_TITLE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bshare\s+\w+/i,
  /\bextract\s+shared\b/i,
  /\bconsolidate\s+\w+/i,
  /\bexport\s+one\b/i,
  /\bdump[- ]?barrel\b/i,
  /\bre-?exports?\b/i,
  /\bstop\s+dump[- ]?barrel\b/i,
  // Bare "helper" alone is too broad (kills legitimate arch issues); only
  // match the one-helper-per-PR shapes that dominated the 2026-08-01 window.
  /\b(one|shared|tiny)\s+helper\b/i,
  /\bhelper\s+(fn|function|util|module)\b/i,
  /\bclip\s*\(/i,
  /\bisoNow\b/i,
  /\bthrowIfAborted\b/i,
  /\bhostOf\b/i,
  /\bsha256Hex\b/i,
  /\bcleanHtmlText\b/i,
  /\bwrapUntrustedFence\b/i,
  /\bparseTickerArgs\b/i,
]);

const PRODUCT_METRIC_TITLE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bproduct[- ]metric\b/i,
  /\bmetric[- ]blocking\b/i,
  /\bsec[- ]?anchor\b/i,
  /\bsec[- ]acceptance\b/i,
  /\bedgar\b/i,
  /\bearnings[- ]detection\b/i,
  /\bheadline[- ]metric\b/i,
  // Product-facing acquisition / failover (queue-feeder ranking for lucy#1587+)
  /\bacquisition\b/i,
  /\bfailover\b/i,
  /\bnewswire\b/i,
]);
function emptyByClass(): Record<WorkClass, CompositionBucket> {
  const out = {} as Record<WorkClass, CompositionBucket>;
  for (const c of WORK_CLASSES) {
    out[c] = { count: 0, sharePct: 0 };
  }
  return out;
}

function sharePct(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function hasAnyLabel(
  labels: readonly string[] | undefined,
  wanted: readonly string[],
): boolean {
  if (!labels || labels.length === 0) return false;
  const set = new Set(wanted.map(normalizeLabel));
  return labels.some((l) => set.has(normalizeLabel(l)));
}

/**
 * Map a free-form conventional-commit / issue title to a {@link WorkClass}.
 * `arch:` and bare architecture-health titles count as `refactor`.
 */
export function classifyWorkClass(title: string, labels?: readonly string[]): WorkClass {
  const t = (title ?? '').trim();
  const m = CLASS_PREFIX_RE.exec(t);
  if (m) {
    const raw = m[1]!.toLowerCase();
    if (raw === 'arch' || raw === 'style') return 'refactor';
    if (raw === 'ci' || raw === 'build') return 'chore';
    if (raw === 'revert') return 'other';
    if ((WORK_CLASSES as readonly string[]).includes(raw)) return raw as WorkClass;
  }

  // Architecture-health-check titles often start with "arch:" already handled;
  // also catch un-prefixed "arch " / label-based hints.
  if (/^arch\b/i.test(t) || hasAnyLabel(labels, ['architecture', 'arch', 'refactor'])) {
    return 'refactor';
  }
  if (hasAnyLabel(labels, ['bug', 'fix'])) return 'fix';
  if (hasAnyLabel(labels, ['enhancement', 'feature', 'feat'])) return 'feat';
  if (hasAnyLabel(labels, ['documentation', 'docs'])) return 'docs';
  if (hasAnyLabel(labels, ['test', 'testing'])) return 'test';
  if (hasAnyLabel(labels, ['perf', 'performance'])) return 'perf';
  if (hasAnyLabel(labels, ['ops', 'deploy', 'infra'])) return 'ops';
  if (hasAnyLabel(labels, ['chore'])) return 'chore';

  // Heuristic fallbacks for common free-form titles.
  if (/\b(refactor|dedup|dedupe|consolidat|extract shared|share )\b/i.test(t)) {
    return 'refactor';
  }
  if (/\b(fix|bug|regress)\b/i.test(t)) return 'fix';
  if (/\b(feat|feature|add |implement )\b/i.test(t)) return 'feat';

  return 'other';
}

/** True when the title/body looks like a one-helper cosmetic consolidation. */
export function isCosmeticRefactor(title: string, body?: string | null): boolean {
  const hay = `${title ?? ''}\n${body ?? ''}`;
  return COSMETIC_TITLE_PATTERNS.some((re) => re.test(hay));
}

/** True when labels or title mark product-metric-blocking work. */
export function isProductMetricBlocking(
  title: string,
  labels?: readonly string[],
  productMetricLabels: readonly string[] = DEFAULT_PRODUCT_METRIC_LABELS,
): boolean {
  if (hasAnyLabel(labels, productMetricLabels)) return true;
  const t = title ?? '';
  return PRODUCT_METRIC_TITLE_PATTERNS.some((re) => re.test(t));
}

export function mergeConfig(
  overrides?: Partial<ValueDensityConfig>,
): ValueDensityConfig {
  return {
    ...DEFAULT_VALUE_DENSITY_CONFIG,
    ...overrides,
    productMetricLabels:
      overrides?.productMetricLabels ?? DEFAULT_VALUE_DENSITY_CONFIG.productMetricLabels,
  };
}

/** Full classification for one work item. */
export function classifyWorkItem(
  item: WorkItemInput,
  config?: Partial<ValueDensityConfig>,
): Classification {
  const cfg = mergeConfig(config);
  const workClass = classifyWorkClass(item.title, item.labels);
  const cosmetic = isCosmeticRefactor(item.title, item.body);
  const productMetricBlocking = isProductMetricBlocking(
    item.title,
    item.labels,
    cfg.productMetricLabels,
  );
  const refactorClass = REFACTOR_CLASSES.includes(workClass);
  const valueAdvancing =
    productMetricBlocking || VALUE_ADVANCING_CLASSES.includes(workClass);
  return {
    workClass,
    cosmetic,
    productMetricBlocking,
    refactorClass,
    valueAdvancing,
  };
}

/**
 * Decide whether a single candidate may be filed/spawned under the governor.
 *
 * Non-refactor-class candidates are always admitted (reason `not_applicable`
 * only appears if somehow declined — currently never for non-refactor).
 * Product-metric-blocking candidates always admit even when refactor-shaped
 * (they are the surplus sink, not the vanity source).
 */
export function evaluateAdmission(
  item: WorkItemInput,
  window: WindowState,
  config?: Partial<ValueDensityConfig>,
): AdmissionVerdict {
  const cfg = mergeConfig(config);
  const classification = classifyWorkItem(item, cfg);
  const remaining = Math.max(0, cfg.maxRefactorPerWindow - window.refactorAdmitted);
  const base = {
    schemaVersion: VALUE_DENSITY_SCHEMA,
    classification,
    config: {
      maxRefactorPerWindow: cfg.maxRefactorPerWindow,
      minDriftScoreDelta: cfg.minDriftScoreDelta,
    },
    window: {
      refactorAdmitted: window.refactorAdmitted,
      remainingRefactorBudget: remaining,
    },
  } as const;

  // Product-metric-blocking work always clears the governor — it is the
  // intended sink for surplus capacity.
  if (classification.productMetricBlocking) {
    return {
      ...base,
      action: 'admit',
      reasonCode: 'admitted',
      reason: 'product-metric-blocking — exempt from refactor-class cap',
    };
  }

  if (!classification.refactorClass) {
    return {
      ...base,
      action: 'admit',
      reasonCode: 'admitted',
      reason: `non-refactor class (${classification.workClass}) — governor does not cap`,
    };
  }

  // Drift-score gate: when a score is supplied and clears the floor, admit
  // even at the cap? No — the cap is hard; the score is an additional bar for
  // cosmetic candidates *inside* the budget. A strong delta still consumes a
  // budget slot; a weak/missing delta on a cosmetic title is declined even
  // when budget remains (so the budget is reserved for non-cosmetic refactors).
  const delta =
    item.driftScoreDelta == null || !Number.isFinite(Number(item.driftScoreDelta))
      ? null
      : Number(item.driftScoreDelta);

  if (classification.cosmetic) {
    if (delta == null || delta < cfg.minDriftScoreDelta) {
      return {
        ...base,
        action: 'decline',
        reasonCode: delta == null ? 'cosmetic_subthreshold' : 'drift_score_below_min',
        reason:
          delta == null
            ? `cosmetic refactor declined (no drift-score-delta; min ${cfg.minDriftScoreDelta})`
            : `cosmetic refactor declined (drift-score-delta ${delta} < min ${cfg.minDriftScoreDelta})`,
      };
    }
  }

  if (window.refactorAdmitted >= cfg.maxRefactorPerWindow) {
    return {
      ...base,
      action: 'decline',
      reasonCode: 'refactor_cap_reached',
      reason: `refactor-class cap reached (${window.refactorAdmitted}/${cfg.maxRefactorPerWindow} in window)`,
    };
  }

  // Post-admit remaining budget so callers that trust the field do not
  // over-admit by one when they re-read the verdict.
  const remainingAfter = Math.max(0, remaining - 1);
  return {
    ...base,
    action: 'admit',
    reasonCode: 'admitted',
    window: {
      refactorAdmitted: window.refactorAdmitted + 1,
      remainingRefactorBudget: remainingAfter,
    },
    reason:
      delta != null
        ? `refactor admitted (budget ${remainingAfter} remaining after; drift-score-delta ${delta})`
        : `refactor admitted (budget ${remainingAfter} remaining after)`,
  };
}

/**
 * Rank-and-select a pool: apply the governor per candidate in priority order,
 * and when a refactor is declined, fill the freed slot with the next
 * product-metric-blocking candidate that has not yet been considered
 * ("surplus capacity offered to product-metric-blocking issues").
 *
 * Priority: higher `priority` first, then product-metric-blocking, then
 * non-refactor, then refactor. Stable by input order within a tier.
 */
export function selectCandidates(
  candidates: readonly RankedCandidate[],
  window: WindowState,
  config?: Partial<ValueDensityConfig>,
): SelectionResult {
  const cfg = mergeConfig(config);
  const indexed = candidates.map((c, i) => ({ c, i }));
  indexed.sort((a, b) => {
    const pa = a.c.priority ?? 0;
    const pb = b.c.priority ?? 0;
    if (pb !== pa) return pb - pa;
    const ca = classifyWorkItem(a.c, cfg);
    const cb = classifyWorkItem(b.c, cfg);
    const score = (x: Classification) =>
      (x.productMetricBlocking ? 4 : 0) +
      (x.valueAdvancing && !x.refactorClass ? 2 : 0) +
      (x.refactorClass ? 0 : 1);
    const sa = score(ca);
    const sb = score(cb);
    if (sb !== sa) return sb - sa;
    return a.i - b.i;
  });

  let refactorAdmitted = window.refactorAdmitted;
  const admitted: SelectionResult['admitted'] = [];
  const declined: SelectionResult['declined'] = [];
  const redirected: SelectionResult['redirected'] = [];
  const seen = new Set<string>();

  // First pass: evaluate in ranked order.
  const pendingProduct: RankedCandidate[] = [];
  for (const { c } of indexed) {
    if (seen.has(c.id)) continue;
    const classification = classifyWorkItem(c, cfg);
    // Hold product-metric items for surplus fill after we know which
    // refactors declined — but still admit them immediately if we would
    // admit them on their own (they always clear evaluateAdmission).
    if (classification.productMetricBlocking && !classification.refactorClass) {
      pendingProduct.push(c);
      continue;
    }
    const verdict = evaluateAdmission(c, { refactorAdmitted }, cfg);
    if (verdict.action === 'admit') {
      seen.add(c.id);
      admitted.push({ ...c, classification, reason: verdict.reason });
      if (classification.refactorClass && !classification.productMetricBlocking) {
        refactorAdmitted += 1;
      }
    } else {
      seen.add(c.id);
      declined.push({
        ...c,
        classification,
        reasonCode: verdict.reasonCode as DeclineReasonCode,
        reason: verdict.reason,
      });
    }
  }

  // Surplus: for each declined refactor, offer one product-metric candidate.
  const surplusSlots = declined.filter((d) => d.classification.refactorClass).length;
  let filled = 0;
  for (const c of pendingProduct) {
    if (seen.has(c.id)) continue;
    const classification = classifyWorkItem(c, cfg);
    // Always admit product-metric; count as redirect when filling surplus
    // from a declined refactor, otherwise as a normal admit.
    seen.add(c.id);
    if (filled < surplusSlots) {
      redirected.push({
        ...c,
        classification,
        reason: `surplus capacity after refactor decline → product-metric-blocking (${c.id})`,
      });
      filled += 1;
    } else {
      admitted.push({
        ...c,
        classification,
        reason: 'product-metric-blocking — admitted in ranked pass',
      });
    }
  }

  return {
    admitted,
    declined,
    redirected,
    finalRefactorAdmitted: refactorAdmitted,
  };
}

/** Compose a window of titles/PRs into a measurable mix report. */
export function computeComposition(
  items: readonly WorkItemInput[],
  options?: {
    windowHours?: number;
    valueAdvancingTargetPerDay?: number;
    config?: Partial<ValueDensityConfig>;
  },
): CompositionReport {
  const cfg = mergeConfig(options?.config);
  const windowHours = options?.windowHours ?? cfg.windowHours;
  const targetPerDay =
    options?.valueAdvancingTargetPerDay ?? cfg.valueAdvancingTargetPerDay;
  const byClass = emptyByClass();
  let cosmeticRefactorCount = 0;
  let productMetricBlockingCount = 0;
  let valueAdvancingCount = 0;
  let refactorCount = 0;

  for (const item of items) {
    const c = classifyWorkItem(item, cfg);
    byClass[c.workClass].count += 1;
    if (c.refactorClass) refactorCount += 1;
    if (c.cosmetic && c.refactorClass) cosmeticRefactorCount += 1;
    if (c.productMetricBlocking) productMetricBlockingCount += 1;
    if (c.valueAdvancing) valueAdvancingCount += 1;
  }

  const total = items.length;
  for (const k of WORK_CLASSES) {
    byClass[k].sharePct = sharePct(byClass[k].count, total) ?? 0;
  }

  const days = windowHours > 0 ? windowHours / 24 : 1;
  const targetForWindow = targetPerDay * days;
  const valueAdvancingAttainmentPct =
    targetForWindow > 0
      ? Math.round((valueAdvancingCount / targetForWindow) * 1000) / 10
      : null;

  return {
    schemaVersion: VALUE_DENSITY_SCHEMA,
    total,
    byClass,
    refactorCount,
    refactorSharePct: sharePct(refactorCount, total),
    cosmeticRefactorCount,
    valueAdvancingCount,
    valueAdvancingSharePct: sharePct(valueAdvancingCount, total),
    productMetricBlockingCount,
    valueAdvancingTargetPerDay: targetPerDay,
    valueAdvancingAttainmentPct,
    windowHours,
  };
}

/** One-line composition summary for Discord / reflection. */
export function formatCompositionLine(report: CompositionReport, repo?: string): string {
  const repoBit = repo ? `${repo}: ` : '';
  const refactor =
    report.refactorSharePct == null
      ? 'n/a'
      : `${report.refactorCount}/${report.total} (${report.refactorSharePct}%)`;
  const value =
    report.valueAdvancingSharePct == null
      ? 'n/a'
      : `${report.valueAdvancingCount}/${report.total} (${report.valueAdvancingSharePct}%)`;
  const attain =
    report.valueAdvancingAttainmentPct == null
      ? ''
      : ` · value-target ${report.valueAdvancingAttainmentPct}%`;
  return (
    `${repoBit}composition ${report.windowHours}h — refactor ${refactor}, ` +
    `value-advancing ${value}, cosmetic-refactor ${report.cosmeticRefactorCount}, ` +
    `product-metric ${report.productMetricBlockingCount}${attain}`
  );
}

/** Build a durable decline record for the deferred / declined JSONL. */
export function buildDeclineRecord(input: {
  repo: string;
  title: string;
  source: string;
  reasonCode: DeclineReasonCode | string;
  reason: string;
  workClass: WorkClass;
  cosmetic: boolean;
  productMetricBlocking: boolean;
  driftScoreDelta?: number | null;
  bodyPreview?: string | null;
  now?: Date;
}): DeclineRecord {
  return {
    schemaVersion: VALUE_DENSITY_SCHEMA,
    ts: (input.now ?? new Date()).toISOString(),
    repo: input.repo,
    title: input.title,
    source: input.source,
    reasonCode: input.reasonCode,
    reason: input.reason,
    workClass: input.workClass,
    cosmetic: input.cosmetic,
    productMetricBlocking: input.productMetricBlocking,
    driftScoreDelta: input.driftScoreDelta ?? null,
    bodyPreview: input.bodyPreview ?? null,
  };
}

/** Path for the append-only declined-ideas ledger (observable by reflection). */
export function declinedIdeasPath(repo: string, kookrDir: string): string {
  const safe = repo.replace(/[^A-Za-z0-9_.-]+/g, '--');
  return `${kookrDir.replace(/\/+$/, '')}/playbook-state/value-density/declined/${safe}.jsonl`;
}

/** Path for the per-day composition snapshot (trendable). */
export function compositionSnapshotPath(repo: string, kookrDir: string): string {
  const safe = repo.replace(/[^A-Za-z0-9_.-]+/g, '--');
  return `${kookrDir.replace(/\/+$/, '')}/playbook-state/value-density/composition/${safe}.jsonl`;
}
