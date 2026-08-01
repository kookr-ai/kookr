/**
 * Queue-feeder / umbrella auto-decomposer (issue #1845).
 *
 * When the orchestration loop reports idle capacity with an empty queue
 * (`free >= threshold` AND `pendingQueueDepth == 0`), abundant product work
 * often exists but is not *spawnable*: it sits inside large undecomposed
 * "product umbrella" issues (e.g. lucy#1588 "anchor truth — SEC acceptance
 * anchors"). Decomposition — shredding one umbrella into 3–5 vetted leaf tasks
 * with a crisp goal + acceptance criteria — was an unowned capability. This
 * module makes it a deterministic, testable decision.
 *
 * Pure decision logic only — no I/O. Callers (CLI, orchestrator, playbooks)
 * gather live GitHub / capacity-ledger evidence and hand it here; the returned
 * decision says whether to feed the queue, which umbrella to shred, and which
 * leaves to emit. The heavy lifting the 2026-08-01 reflection did manually for
 * lucy#1588 becomes repeatable and idempotent:
 *
 *   1. Gate on idle capacity + empty queue.
 *   2. Filter out umbrellas that already have open children (no duplicate
 *      decomposition — idempotent).
 *   3. Rank product-metric-blocking umbrellas above harness/internal ones so
 *      idle capacity flows to product outcomes, not more internal refactors.
 *   4. Select ONE umbrella and emit 3–5 well-formed leaf specs, capped to bound
 *      blast radius.
 *   5. Produce a dry-run observability record the next reflection can read.
 *
 * Product-metric-blocking detection is reused from the value-density governor
 * (#1846) so the two governors agree on what "product-metric-blocking" means.
 */

import {
  DEFAULT_PRODUCT_METRIC_LABELS,
  isProductMetricBlocking,
} from './value-density-governor.js';

export const QUEUE_FEEDER_SCHEMA = 'queue-feeder.v1' as const;

/** Idle-capacity gate: feed the queue only when at least this many slots are free. */
export const DEFAULT_FREE_SLOTS_THRESHOLD = 3;

/** Minimum leaves a decomposition must yield to count as well-formed. */
export const DEFAULT_MIN_LEAVES = 3;

/** Hard cap on leaves emitted per umbrella per run (bounds blast radius). */
export const DEFAULT_MAX_LEAVES = 5;

/**
 * Labels/title tokens that mark an umbrella as harness / internal / orchestration
 * work rather than a product outcome. Ranked *below* product-metric-blocking
 * umbrellas so idle capacity is not spent decomposing more internal refactors.
 */
export const DEFAULT_HARNESS_LABELS: readonly string[] = Object.freeze([
  'harness',
  'orchestration',
  'internal',
  'meta',
  'infra',
  'refactor',
  'architecture',
  'tech-debt',
]);

const HARNESS_TITLE_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bharness\b/i,
  /\borchestrat/i,
  /\bscheduler\b/i,
  /\bwatchdog\b/i,
  /\breaper\b/i,
  /\brefactor\b/i,
  /\bdedup(e|lication)?\b/i,
  /\binternal\b/i,
  /\bmeta\b/i,
  /\bplumbing\b/i,
]);

export interface QueueFeederConfig {
  /** Feed only when `free >= freeSlotsThreshold`. */
  freeSlotsThreshold: number;
  /** A decomposition must yield at least this many leaves. */
  minLeavesPerUmbrella: number;
  /** Emit at most this many leaves per umbrella per run. */
  maxLeavesPerUmbrella: number;
  /** Labels marking product-metric-blocking work (case-insensitive). */
  productMetricLabels: readonly string[];
  /** Labels marking harness/internal umbrellas (case-insensitive). */
  harnessLabels: readonly string[];
}

export const DEFAULT_QUEUE_FEEDER_CONFIG: Readonly<QueueFeederConfig> = Object.freeze({
  freeSlotsThreshold: DEFAULT_FREE_SLOTS_THRESHOLD,
  minLeavesPerUmbrella: DEFAULT_MIN_LEAVES,
  maxLeavesPerUmbrella: DEFAULT_MAX_LEAVES,
  productMetricLabels: DEFAULT_PRODUCT_METRIC_LABELS,
  harnessLabels: DEFAULT_HARNESS_LABELS,
});

/** The idle-capacity signal, sourced from `core/capacity-ledger.ts`. */
export interface CapacitySignal {
  free: number;
  pendingQueueDepth: number;
}

/** An open umbrella issue that may be decomposed into leaves. */
export interface UmbrellaCandidate {
  /** GitHub repo full name (`owner/repo`) — repo-qualifies the issue number. */
  repo: string;
  /** Issue number within {@link repo}. */
  number: number;
  title: string;
  body?: string | null;
  labels?: readonly string[];
  /**
   * Count of OPEN child issues/tasks already linked to this umbrella. `> 0`
   * means it was already decomposed — the feeder skips it (idempotent).
   */
  openChildrenCount: number;
  /** Explicit product-metric-blocking override; derived from labels/title when omitted. */
  productMetricBlocking?: boolean;
  /** Explicit harness/internal override; derived from labels/title when omitted. */
  harness?: boolean;
  /** Higher wins within a ranking tier. */
  priority?: number;
}

/** A single spawnable leaf task/issue emitted from an umbrella. */
export interface LeafSpec {
  title: string;
  /** One-sentence crisp goal — what "done" delivers. */
  goal: string;
  /** Testable acceptance criteria (≥1, non-empty). */
  acceptanceCriteria: string[];
  /** Optional file paths to read / touch. */
  fileHints?: string[];
  /** Optional test command / test file hints. */
  testHints?: string[];
  labels?: string[];
}

export interface UmbrellaClassification {
  productMetricBlocking: boolean;
  harness: boolean;
}

export interface RankedUmbrella {
  candidate: UmbrellaCandidate;
  classification: UmbrellaClassification;
  /** Higher = preferred. Product-metric-blocking dominates harness. */
  rankScore: number;
}

export interface SkippedUmbrella {
  ref: string;
  reason: string;
}

export interface SelectedUmbrella {
  ref: string;
  repo: string;
  number: number;
  title: string;
  productMetricBlocking: boolean;
  harness: boolean;
  rankScore: number;
  /** Validated, capped leaves ready to emit (empty when none resolvable). */
  leaves: LeafSpec[];
  /** True when the umbrella was selected but no valid leaf plan resolved. */
  needsAuthoring: boolean;
  /** Present when leaves could not be produced (needsAuthoring true). */
  leafError?: string;
}

export interface QueueFeederDecision {
  schemaVersion: typeof QUEUE_FEEDER_SCHEMA;
  /** True when the idle-capacity gate fired (free ≥ threshold AND queue empty). */
  triggered: boolean;
  triggerReason: string;
  capacity: CapacitySignal;
  /** The chosen umbrella + its leaves, or null when nothing eligible/triggered. */
  selected: SelectedUmbrella | null;
  /** Every candidate that was not selected, with a reason (eligibility or lost-rank). */
  skipped: SkippedUmbrella[];
  /** Count of well-formed leaves the selected umbrella would emit. */
  leafCount: number;
  /** Always true here — this module never performs side effects. */
  dryRun: true;
}

/** `owner/repo#123` — repo-qualified so cross-repo umbrellas never collide. */
export function umbrellaRef(candidate: Pick<UmbrellaCandidate, 'repo' | 'number'>): string {
  return `${candidate.repo.trim()}#${candidate.number}`;
}

export function mergeQueueFeederConfig(overrides?: Partial<QueueFeederConfig>): QueueFeederConfig {
  return {
    ...DEFAULT_QUEUE_FEEDER_CONFIG,
    ...overrides,
    productMetricLabels:
      overrides?.productMetricLabels ?? DEFAULT_QUEUE_FEEDER_CONFIG.productMetricLabels,
    harnessLabels: overrides?.harnessLabels ?? DEFAULT_QUEUE_FEEDER_CONFIG.harnessLabels,
  };
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function hasAnyLabel(labels: readonly string[] | undefined, wanted: readonly string[]): boolean {
  if (!labels || labels.length === 0) return false;
  const set = new Set(wanted.map(normalizeLabel));
  return labels.some((l) => set.has(normalizeLabel(l)));
}

/** True when labels or title mark the umbrella as harness/internal work. */
export function isHarnessUmbrella(
  candidate: Pick<UmbrellaCandidate, 'title' | 'labels' | 'harness'>,
  config?: Partial<QueueFeederConfig>,
): boolean {
  if (candidate.harness !== undefined) return candidate.harness;
  const cfg = mergeQueueFeederConfig(config);
  if (hasAnyLabel(candidate.labels, cfg.harnessLabels)) return true;
  const title = candidate.title ?? '';
  return HARNESS_TITLE_PATTERNS.some((re) => re.test(title));
}

/** Classify an umbrella's product-metric / harness posture. */
export function classifyUmbrella(
  candidate: UmbrellaCandidate,
  config?: Partial<QueueFeederConfig>,
): UmbrellaClassification {
  const cfg = mergeQueueFeederConfig(config);
  const productMetricBlocking =
    candidate.productMetricBlocking ??
    isProductMetricBlocking(candidate.title, candidate.labels, cfg.productMetricLabels);
  // A product-metric-blocking umbrella is never treated as harness even if its
  // title/labels also match harness tokens — the product signal dominates.
  const harness = productMetricBlocking ? false : isHarnessUmbrella(candidate, cfg);
  return { productMetricBlocking, harness };
}

/**
 * Idle-capacity gate. Fires when there is genuine slack (≥ threshold free
 * slots) AND nothing already queued — exactly the `idle_capacity` warn shape
 * (free≥3, pendingQueueDepth==0) the velocity probe reports.
 */
export function isFeederTriggered(
  capacity: CapacitySignal,
  config?: Partial<QueueFeederConfig>,
): boolean {
  const cfg = mergeQueueFeederConfig(config);
  return capacity.free >= cfg.freeSlotsThreshold && capacity.pendingQueueDepth === 0;
}

function triggerReason(capacity: CapacitySignal, cfg: QueueFeederConfig): string {
  if (capacity.pendingQueueDepth > 0) {
    return `queue not empty (pendingQueueDepth=${capacity.pendingQueueDepth}) — no refill needed`;
  }
  if (capacity.free < cfg.freeSlotsThreshold) {
    return `only ${capacity.free} free slot(s) (< threshold ${cfg.freeSlotsThreshold}) — no idle capacity`;
  }
  return `idle capacity: free=${capacity.free} (≥ ${cfg.freeSlotsThreshold}) and queue empty`;
}

/**
 * Eligibility for decomposition. An umbrella is eligible unless it already has
 * open children (already decomposed — idempotent skip). Returns the skip reason
 * when ineligible, or null when eligible.
 */
export function umbrellaSkipReason(candidate: UmbrellaCandidate): string | null {
  if (!candidate.repo || !candidate.repo.includes('/')) {
    return `invalid repo "${candidate.repo}" — expected owner/repo`;
  }
  if (!Number.isInteger(candidate.number) || candidate.number <= 0) {
    return `invalid issue number ${candidate.number}`;
  }
  if (candidate.openChildrenCount > 0) {
    return `already has ${candidate.openChildrenCount} open child(ren) — already decomposed`;
  }
  return null;
}

/**
 * Rank eligible umbrellas: product-metric-blocking first, then non-harness,
 * then explicit priority, then stable input order. Harness umbrellas sort last
 * so idle capacity is spent on product outcomes.
 */
export function rankUmbrellas(
  candidates: readonly UmbrellaCandidate[],
  config?: Partial<QueueFeederConfig>,
): { eligible: RankedUmbrella[]; skipped: SkippedUmbrella[] } {
  const cfg = mergeQueueFeederConfig(config);
  const eligible: Array<RankedUmbrella & { priority: number; index: number }> = [];
  const skipped: SkippedUmbrella[] = [];

  candidates.forEach((candidate, index) => {
    const reason = umbrellaSkipReason(candidate);
    if (reason) {
      skipped.push({ ref: umbrellaRef(candidate), reason });
      return;
    }
    const classification = classifyUmbrella(candidate, cfg);
    // rankScore is the TIER weight only — product-metric-blocking (100) beats
    // non-harness (10) beats harness (0). Caller-supplied `priority` is an
    // *intra-tier* tie-break (secondary sort key), never added into the tier
    // score, so a large priority can never lift a harness umbrella above a
    // product-metric one.
    const rankScore = (classification.productMetricBlocking ? 100 : 0) + (classification.harness ? 0 : 10);
    eligible.push({ candidate, classification, rankScore, priority: candidate.priority ?? 0, index });
  });

  // Higher tier first; within a tier higher priority first; then stable input order.
  eligible.sort((a, b) => b.rankScore - a.rankScore || b.priority - a.priority || a.index - b.index);

  return {
    eligible: eligible.map(({ candidate, classification, rankScore }) => ({
      candidate,
      classification,
      rankScore,
    })),
    skipped,
  };
}

/** Validation errors for a single leaf spec (empty = valid). */
export function validateLeafSpec(leaf: LeafSpec): string[] {
  const errors: string[] = [];
  if (!leaf.title || !leaf.title.trim()) errors.push('missing title');
  if (!leaf.goal || !leaf.goal.trim()) errors.push('missing goal');
  const acs = (leaf.acceptanceCriteria ?? []).filter((a) => a && a.trim());
  if (acs.length === 0) errors.push('no acceptance criteria');
  return errors;
}

export interface NormalizedLeafPlan {
  ok: boolean;
  leaves: LeafSpec[];
  error?: string;
}

/**
 * Validate + cap a leaf plan. Drops malformed leaves, requires ≥ min after
 * dropping, and caps to ≤ max (keeping the first `max`). Returns `ok: false`
 * with a reason when the plan cannot satisfy the minimum.
 */
export function normalizeLeafPlan(
  leaves: readonly LeafSpec[] | undefined,
  config?: Partial<QueueFeederConfig>,
): NormalizedLeafPlan {
  const cfg = mergeQueueFeederConfig(config);
  if (!leaves || leaves.length === 0) {
    return { ok: false, leaves: [], error: 'no leaf plan supplied' };
  }
  const valid: LeafSpec[] = [];
  const dropped: string[] = [];
  for (const leaf of leaves) {
    const errs = validateLeafSpec(leaf);
    if (errs.length === 0) valid.push(leaf);
    else dropped.push(`"${leaf.title ?? '(untitled)'}": ${errs.join(', ')}`);
  }
  if (valid.length < cfg.minLeavesPerUmbrella) {
    return {
      ok: false,
      leaves: valid.slice(0, cfg.maxLeavesPerUmbrella),
      error:
        `only ${valid.length} well-formed leaf(s) (< min ${cfg.minLeavesPerUmbrella})` +
        (dropped.length ? `; dropped ${dropped.length}: ${dropped.join('; ')}` : ''),
    };
  }
  return { ok: true, leaves: valid.slice(0, cfg.maxLeavesPerUmbrella) };
}

export interface QueueFeederInput {
  capacity: CapacitySignal;
  candidates: readonly UmbrellaCandidate[];
  /**
   * Resolve the curated / authored leaf plan for a selected umbrella. Defaults
   * to {@link curatedLeafPlan} (the built-in vetted registry). Return undefined
   * when no plan exists yet — the umbrella is still selected but flagged
   * `needsAuthoring`.
   */
  resolveLeaves?: (candidate: UmbrellaCandidate) => readonly LeafSpec[] | undefined;
  config?: Partial<QueueFeederConfig>;
}

/**
 * Full queue-feeder decision. Gates on idle capacity, ranks eligible umbrellas,
 * selects the top one, resolves + validates its leaf plan, and records every
 * non-selected candidate with a reason. Never performs side effects.
 */
export function evaluateQueueFeeder(input: QueueFeederInput): QueueFeederDecision {
  const cfg = mergeQueueFeederConfig(input.config);
  const capacity = input.capacity;
  const resolve = input.resolveLeaves ?? ((c: UmbrellaCandidate) => curatedLeafPlan(umbrellaRef(c)));

  const triggered = isFeederTriggered(capacity, cfg);
  const reason = triggerReason(capacity, cfg);

  if (!triggered) {
    return {
      schemaVersion: QUEUE_FEEDER_SCHEMA,
      triggered: false,
      triggerReason: reason,
      capacity,
      selected: null,
      skipped: [],
      leafCount: 0,
      dryRun: true,
    };
  }

  const { eligible, skipped } = rankUmbrellas(input.candidates, cfg);

  if (eligible.length === 0) {
    return {
      schemaVersion: QUEUE_FEEDER_SCHEMA,
      triggered: true,
      triggerReason: reason,
      capacity,
      selected: null,
      skipped,
      leafCount: 0,
      dryRun: true,
    };
  }

  const winner = eligible[0]!;
  const rest = eligible.slice(1).map((r) => ({
    ref: umbrellaRef(r.candidate),
    reason: `not selected this run (${umbrellaRef(winner.candidate)} ranked higher, one umbrella per run)`,
  }));

  const plan = normalizeLeafPlan(resolve(winner.candidate), cfg);
  const selected: SelectedUmbrella = {
    ref: umbrellaRef(winner.candidate),
    repo: winner.candidate.repo,
    number: winner.candidate.number,
    title: winner.candidate.title,
    productMetricBlocking: winner.classification.productMetricBlocking,
    harness: winner.classification.harness,
    rankScore: winner.rankScore,
    leaves: plan.leaves,
    needsAuthoring: !plan.ok,
    leafError: plan.ok ? undefined : plan.error,
  };

  return {
    schemaVersion: QUEUE_FEEDER_SCHEMA,
    triggered: true,
    triggerReason: reason,
    capacity,
    selected,
    skipped: [...skipped, ...rest],
    leafCount: plan.leaves.length,
    dryRun: true,
  };
}

/**
 * Render a leaf into a GitHub issue body: crisp goal, checkbox acceptance
 * criteria, optional file/test hints, and a repo-qualified backref to the
 * umbrella so the parent/child link survives across repos.
 */
export function buildLeafIssueBody(leaf: LeafSpec, umbrella: string): string {
  const lines: string[] = [];
  lines.push('## Goal', '', leaf.goal.trim(), '');
  lines.push('## Acceptance criteria', '');
  for (const ac of leaf.acceptanceCriteria.filter((a) => a && a.trim())) {
    lines.push(`- [ ] ${ac.trim()}`);
  }
  lines.push('');
  if (leaf.fileHints && leaf.fileHints.length > 0) {
    lines.push('## File hints', '');
    for (const f of leaf.fileHints) lines.push(`- \`${f}\``);
    lines.push('');
  }
  if (leaf.testHints && leaf.testHints.length > 0) {
    lines.push('## Test hints', '');
    for (const t of leaf.testHints) lines.push(`- ${t}`);
    lines.push('');
  }
  lines.push('---', `Leaf of umbrella ${umbrella} — emitted by the queue-feeder (#1845).`);
  return lines.join('\n');
}

// --- Observability -----------------------------------------------------------

export interface QueueFeederRecord {
  schemaVersion: typeof QUEUE_FEEDER_SCHEMA;
  ts: string;
  triggered: boolean;
  triggerReason: string;
  free: number;
  pendingQueueDepth: number;
  selectedRef: string | null;
  selectedTitle: string | null;
  productMetricBlocking: boolean | null;
  needsAuthoring: boolean;
  leafCount: number;
  leafTitles: string[];
  skippedCount: number;
  skipped: SkippedUmbrella[];
  dryRun: boolean;
}

/** Build the durable observability record for the dry-run ledger. */
export function buildQueueFeederRecord(
  decision: QueueFeederDecision,
  opts: { now?: Date; dryRun?: boolean } = {},
): QueueFeederRecord {
  const sel = decision.selected;
  return {
    schemaVersion: QUEUE_FEEDER_SCHEMA,
    ts: (opts.now ?? new Date()).toISOString(),
    triggered: decision.triggered,
    triggerReason: decision.triggerReason,
    free: decision.capacity.free,
    pendingQueueDepth: decision.capacity.pendingQueueDepth,
    selectedRef: sel?.ref ?? null,
    selectedTitle: sel?.title ?? null,
    productMetricBlocking: sel ? sel.productMetricBlocking : null,
    needsAuthoring: sel?.needsAuthoring ?? false,
    leafCount: decision.leafCount,
    leafTitles: sel?.leaves.map((l) => l.title) ?? [],
    skippedCount: decision.skipped.length,
    skipped: decision.skipped,
    dryRun: opts.dryRun ?? true,
  };
}

/** One-line summary for the reflection / velocity-probe log. */
export function formatQueueFeederLine(record: QueueFeederRecord): string {
  if (!record.triggered) {
    return `queue-feeder: not triggered — ${record.triggerReason}`;
  }
  if (!record.selectedRef) {
    return (
      `queue-feeder: triggered (free=${record.free}, queue empty) but no eligible umbrella ` +
      `(${record.skippedCount} skipped)`
    );
  }
  const mode = record.dryRun ? 'DRY-RUN' : 'EMIT';
  const pm = record.productMetricBlocking ? 'product-metric' : 'harness/other';
  const authoring = record.needsAuthoring ? ' [needs-authoring: no vetted leaf plan]' : '';
  return (
    `queue-feeder [${mode}]: shredded ${record.selectedRef} (${pm}) → ${record.leafCount} leaf(s)` +
    `${authoring}; ${record.skippedCount} umbrella(s) skipped`
  );
}

/** Path for the append-only queue-feeder ledger (observable by reflection). */
export function queueFeederLedgerPath(kookrDir: string): string {
  return `${kookrDir.replace(/\/+$/, '')}/playbook-state/queue-feeder/decisions.jsonl`;
}

// --- Vetted leaf-plan registry ----------------------------------------------

/**
 * lucy#1588 "anchor truth — SEC acceptance anchors". This is the umbrella the
 * 2026-08-01 reflection decomposed by hand; encoding its 3-leaf plan here is
 * the canonical example of a well-formed decomposition and the fixture that
 * proves the shred format. In live operation lucy#1588 already has open
 * children, so the feeder *skips* it (idempotent) — this plan documents what
 * those leaves are, not a re-emission.
 *
 * The SEC-anchor metric was "not measurable" for multiple consecutive daily
 * reports; these three leaves move it from unmeasurable → numeric daily value:
 * instrument latency, assemble ground truth, then a probe that scores against it.
 */
export const LUCY_1588_LEAF_PLAN: readonly LeafSpec[] = Object.freeze([
  Object.freeze({
    title: 'feat(sec-anchor): EDGAR filing→detection latency metric',
    goal:
      'Instrument the EDGAR ingestion path to record filing-published → anchor-detected ' +
      'latency and expose it as a headline metric so SEC-anchor measurability moves from ' +
      '"not measurable" to a numeric daily value.',
    acceptanceCriteria: [
      'A per-filing `edgar_detection_latency_seconds` value is recorded from the SEC ' +
        'filing timestamp to the anchor-detection timestamp.',
      'The daily report shows p50/p95 detection latency for the window (no longer "not measurable").',
      'Filings missing a usable timestamp are counted in a separate "unmeasured" bucket rather ' +
        'than silently dropped.',
    ],
    fileHints: ['SEC/EDGAR ingestion module', 'daily-report / metrics emitter'],
    testHints: ['unit test: latency computed from fixture filing timestamps; unmeasured bucket increments'],
    labels: ['sec-anchor', 'product-metric'],
  }),
  Object.freeze({
    title: 'feat(sec-anchor): SEC acceptance-anchor ground-truth fixture set',
    goal:
      'Assemble a vetted fixture set of known SEC filings with their expected anchor extractions ' +
      'to serve as acceptance ground truth for the anchor extractor.',
    acceptanceCriteria: [
      'At least 10 real filings are captured with expected anchor fields (ticker, form type, ' +
        'anchor date, key figures).',
      'A loader + schema validates each fixture and fails loudly on a malformed entry.',
      'The fixture set is committed and referenced by the acceptance probe (next leaf).',
    ],
    fileHints: ['test fixtures dir for SEC anchors', 'fixture loader + schema'],
    testHints: ['schema test: every fixture parses; a deliberately malformed fixture is rejected'],
    labels: ['sec-anchor', 'product-metric'],
  }),
  Object.freeze({
    title: 'feat(sec-anchor): acceptance probe scoring detected anchors vs ground truth',
    goal:
      'Run the anchor extractor against the ground-truth fixture set and report precision/recall ' +
      'as the SEC-anchor acceptance metric, wired into the daily report.',
    acceptanceCriteria: [
      'The probe outputs precision, recall, and `measurable=true` for the SEC-anchor acceptance metric.',
      'The metric appears in the daily report so the previously-blocked product metric is now tracked.',
      'The probe exits non-zero (or flags a regression) when precision or recall drops below a ' +
        'configured threshold.',
    ],
    fileHints: ['acceptance probe / metrics wiring', 'daily-report integration'],
    testHints: ['unit test: precision/recall computed from a fixture run; below-threshold flags regression'],
    labels: ['sec-anchor', 'product-metric'],
  }),
]);

/**
 * Vetted leaf plans keyed by repo-qualified umbrella ref (`owner/repo#number`).
 * Extend as more umbrellas get curated decompositions; unknown umbrellas return
 * undefined and are flagged `needsAuthoring` by {@link evaluateQueueFeeder}.
 */
export const CURATED_LEAF_PLANS: Readonly<Record<string, readonly LeafSpec[]>> = Object.freeze({
  'jeanibarz/lucy#1588': LUCY_1588_LEAF_PLAN,
});

/** Look up the curated leaf plan for a repo-qualified umbrella ref. */
export function curatedLeafPlan(ref: string): readonly LeafSpec[] | undefined {
  return CURATED_LEAF_PLANS[ref.trim()];
}
