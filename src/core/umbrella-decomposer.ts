/**
 * Queue-feeder / umbrella auto-decomposer (issue #1845 + #2044 secondary path).
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
 * Issue #2044 secondary path — when product umbrellas are already shredded
 * (or only needsAuthoring residuals remain) but free slots + empty queue still
 * hold, do **not** dead-end on `skip-invent` while open idea-scout / ready
 * issues sit unclaimed:
 *
 *   6. Prefer open, unassigned ready issues (idea-scout / ready-labeled),
 *      cap ≤ N per fire, skip assignees and prior secondary emissions.
 *   7. Else shred a residual umbrella that still has a curated leaf plan.
 *   8. Only then `skip-invent` — free < threshold, queue busy, or no safe source.
 *
 * Issue #2069 invent-product-wave — closed children must not permanently block
 * re-author. `openChildrenCount` counts **open** non-umbrella children only;
 * when the product belt is empty (`openProductMetricIssues=0`) and a product-
 * metric umbrella is eligible with no curated plan, authorize a bounded next
 * leaf wave (1–3) under that umbrella **before** idea-scout secondary emit:
 *
 *   6b. `action=invent-product-wave` — playbook authors additive product leaves
 *       (existing emission budgets; no mass-close). Open children still mean
 *       "use existing leaves" (skip invent under that umbrella).
 *
 * Product-metric-blocking detection is reused from the value-density governor
 * (#1846) so the two governors agree on what "product-metric-blocking" means.
 */

import {
  DEFAULT_PRODUCT_METRIC_LABELS,
  isProductMetricBlocking,
} from './value-density-governor.js';
import {
  classifyInventPriority,
  hasProductInventRunway,
  inventPriorityScore,
  isInventPressure,
  shouldSuppressMicroInvent,
  type InventPriorityClass,
} from './starvation-invent-policy.js';

export const QUEUE_FEEDER_SCHEMA = 'queue-feeder.v1' as const;

/** Idle-capacity gate: feed the queue only when at least this many slots are free. */
export const DEFAULT_FREE_SLOTS_THRESHOLD = 3;

/** Minimum leaves a decomposition must yield to count as well-formed. */
export const DEFAULT_MIN_LEAVES = 3;

/** Hard cap on leaves emitted per umbrella per run (bounds blast radius). */
export const DEFAULT_MAX_LEAVES = 5;

/**
 * Cap on ready issues (idea-scout / ready-labeled) pulled into the implementable
 * set per fire when primary product shred is empty (#2044). Bounds blast radius
 * and keeps re-fires from flooding the queue.
 */
export const DEFAULT_MAX_SECONDARY_PER_FIRE = 3;

/**
 * Cap on product-metric leaves the playbook may invent under one umbrella when
 * `action=invent-product-wave` (#2069). Bounds blast radius; additive filing only.
 */
export const DEFAULT_MAX_INVENT_LEAVES = 3;

/**
 * Minimum product-metric leaves for an invent-product-wave batch (#2069).
 * Playbook authors at least this many when invent is authorized.
 */
export const DEFAULT_MIN_INVENT_LEAVES = 1;

/**
 * Labels that mark an open issue as secondary-feed ready. Callers may pre-filter;
 * when labels are present we still accept any issue the caller listed (they own
 * the query), but prefer these tokens when ranking.
 */
export const DEFAULT_READY_ISSUE_LABELS: readonly string[] = Object.freeze([
  'idea-scout',
  'ready',
]);

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
  /** Cap ready-issue secondary emissions per fire (#2044). */
  maxSecondaryPerFire: number;
  /** Cap invent-product-wave leaves per fire (#2069). */
  maxInventLeaves: number;
  /** Labels marking product-metric-blocking work (case-insensitive). */
  productMetricLabels: readonly string[];
  /** Labels marking harness/internal umbrellas (case-insensitive). */
  harnessLabels: readonly string[];
  /** Labels preferred when ranking ready issues for secondary emit. */
  readyIssueLabels: readonly string[];
}

export const DEFAULT_QUEUE_FEEDER_CONFIG: Readonly<QueueFeederConfig> = Object.freeze({
  freeSlotsThreshold: DEFAULT_FREE_SLOTS_THRESHOLD,
  minLeavesPerUmbrella: DEFAULT_MIN_LEAVES,
  maxLeavesPerUmbrella: DEFAULT_MAX_LEAVES,
  maxSecondaryPerFire: DEFAULT_MAX_SECONDARY_PER_FIRE,
  maxInventLeaves: DEFAULT_MAX_INVENT_LEAVES,
  productMetricLabels: DEFAULT_PRODUCT_METRIC_LABELS,
  harnessLabels: DEFAULT_HARNESS_LABELS,
  readyIssueLabels: DEFAULT_READY_ISSUE_LABELS,
});

/** The idle-capacity signal, sourced from `core/capacity-ledger.ts`. */
export interface CapacitySignal {
  /**
   * Nominal free slots (`maxActive - active`). Real launch admission still keys
   * on this / live active count — a still-resident phantom cannot be over-booked.
   */
  free: number;
  pendingQueueDepth: number;
  /**
   * Effective free slots for general sources (issue #2357 / #1935). When present,
   * feeder idle-capacity decisions key on this (same number as
   * capacityThroughputVerdict.idleEffectiveSlots) rather than nominal `free`, so
   * phantom-held slots do not suppress refill while reclaim drains them.
   * Absent → fall back to {@link free}.
   */
  freeForGeneralSources?: number;
}

/**
 * Free-slot budget for general-source spawn / feeder decisions (issue #2357).
 * Prefers effective free when the ledger publishes it; otherwise nominal free.
 * Real concurrent launch admission still uses live active count and must not
 * over-admit into still-resident phantoms.
 */
export function effectiveFreeForSpawnBudget(capacity: CapacitySignal): number {
  if (
    typeof capacity.freeForGeneralSources === 'number'
    && Number.isFinite(capacity.freeForGeneralSources)
  ) {
    return Math.max(0, capacity.freeForGeneralSources);
  }
  return Math.max(0, capacity.free);
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
   * Count of **OPEN** non-umbrella child issues/tasks already linked to this
   * umbrella. Closed leaves must **not** be counted (#2069) — only open
   * children mean "already decomposed; use existing leaves." `> 0` skips the
   * umbrella for shred/invent (idempotent; does not re-author while open work
   * remains).
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

/**
 * An already-open implementable issue (idea-scout / ready-labeled) that the
 * feeder may pull into the implement set when product umbrella leaves are
 * exhausted (#2044). Callers gather these from `gh issue list`; this module
 * only ranks and caps.
 */
export interface ReadyIssue {
  repo: string;
  number: number;
  title: string;
  labels?: readonly string[];
  /**
   * Non-empty assignees mean the issue is claimed — never auto-emit / auto-claim
   * work assigned to someone else.
   */
  assignees?: readonly string[];
  /** When true, a prior secondary fire already selected this ref (idempotent). */
  alreadyEmitted?: boolean;
  /** Optional state; closed issues are skipped when present. */
  state?: 'open' | 'closed';
}

/** What the feeder decided to do this fire (ledger `action` field). */
export type QueueFeederAction =
  | 'not-triggered'
  | 'shred'
  | 'emit-secondary'
  | 'invent-product-wave'
  | 'skip-invent';

/** Provenance for an `emit-secondary` / shred / invent decision. */
export type QueueFeederActionSource =
  | 'umbrella-shred'
  | 'idea-scout'
  | 'curated-umbrella'
  | 'product-wave'
  | null;

/** One ready issue selected for secondary emit, with a stable ref. */
export interface SecondaryEmitItem {
  ref: string;
  repo: string;
  number: number;
  title: string;
  labels: string[];
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
  /** Ledger action: shred | emit-secondary | skip-invent | not-triggered. */
  action: QueueFeederAction;
  /** Provenance for shred / emit-secondary; null when not emitting. */
  actionSource: QueueFeederActionSource;
  /** The chosen umbrella + its leaves, or null when nothing eligible/triggered. */
  selected: SelectedUmbrella | null;
  /**
   * Ready issues selected for secondary emit (#2044). Empty unless
   * `action === 'emit-secondary'` and `actionSource === 'idea-scout'`.
   */
  secondaryEmitted: SecondaryEmitItem[];
  /** Every candidate that was not selected, with a reason (eligibility or lost-rank). */
  skipped: SkippedUmbrella[];
  /** Count of well-formed leaves the selected umbrella would emit (or secondary count). */
  leafCount: number;
  /**
   * When `action === 'invent-product-wave'`, max leaves the playbook may author
   * this fire (1–{@link DEFAULT_MAX_INVENT_LEAVES}). Null otherwise.
   */
  inventLeafCap: number | null;
  /**
   * Invent priority class for this decision (issue #2358). Product for
   * shred/invent-product-wave of dual-priority work; micro/other for secondary
   * emit mix. Null when not-triggered.
   */
  inventPriorityClass: InventPriorityClass | null;
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
    readyIssueLabels: overrides?.readyIssueLabels ?? DEFAULT_QUEUE_FEEDER_CONFIG.readyIssueLabels,
  };
}

/** `owner/repo#123` for a ready issue — same shape as umbrella refs. */
export function readyIssueRef(issue: Pick<ReadyIssue, 'repo' | 'number'>): string {
  return `${issue.repo.trim()}#${issue.number}`;
}

/**
 * Eligibility for secondary emit of a ready issue. Returns the skip reason when
 * ineligible, or null when the issue may be emitted. Never auto-claims issues
 * assigned to someone else (#2044).
 */
export function readyIssueSkipReason(issue: ReadyIssue): string | null {
  if (!issue.repo || !issue.repo.includes('/')) {
    return `invalid repo "${issue.repo}" — expected owner/repo`;
  }
  if (!Number.isInteger(issue.number) || issue.number <= 0) {
    return `invalid issue number ${issue.number}`;
  }
  if (issue.state === 'closed') {
    return 'issue is closed';
  }
  const assignees = (issue.assignees ?? []).map((a) => a.trim()).filter(Boolean);
  if (assignees.length > 0) {
    return `assigned to ${assignees.join(', ')} — do not auto-claim`;
  }
  if (issue.alreadyEmitted) {
    return 'already emitted by a prior secondary fire (idempotent)';
  }
  return null;
}

export interface SelectReadyIssuesOptions {
  config?: Partial<QueueFeederConfig>;
  /**
   * When true (starvation invent pressure + product runway, issue #2358),
   * micro-hardening ready issues are skipped rather than merely demoted.
   */
  suppressMicro?: boolean;
}

/**
 * Rank + cap ready issues for secondary emit. Skips assigned / closed / already
 * emitted; ranks dual-priority product invent first and micro-hardening last
 * (issue #2358); prefers idea-scout / ready labels within a class; stable input
 * order as final key. Cap defaults to {@link DEFAULT_MAX_SECONDARY_PER_FIRE}.
 */
export function selectReadyIssues(
  issues: readonly ReadyIssue[] | undefined,
  configOrOpts?: Partial<QueueFeederConfig> | SelectReadyIssuesOptions,
): { selected: SecondaryEmitItem[]; skipped: SkippedUmbrella[] } {
  // Back-compat: callers historically passed Partial<QueueFeederConfig> directly.
  const opts: SelectReadyIssuesOptions =
    configOrOpts && ('config' in configOrOpts || 'suppressMicro' in configOrOpts)
      ? (configOrOpts as SelectReadyIssuesOptions)
      : { config: configOrOpts as Partial<QueueFeederConfig> | undefined };
  const cfg = mergeQueueFeederConfig(opts.config);
  const suppressMicro = opts.suppressMicro === true;
  if (!issues || issues.length === 0) {
    return { selected: [], skipped: [] };
  }
  const preferred = new Set(cfg.readyIssueLabels.map(normalizeLabel));
  const eligible: Array<
    SecondaryEmitItem & { score: number; inventScore: number; index: number; inventClass: InventPriorityClass }
  > = [];
  const skipped: SkippedUmbrella[] = [];

  issues.forEach((issue, index) => {
    const reason = readyIssueSkipReason(issue);
    if (reason) {
      skipped.push({ ref: readyIssueRef(issue), reason });
      return;
    }
    const labels = (issue.labels ?? []).map((l) => String(l));
    const inventClass = classifyInventPriority(issue.title, labels);
    if (suppressMicro && inventClass === 'micro') {
      skipped.push({
        ref: readyIssueRef(issue),
        reason:
          'micro-hardening demoted under invent pressure while product runway remains (#2358)',
      });
      return;
    }
    const hasPreferred = labels.some((l) => preferred.has(normalizeLabel(l)));
    // inventScore dominates (product >> other >> micro); preferred labels next;
    // within tier keep input order.
    eligible.push({
      ref: readyIssueRef(issue),
      repo: issue.repo.trim(),
      number: issue.number,
      title: issue.title,
      labels,
      inventClass,
      inventScore: inventPriorityScore(inventClass),
      score: hasPreferred ? 10 : 0,
      index,
    });
  });

  eligible.sort(
    (a, b) =>
      b.inventScore - a.inventScore
      || b.score - a.score
      || a.index - b.index,
  );
  const selected = eligible.slice(0, cfg.maxSecondaryPerFire).map(({ ref, repo, number, title, labels }) => ({
    ref,
    repo,
    number,
    title,
    labels,
  }));
  for (const extra of eligible.slice(cfg.maxSecondaryPerFire)) {
    skipped.push({
      ref: extra.ref,
      reason: `over secondary cap (${cfg.maxSecondaryPerFire} per fire)`,
    });
  }
  return { selected, skipped };
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
 *
 * Issue #2357: when `freeForGeneralSources` is present, key on that effective
 * free budget so nominal free=0 with idleEffectiveSlots>0 still refills while
 * pressure-TTL reclaim drains phantoms. Nominal free alone would incorrectly
 * block general spawn budgets under residual phantom hold.
 */
export function isFeederTriggered(
  capacity: CapacitySignal,
  config?: Partial<QueueFeederConfig>,
): boolean {
  const cfg = mergeQueueFeederConfig(config);
  const free = effectiveFreeForSpawnBudget(capacity);
  return free >= cfg.freeSlotsThreshold && capacity.pendingQueueDepth === 0;
}

function triggerReason(capacity: CapacitySignal, cfg: QueueFeederConfig): string {
  if (capacity.pendingQueueDepth > 0) {
    return `queue not empty (pendingQueueDepth=${capacity.pendingQueueDepth}) — no refill needed`;
  }
  const free = effectiveFreeForSpawnBudget(capacity);
  const freeLabel =
    capacity.freeForGeneralSources !== undefined
      ? `effectiveFree=${free} (nominal free=${capacity.free})`
      : `free=${free}`;
  if (free < cfg.freeSlotsThreshold) {
    return `only ${freeLabel} slot(s) (< threshold ${cfg.freeSlotsThreshold}) — no idle capacity`;
  }
  return `idle capacity: ${freeLabel} (≥ ${cfg.freeSlotsThreshold}) and queue empty`;
}

/**
 * Eligibility for decomposition / invent. An umbrella is eligible unless it
 * already has **open** children (use those leaves first — idempotent skip).
 * Closed children must not be counted in `openChildrenCount` (#2069); they do
 * not permanently block re-author when the product belt is empty.
 * Returns the skip reason when ineligible, or null when eligible.
 */
export function umbrellaSkipReason(candidate: UmbrellaCandidate): string | null {
  if (!candidate.repo || !candidate.repo.includes('/')) {
    return `invalid repo "${candidate.repo}" — expected owner/repo`;
  }
  if (!Number.isInteger(candidate.number) || candidate.number <= 0) {
    return `invalid issue number ${candidate.number}`;
  }
  if (candidate.openChildrenCount > 0) {
    return `already has ${candidate.openChildrenCount} open child(ren) — already decomposed (use existing open leaves; closed children must not be counted)`;
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
   * Open implementable issues (idea-scout / ready-labeled) available when
   * product umbrella shred cannot feed the queue (#2044). Pre-filter by the
   * caller is fine; this module still enforces assignee / idempotency / cap.
   */
  readyIssues?: readonly ReadyIssue[];
  /**
   * Count of open product-metric leaf issues already on the belt. When `0`
   * (or omitted while no shreddable product umbrella remains), the secondary
   * ready-issue path may fire.
   */
  openProductMetricIssues?: number;
  /**
   * Consecutive product blocked-empty depth for invent pressure (issue #2358).
   * When ≥ threshold, micro-hardening secondary emit is suppressed while product
   * invent runway remains.
   */
  consecutiveBlockedEmpty?: number;
  /**
   * Resolve the curated / authored leaf plan for a selected umbrella. Defaults
   * to {@link curatedLeafPlan} (the built-in vetted registry). Return undefined
   * when no plan exists yet — the umbrella is still selected but flagged
   * `needsAuthoring`.
   */
  resolveLeaves?: (candidate: UmbrellaCandidate) => readonly LeafSpec[] | undefined;
  config?: Partial<QueueFeederConfig>;
}

/** Dominant invent class for a set of ready issues (product if any product). */
function dominantInventClass(
  items: readonly { title: string; labels?: readonly string[] }[],
): InventPriorityClass {
  let sawOther = false;
  for (const item of items) {
    const klass = classifyInventPriority(item.title, item.labels);
    if (klass === 'product') return 'product';
    if (klass === 'other') sawOther = true;
  }
  return sawOther ? 'other' : 'micro';
}

function toSelected(
  ranked: RankedUmbrella,
  plan: NormalizedLeafPlan,
): SelectedUmbrella {
  return {
    ref: umbrellaRef(ranked.candidate),
    repo: ranked.candidate.repo,
    number: ranked.candidate.number,
    title: ranked.candidate.title,
    productMetricBlocking: ranked.classification.productMetricBlocking,
    harness: ranked.classification.harness,
    rankScore: ranked.rankScore,
    leaves: plan.leaves,
    needsAuthoring: !plan.ok,
    leafError: plan.ok ? undefined : plan.error,
  };
}

/**
 * Full queue-feeder decision. Gates on idle capacity, ranks eligible umbrellas,
 * prefers a shreddable product umbrella, then invent-product-wave (#2069) when
 * the product belt is empty, then secondary emit of ready issues (#2044).
 * Never performs side effects.
 */
export function evaluateQueueFeeder(input: QueueFeederInput): QueueFeederDecision {
  const cfg = mergeQueueFeederConfig(input.config);
  const capacity = input.capacity;
  const resolve = input.resolveLeaves ?? ((c: UmbrellaCandidate) => curatedLeafPlan(umbrellaRef(c)));
  const freeSlots = effectiveFreeForSpawnBudget(capacity);

  const triggered = isFeederTriggered(capacity, cfg);
  const reason = triggerReason(capacity, cfg);

  if (!triggered) {
    return {
      schemaVersion: QUEUE_FEEDER_SCHEMA,
      triggered: false,
      triggerReason: reason,
      capacity,
      action: 'not-triggered',
      actionSource: null,
      selected: null,
      secondaryEmitted: [],
      skipped: [],
      leafCount: 0,
      inventLeafCap: null,
      inventPriorityClass: null,
      dryRun: true,
    };
  }

  const { eligible, skipped } = rankUmbrellas(input.candidates, cfg);

  // Resolve leaf plans for every eligible umbrella once — primary shred picks
  // the highest-ranked plan-ready umbrella; invent / secondary residual reuses
  // the same resolutions.
  const resolved = eligible.map((ranked) => ({
    ranked,
    plan: normalizeLeafPlan(resolve(ranked.candidate), cfg),
  }));

  // Issue #2358 invent pressure: drought depth or empty product belt + free slots.
  const inventPressure = isInventPressure({
    consecutiveBlockedEmpty: input.consecutiveBlockedEmpty,
    openProductMetricIssues: input.openProductMetricIssues,
    freeSlots,
    freeSlotsThreshold: cfg.freeSlotsThreshold,
  });
  const productUmbrellaEligible = resolved.some(
    (r) => r.ranked.classification.productMetricBlocking,
  );
  const productReadyCount = (input.readyIssues ?? []).filter(
    (issue) =>
      readyIssueSkipReason(issue) === null
      && classifyInventPriority(issue.title, issue.labels) === 'product',
  ).length;
  const productRunway = hasProductInventRunway({
    productUmbrellaEligible,
    productReadyCount,
  });
  const suppressMicro = shouldSuppressMicroInvent(inventPressure, productRunway);

  // --- Primary: shred a plan-ready umbrella (product-metric preferred by rank)
  const shreddable = resolved.find((r) => r.plan.ok);
  if (shreddable) {
    const winner = shreddable.ranked;
    const rest = eligible
      .filter((r) => umbrellaRef(r.candidate) !== umbrellaRef(winner.candidate))
      .map((r) => ({
        ref: umbrellaRef(r.candidate),
        reason: `not selected this run (${umbrellaRef(winner.candidate)} ranked higher, one umbrella per run)`,
      }));
    const selected = toSelected(winner, shreddable.plan);
    return {
      schemaVersion: QUEUE_FEEDER_SCHEMA,
      triggered: true,
      triggerReason: reason,
      capacity,
      action: 'shred',
      actionSource: 'umbrella-shred',
      selected,
      secondaryEmitted: [],
      skipped: [...skipped, ...rest],
      leafCount: shreddable.plan.leaves.length,
      inventLeafCap: null,
      inventPriorityClass: selected.productMetricBlocking ? 'product' : 'other',
      dryRun: true,
    };
  }

  // Product leaf inventory is empty when the caller reports 0 open product-
  // metric leaves, or (when the count is omitted) when no product-metric
  // umbrella remains shreddable this run. A positive caller count blocks
  // invent + secondary emit — product leaves already exist for other actuators.
  const productInventoryEmpty =
    input.openProductMetricIssues !== undefined
      ? input.openProductMetricIssues === 0
      : !resolved.some(
          (r) => r.ranked.classification.productMetricBlocking && r.plan.ok,
        );

  // --- Invent product wave (#2069): product belt empty + eligible product-
  // metric umbrella with no curated plan. Authorize the playbook to author a
  // bounded next leaf batch (cap maxInventLeaves). Prefer over idea-scout
  // residual secondary emit so idle capacity refills the product belt first.
  // Open children already filtered by rankUmbrellas (use those leaves instead).
  // Issue #2358: product-surface-ux / control-room dual co-priority umbrellas
  // classify as productMetricBlocking via value-density labels.
  if (productInventoryEmpty) {
    const inventCandidate = resolved.find(
      (r) => r.ranked.classification.productMetricBlocking && !r.plan.ok,
    );
    if (inventCandidate) {
      const winner = inventCandidate.ranked;
      const rest = eligible
        .filter((r) => umbrellaRef(r.candidate) !== umbrellaRef(winner.candidate))
        .map((r) => ({
          ref: umbrellaRef(r.candidate),
          reason:
            `not selected this run (${umbrellaRef(winner.candidate)} ranked higher ` +
            `for invent-product-wave, one umbrella per run)`,
        }));
      const selected = toSelected(winner, inventCandidate.plan);
      const readySkipped = selectReadyIssues(input.readyIssues, {
        config: cfg,
        suppressMicro,
      }).skipped;
      return {
        schemaVersion: QUEUE_FEEDER_SCHEMA,
        triggered: true,
        triggerReason: reason,
        capacity,
        action: 'invent-product-wave',
        actionSource: 'product-wave',
        selected,
        secondaryEmitted: [],
        skipped: [...skipped, ...rest, ...readySkipped],
        // Playbook authors leaves; decision only authorizes invent + cap.
        leafCount: 0,
        inventLeafCap: cfg.maxInventLeaves,
        inventPriorityClass: 'product',
        dryRun: true,
      };
    }
  }

  // --- Secondary #1: open unassigned idea-scout / ready issues (#2044)
  // Under invent pressure with product runway, micro-hardening is suppressed
  // so sideways ops polish does not fill the belt (#2358).
  if (productInventoryEmpty) {
    const ready = selectReadyIssues(input.readyIssues, {
      config: cfg,
      suppressMicro,
    });
    if (ready.selected.length > 0) {
      // Still surface the top needsAuthoring umbrella for observability, but
      // the action is secondary emit — the playbook spawns ready issues, not invent.
      const topResidual = resolved[0];
      const residualSelected = topResidual
        ? toSelected(topResidual.ranked, topResidual.plan)
        : null;
      const residualSkip = eligible.map((r) => ({
        ref: umbrellaRef(r.candidate),
        reason: residualSelected
          ? `secondary emit preferred over residual umbrella ${residualSelected.ref} (needsAuthoring / no shreddable plan)`
          : 'no shreddable plan — secondary ready-issue path selected',
      }));
      return {
        schemaVersion: QUEUE_FEEDER_SCHEMA,
        triggered: true,
        triggerReason: reason,
        capacity,
        action: 'emit-secondary',
        actionSource: 'idea-scout',
        selected: residualSelected,
        secondaryEmitted: ready.selected,
        skipped: [...skipped, ...residualSkip, ...ready.skipped],
        leafCount: ready.selected.length,
        inventLeafCap: null,
        inventPriorityClass: dominantInventClass(ready.selected),
        dryRun: true,
      };
    }
  }

  // --- Secondary #2 is already covered when shreddable exists above. If we
  // reach here every eligible umbrella needs authoring (or none exist) and
  // invent was not authorized (no product-metric residual / openPM > 0).

  if (eligible.length === 0) {
    // No umbrellas and no ready issues → honest skip-invent (or empty fire).
    const readyEmpty = selectReadyIssues(input.readyIssues, {
      config: cfg,
      suppressMicro,
    });
    return {
      schemaVersion: QUEUE_FEEDER_SCHEMA,
      triggered: true,
      triggerReason: reason,
      capacity,
      action: 'skip-invent',
      actionSource: null,
      selected: null,
      secondaryEmitted: [],
      skipped: [...skipped, ...readyEmpty.skipped],
      leafCount: 0,
      inventLeafCap: null,
      inventPriorityClass: null,
      dryRun: true,
    };
  }

  // Residual needsAuthoring umbrella selected for ledger observability only —
  // action is skip-invent so agents do not free-form invent non-product leaves.
  const top = resolved[0]!;
  const rest = eligible.slice(1).map((r) => ({
    ref: umbrellaRef(r.candidate),
    reason: `not selected this run (${umbrellaRef(top.ranked.candidate)} ranked higher, one umbrella per run)`,
  }));
  const selected = toSelected(top.ranked, top.plan);
  const readySkipped = selectReadyIssues(input.readyIssues, {
    config: cfg,
    suppressMicro,
  }).skipped;
  return {
    schemaVersion: QUEUE_FEEDER_SCHEMA,
    triggered: true,
    triggerReason: reason,
    capacity,
    action: 'skip-invent',
    actionSource: null,
    selected,
    secondaryEmitted: [],
    skipped: [...skipped, ...rest, ...readySkipped],
    leafCount: 0,
    inventLeafCap: null,
    inventPriorityClass: selected.productMetricBlocking ? 'product' : null,
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
  /** Ledger action for reflection / agent audit (#2044 / #2069). */
  action: QueueFeederAction;
  /** Provenance when action is shred / emit-secondary / invent-product-wave. */
  source: QueueFeederActionSource;
  selectedRef: string | null;
  selectedTitle: string | null;
  productMetricBlocking: boolean | null;
  needsAuthoring: boolean;
  leafCount: number;
  leafTitles: string[];
  /** Ready-issue refs selected for secondary emit (idea-scout path). */
  secondaryEmitted: string[];
  /** Invent cap when action=invent-product-wave (#2069); null otherwise. */
  inventLeafCap: number | null;
  /**
   * Invent priority class for this fire (issue #2358) — product / micro / other.
   * Null when not-triggered or skip with no class.
   */
  inventPriorityClass: InventPriorityClass | null;
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
  const secondaryTitles =
    decision.action === 'emit-secondary' && decision.actionSource === 'idea-scout'
      ? decision.secondaryEmitted.map((i) => i.title)
      : sel?.leaves.map((l) => l.title) ?? [];
  return {
    schemaVersion: QUEUE_FEEDER_SCHEMA,
    ts: (opts.now ?? new Date()).toISOString(),
    triggered: decision.triggered,
    triggerReason: decision.triggerReason,
    free: decision.capacity.free,
    pendingQueueDepth: decision.capacity.pendingQueueDepth,
    action: decision.action,
    source: decision.actionSource,
    selectedRef: sel?.ref ?? null,
    selectedTitle: sel?.title ?? null,
    productMetricBlocking: sel ? sel.productMetricBlocking : null,
    needsAuthoring: sel?.needsAuthoring ?? false,
    leafCount: decision.leafCount,
    leafTitles: secondaryTitles,
    secondaryEmitted: decision.secondaryEmitted.map((i) => i.ref),
    inventLeafCap: decision.inventLeafCap,
    inventPriorityClass: decision.inventPriorityClass,
    skippedCount: decision.skipped.length,
    skipped: decision.skipped,
    dryRun: opts.dryRun ?? true,
  };
}

/** One-line summary for the reflection / velocity-probe log. */
export function formatQueueFeederLine(record: QueueFeederRecord): string {
  if (!record.triggered || record.action === 'not-triggered') {
    return `queue-feeder: not triggered — ${record.triggerReason}`;
  }
  if (record.action === 'emit-secondary') {
    const mode = record.dryRun ? 'DRY-RUN' : 'EMIT';
    const src = record.source ?? 'secondary';
    const refs =
      record.secondaryEmitted.length > 0
        ? record.secondaryEmitted.join(', ')
        : record.selectedRef ?? '(none)';
    return (
      `queue-feeder [${mode}]: action=emit-secondary source=${src} → ${record.leafCount} item(s) ` +
      `[${refs}]; ${record.skippedCount} skipped`
    );
  }
  if (record.action === 'invent-product-wave') {
    const mode = record.dryRun ? 'DRY-RUN' : 'AUTHOR';
    const cap = record.inventLeafCap ?? DEFAULT_MAX_INVENT_LEAVES;
    const titles =
      record.leafTitles.length > 0 ? ` titles=[${record.leafTitles.join(', ')}]` : '';
    return (
      `queue-feeder [${mode}]: action=invent-product-wave umbrella=${record.selectedRef ?? '(none)'} ` +
      `cap=${cap}${titles}; ${record.skippedCount} skipped — author 1–${cap} product-metric leaves`
    );
  }
  if (record.action === 'skip-invent') {
    const sel = record.selectedRef ? ` selected=${record.selectedRef}` : '';
    return (
      `queue-feeder: action=skip-invent (free=${record.free}, queue empty)${sel} — ` +
      `no safe secondary source (${record.skippedCount} skipped)`
    );
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
    `queue-feeder [${mode}]: action=shred shredded ${record.selectedRef} (${pm}) → ${record.leafCount} leaf(s)` +
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
 * lucy#1587 "acquisition redundancy & failover". Waves 1–8 residual leaves
 * (#2082–#2085, #2351–#2354, #2422–#2424, #2518–#2520, #2551–#2553, #2609–#2611,
 * #2621–#2623 quiet-hours redelivery / EDGAR-only share / newswire RSS;
 * invent wave 5 #2669–#2671 eventDetected/contentStatus, late content-upgrade,
 * identityCorroboration stamp; invent wave 6 #2682–#2684 multi-source body
 * preference, total-miss→corrected brief, event_seen_no_content alert; invent
 * wave 7 #2701–#2703 mid-window host-cooling re-arm, SEC early-promote, IR-over-
 * EDGAR recapture preference; invent wave 8 #2728–#2730 pre-arm ir_url probe,
 * stealth remaining-window budget, verification_reject miss-share alert) shipped
 * and are title-exhausted. Invent wave 9 (#2778–#2780 soft-disable / issuer_feed
 * early-promote on access_denied|tier_blocked / chronic zero-success alert) and
 * invent wave 10 (#2832–#2834 persist soft-disable deadline, park heartbeat,
 * warm-start recovery tests) shipped and are title-exhausted. Invent wave 11
 * (queue-feeder 2026-08-13, invent-product-wave #2069) #2855–#2857
 * (issuer_feed after verification_reject / newswire_feed feed_no_match /
 * stealth cache-miss omit) shipped and are title-exhausted. Invent wave 12
 * (queue-feeder 2026-08-13, invent-product-wave #2069) #2882–#2884
 * (newswire search feed_no_match / persist identityCorroborated=false /
 * split half-open probes out of weekly live fan-out) shipped and are
 * title-exhausted. Invent wave 13 (queue-feeder 2026-08-13, invent-product-wave
 * #2069) #2890–#2892 (classic fetch_error / omit aborted-after-winner /
 * lengthen half-open probe cooldown) shipped and are title-exhausted.
 * Invent wave 14 (queue-feeder 2026-08-13, invent-product-wave #2069)
 * #2915–#2917 (newswire_feed early-promote after page verification_reject /
 * free-surface chronic-zero alert / half-open probe durable-dead pages)
 * shipped and are title-exhausted. Invent wave 15 (queue-feeder 2026-08-13,
 * invent-product-wave #2069) #2922–#2924 (half-open probe chronic-zero
 * degraded stealth/feeds / treat those surfaces as obstructed for SEC
 * early-promote / omit stealth cache-miss from live attempt folds) shipped
 * and are title-exhausted. Invent wave 16 (queue-feeder 2026-08-13,
 * invent-product-wave #2069) #2944–#2946 (window_too_short share alert /
 * window_too_short recapture / complementary dual-session cover) shipped
 * and are title-exhausted. Invent wave 17 (queue-feeder 2026-08-13,
 * invent-product-wave #2069) #2957–#2959 (tier_infra_down share alert /
 * recapture / classify classic fetch_error) shipped and are
 * title-exhausted. Invent wave 18 (queue-feeder 2026-08-13,
 * invent-product-wave #2069) #2968–#2970 (project other from reason /
 * persist reject URL / stamp fetch_error on rejected-tier throws)
 * shipped and are title-exhausted (durable kookr plan never landed on
 * main; titles exist on GitHub). Invent wave 19 (queue-feeder 2026-08-13,
 * invent-product-wave #2069) #2984–#2986 (name issuer-only
 * content_too_short / name issuer-only access_denied / re-resolve
 * listing-hub IR URLs) shipped and are title-exhausted (durable kookr
 * plan never landed on main; titles exist on GitHub). Invent wave 20
 * (queue-feeder 2026-08-17, invent-product-wave #2069) #3061–#3063
 * (finished-watch recapture-terminal / SEC exhibit URL pull / mixed
 * issuer CTS+403 majority) shipped and are title-exhausted. Invent
 * wave 21 (queue-feeder 2026-08-17, invent-product-wave #2069) #3082–#3084
 * (detect-now issuer_feed / stored issuer-or-newswire URL pull /
 * expectedDate-only keep-URL) shipped and are title-exhausted. Invent
 * wave 22 (queue-feeder 2026-08-17, invent-product-wave #2069) #3092–#3094
 * (feedless feed_url discovery / connection-drop stealth / listing-hub
 * href follow) shipped and are title-exhausted. Invent wave 23
 * (queue-feeder 2026-08-17, invent-product-wave #2069) #3114–#3116
 * (stale q4-json re-probe / empty list feed_no_match / IR-advisory
 * clock) shipped and are title-exhausted. Invent wave 24
 * (queue-feeder 2026-08-17, invent-product-wave #2069) #3134–#3136
 * (q4-unvalidated issuer-page continue / advisory event_seen /
 * overview→press-releases persist) shipped and are title-exhausted
 * (lucy PRs #3141 / #3143 / #3140). Invent wave 25
 * (queue-feeder 2026-08-18, invent-product-wave #2069) #3147–#3149
 * (RSS-unvalidated issuer-page continue / news-listing
 * quarterly-earnings persist / financial-results archive stay-live)
 * shipped and are title-exhausted (lucy PRs #3153 / #3155 / #3154).
 * Invent wave 26 (queue-feeder 2026-08-18, invent-product-wave
 * #2069) is the next Goal-1 slice after wave 25: leftovers that
 * the live prod registry still shows on the armed 18–20 Aug cluster
 * (prod sha c7b54c68, deployed 2026-08-18T00:30Z, after wave 25).
 * Deere still has ir_url `investor.deere.com/home/default.aspx`
 * plus an empty q4-json list (`GetPressReleaseListResult: []`).
 * #3115 names that empty list `feed_no_match`; #3134 only
 * continues the issuer HTML page when the list had items that
 * failed the report check. Prod retrieval is skipped
 * (`reason=no matching q4 feed earnings item`) so the homepage
 * is never collected. Analog Devices' press-releases listing
 * already links the 18 Aug "to Report Q3 FY2026 on August 19"
 * advisory (200) *and* `/financial-info/quarterly-results`
 * (200, title "Quarterly Results"). Wave 25 #3148 stamped
 * `financialReportsChildReason=has-current-period-href` and
 * left ir_url on press-releases — the advisory was treated as
 * a current-period earnings file, and even after that, #3148
 * only persists `quarterly-earnings` / `financial-reports`
 * children, not a `quarterly-results` archive. Do not re-file
 * #3147–#3149 / #3134–#3136 / #3114–#3116 / #3092–#3094 /
 * #3156–#3158. Live GitHub leaves are filed this run. Title
 * idempotency prevents re-emit once those exist.
 */
export const LUCY_1587_LEAF_PLAN: readonly LeafSpec[] = Object.freeze([
  Object.freeze({
    title:
      'feat(acquisition): still collect the issuer page when the q4-json press-release list is empty',
    goal:
      'A company JSON press-release feed (q4-json / ' +
      'GetPressReleaseList) can come back empty — nothing ' +
      'published yet. Lucy already names that miss feed_no_match ' +
      '(#3115) and then treats the issuer path as finished. Deere ' +
      'is live-skipped with "no matching q4 feed earnings item" ' +
      'while investor.deere.com/home/default.aspx still loads ' +
      '(HTTP 200, title "John Deere - Investor Relations", empty ' +
      'GetPressReleaseListResult). Wave 24 only continues the ' +
      'issuer HTML page when the list had earnings-looking items ' +
      'that failed the report check (#3134). An empty list is a ' +
      'different miss. This leaf: after an empty q4-json list ' +
      '(historical reason "no matching q4 feed earnings item"), ' +
      'still collect the issuer HTML page and later fallbacks in ' +
      'the same window. Do not re-file #3134 or #3115. Do not ' +
      'rewrite detections.jsonl.',
    acceptanceCriteria: [
      'Trigger: an armed or about-to-arm ticker with a usable ' +
        'q4-json feed_url, and the probe/collect saw an empty ' +
        'GetPressReleaseListResult (reason "no matching q4 feed ' +
        'earnings item", failureCode feed_no_match). Action: still ' +
        'run issuer-page collect and the already-scheduled later ' +
        'fallbacks in the same window. A Deere-shaped row must not ' +
        'skip investor.deere.com/home/default.aspx solely because ' +
        'the JSON list is empty. Do not invent a URL. Do not ' +
        'rewrite detections.jsonl.',
      'A q4-json list whose items fail the report check remains ' +
        '#3134. Naming the empty list feed_no_match remains #3115. ' +
        'A validating current-period q4 item is unchanged ' +
        '(issuer_verified). Operator-aborted and source-blocklisted ' +
        'jobs still skip. Do not add a new miss class. Do not ' +
        're-file #3134 or #3115.',
      'Unit/fixture tests cover: (a) empty GetPressReleaseListResult ' +
        '→ issuer HTML page still attempted; (b) validating q4 item ' +
        'still hits the feed and does not force an extra page; ' +
        '(c) q4 unvalidated-items path unchanged (#3134); ' +
        '(d) aborted/blocklisted skip; (e) no jsonl rewrite.',
    ],
    fileHints: [
      'src/acquisition/tiers/issuer.js (keepIssuerPageAfterQ4FeedMiss / empty-list reason)',
      'src/scheduler-active-window-poll.js (applyQ4UnvalidatedKeepIssuerPage)',
      'src/acquisition/issuer-url-resolver.js (empty GetPressReleaseListResult must not park issuer HTML)',
    ],
    testHints: [
      'unit: empty q4-json list → issuer page still runs',
      'unit: validating q4 item still hits the feed',
      'unit: q4 unvalidated-items miss still follows #3134',
    ],
    labels: ['acquisition', 'product-metric', 'enhancement'],
  }),
  Object.freeze({
    title:
      'feat(acquisition): do not treat a future-tense report advisory as a current-period earnings href',
    goal:
      'A news listing can already link a scheduling advisory ' +
      '("to Report Q3 … on August 19") while the results file is ' +
      'not out yet. Wave 25 #3148 refuses to persist a ' +
      'quarterly-earnings child when the listing has a ' +
      'current-period earnings href. Analog Devices is live on ' +
      'investor.analog.com/press-releases; prod stamped ' +
      'financialReportsChildReason=has-current-period-href and ' +
      'left that URL in place. The only Q3-period href on the ' +
      'page is the 18 Aug advisory (200, title "Analog Devices ' +
      'to Report Third Quarter Fiscal Year 2026 Financial ' +
      'Results on Wednesday, August 19, 2026"). That is a ' +
      'scheduling notice, not a results file. This leaf: a ' +
      'future-tense to-report / conference-call advisory must ' +
      'not count as a current-period earnings href when deciding ' +
      'whether to persist a reports child. Do not re-file #3148 ' +
      'or #3135. Do not rewrite detections.jsonl.',
    acceptanceCriteria: [
      'Trigger: armed or about-to-arm; saved ir_url is a news / ' +
        'press-releases listing; the page links a current-period ' +
        'advisory whose title or slug is future-tense ("to ' +
        'report" / "will report" / conference-call) and does not ' +
        'link a validating current-period earnings file. Action: ' +
        'do not stamp has-current-period-href for that advisory. ' +
        'An Analog-shaped press-releases row must remain eligible ' +
        'to persist a same-host reports child. Do not invent a ' +
        'URL. Do not rewrite detections.jsonl.',
      'A validating current-period earnings release href still ' +
        'counts as current-period (#3148 / #3094 unchanged). An ' +
        'events/advisory/calendar page remains #3135. ' +
        'Operator-aborted and source-blocklisted jobs skip. Do ' +
        'not re-file #3148 or #3135.',
      'Unit/fixture tests cover: (a) "to Report Q3 on <date>" ' +
        'advisory href is not has-current-period-href; (b) a ' +
        'validating current-period earnings href still is; ' +
        '(c) events/calendar page unchanged (#3135); ' +
        '(d) aborted/blocklisted skip; (e) no jsonl rewrite.',
    ],
    fileHints: [
      'src/acquisition/listing-hub-href-follow.js (pickNewsListingFinancialReportsChild / isSchedulingListingText)',
      'src/acquisition/issuer-url-resolver.js (persistNewsListingFinancialReportsChild)',
    ],
    testHints: [
      'unit: to-report advisory href is not has-current-period-href',
      'unit: validating current-period earnings href still blocks persist',
      'unit: events/calendar page still follows #3135',
    ],
    labels: ['acquisition', 'product-metric', 'enhancement'],
  }),
  Object.freeze({
    title:
      'feat(acquisition): persist a same-host quarterly-results child from a news listing',
    goal:
      'Wave 25 #3148 only persists same-host children whose path ' +
      'leaf is quarterly-earnings or financial-reports. Analog ' +
      'Devices already publishes the package at ' +
      'investor.analog.com/financial-info/quarterly-results ' +
      '(HTTP 200, title "Quarterly Results - Analog Devices"). ' +
      'That is a quarterly-results archive, not those two path ' +
      'leaves, so even after an advisory stops blocking persist, ' +
      '#3148 cannot save the child. This leaf: when a news listing ' +
      'has no current-period validating earnings file, persist an ' +
      'already-linked same-host quarterly-results (or ' +
      'financial-info/quarterly-results) child the same way #3148 ' +
      'persists quarterly-earnings. Do not re-file #3148 or #3149. ' +
      'Do not rewrite detections.jsonl.',
    acceptanceCriteria: [
      'Trigger: armed or about-to-arm; saved ir_url is a news / ' +
        'press-releases listing with no current-period validating ' +
        'earnings file; the same host already links a ' +
        'quarterly-results or financial-info/quarterly-results ' +
        'child. Action: persist that child (ir_url or a documented ' +
        'working-IR field) and keep the watch armed. An ' +
        'Analog-shaped press-releases row must not remain the only ' +
        'IR URL through the 19 Aug window when ' +
        '/financial-info/quarterly-results is already on the host. ' +
        'Do not invent a URL. Do not rewrite detections.jsonl.',
      'A quarterly-earnings / financial-reports persist remains ' +
        '#3148. A financial-results archive that is already the ' +
        'working IR URL remains #3149. Missing child is a named ' +
        'skip, not a crash. Operator-aborted and ' +
        'source-blocklisted jobs skip. Do not re-file #3148 or ' +
        '#3149.',
      'Unit/fixture tests cover: (a) news listing + ' +
        'financial-info/quarterly-results child → child persisted ' +
        'and watch stays live; (b) news listing that already has ' +
        'a current-period earnings href unchanged; (c) no child → ' +
        'no write; (d) quarterly-earnings persist unchanged ' +
        '(#3148); (e) aborted/blocklisted skip; (f) no jsonl ' +
        'rewrite.',
    ],
    fileHints: [
      'src/acquisition/listing-hub-href-follow.js (FINANCIAL_REPORTS_SEGMENTS / pickNewsListingFinancialReportsChild)',
      'src/acquisition/issuer-url-resolver.js (persistNewsListingFinancialReportsChild)',
    ],
    testHints: [
      'unit: news listing + quarterly-results child → child persisted',
      'unit: current-period earnings href on the news listing is unchanged',
      'unit: quarterly-earnings persist still follows #3148',
    ],
    labels: ['acquisition', 'product-metric', 'enhancement'],
  }),
]);

/**
 * lucy#1590 "headline metrics in tested code". Wave-1 residual leaves
 * (#2090–#2093 alerts / control-room health / per-tier attribution / weekly
 * acquisition scoreboard) and follow-ons (#2445 backfill, #2464–#2466 cron +
 * control-room threshold surface) shipped; invent wave 2 (#2510–#2512 beforeShare
 * alert / status surface / durable weekly triad aggregator) also title-exhausted.
 * Invent wave 3 (queue-feeder 2026-08-12, invent-product-wave #2069) covers the
 * still-open residual: weekly triad never auto-appends after rollup-nightly,
 * control-room has no week-over-week triad surface, and status/rollup secLead
 * parity is unenforced by canary. Live GitHub leaves #2743–#2745. Title
 * idempotency prevents re-emit once those exist.
 */
export const LUCY_1590_LEAF_PLAN: readonly LeafSpec[] = Object.freeze([
  Object.freeze({
    title:
      'feat(metrics): wire product-metric-trend into detection-rollup nightly so weekly triad grows in prod',
    goal:
      'Close a residual longitudinal hole under umbrella #1590: product-metric-trend.mjs ' +
      '(#2512) can write weekly anchorCoverage/sessionHitRate/beforeShare rows, but nothing ' +
      'in the prod schedule appends them after detection-rollup-nightly refreshes the rollup. ' +
      'Without an automatic path the triad series stays empty or operator-driven, so ' +
      'longitudinal proof that acquisition/data-quality work moved headline metrics never ' +
      'accumulates in LUCY_DATA_DIR.',
    acceptanceCriteria: [
      'detection-rollup-nightly.sh (or a sibling install-*-cron path documented next to ' +
        'detection-rollup) invokes product-metric-trend in append mode against the same ' +
        'absolute LUCY_DATA_DIR after a successful rollup write — weekly product-metric-trend ' +
        'JSONL/JSON under that data dir gains or upserts the current ISO week row without ' +
        'manual CLI.',
      'When rollup write fails or LUCY_DATA_DIR is unset/relative, trend append is skipped ' +
        'with a non-fatal log line (same fail-open discipline as other nightly side jobs) and ' +
        'must not flip the rollup script\'s primary exit to hard-fail solely because trend failed.',
      'Unit/script tests or fixture dry-run: (a) successful rollup path triggers trend ' +
        'invocation with expected out paths; (b) rollup failure/skip does not require trend; ' +
        '(c) npm script / install docs mention the chained schedule so operators can --check ' +
        'the combined path.',
    ],
    fileHints: [
      'scripts/detection-rollup-nightly.sh',
      'scripts/product-metric-trend.mjs',
      'src/product-metric-trend.js',
      'scripts/install-detection-rollup-cron.sh',
      'package.json (product-metric:trend)',
    ],
    testHints: [
      'script/fixture: mock rollup success → trend CLI invoked with LUCY_DATA_DIR',
      'script/fixture: rollup failure → trend not required for primary exit',
    ],
    labels: ['product-metric', 'enhancement'],
  }),
  Object.freeze({
    title:
      'feat(metrics): control-room surfaces weekly triad trend from product-metric-trend.jsonl',
    goal:
      'Close a residual presentation hole under umbrella #1590: weekly product-metric-trend ' +
      'rows may exist on disk, but operators still cannot answer \'did anchorCoverage / ' +
      'sessionHitRate / beforeShare improve week-over-week?\' from the control room alone. ' +
      'Point-in-time productMetricHealthSnapshot shows latest rates; the longitudinal triad ' +
      'must be a first-class control-room surface with denominators.',
    acceptanceCriteria: [
      'Control-room snapshot/compose (or product-metrics panel) projects the last N weekly ' +
        'triad rows from product-metric-trend.jsonl (or .json) under LUCY_DATA_DIR: week id, ' +
        'anchorCoverage, sessionHitRate when measurable, beforeShare when measurable, and ' +
        'sample denominators — scannable without opening the raw file.',
      'Missing/empty trend file or unparseable rows degrade to an explicit data-gap state ' +
        '(not a crash, not fabricated rates). Zero-anchor / null beforeShare weeks render gap ' +
        'phrases consistent with secLead zero-anchor contract.',
      'Unit/fixture tests: (a) multi-week fixture → panel/snapshot fields match rows; ' +
        '(b) missing file → gap; (c) partial null metrics week → no fabricated share.',
    ],
    fileHints: [
      'src/control-room-snapshot-compose.js',
      'src/control-room/',
      'src/product-metric-trend.js',
      'src/product-metric-alerts.js (productMetricHealthSnapshot pattern)',
      'data/product-metric-trend.jsonl',
    ],
    testHints: [
      'unit: fixture trend JSONL → snapshot weekly triad fields',
      'unit: missing trend → data-gap, no throw',
    ],
    labels: ['product-metric', 'product-surface-ux', 'enhancement'],
  }),
  Object.freeze({
    title:
      'feat(metrics): canary fails when status secLead fields diverge from latest detection-rollup row',
    goal:
      'Enforce the #1590 acceptance that flagship SEC-lead numbers are code-sourced and ' +
      'byte-reproducible from detection-rollup.jsonl: if productMetricHealthSnapshot / status ' +
      'secLead (beforeShare, median lead, anchored/total) disagree with the latest durable ' +
      'rollup secLead row under LUCY_DATA_DIR, a canary or pure comparator must fail loudly ' +
      'so prose/status drift cannot silently reappear after the #1966 rollup path.',
    acceptanceCriteria: [
      'A pure comparator (plus optional CLI/canary script) loads the latest detection-rollup ' +
        'secLead row and the status/health snapshot projection and returns ok only when ' +
        'beforeShare (or before/total), medianLeadSec when both present, and anchored/total ' +
        'denominators match within documented tolerance (exact for counts; float share within ' +
        'epsilon).',
      'Mismatch, missing rollup while status claims numeric lead, or status fabricating a ' +
        'median on zero-anchor when rollup says anchored=0 → non-zero canary / failed ' +
        'comparator with a structured diff (fields + both values).',
      'Unit tests: (a) matching fixture → ok; (b) beforeShare drift → fail; (c) zero-anchor ' +
        'rollup vs numeric status median → fail; (d) both missing → ok or explicit skip, not crash.',
    ],
    fileHints: [
      'src/product-metric-alerts.js',
      'scripts/detection-report.mjs',
      'src/acquisition/status.js',
      'scripts/sec-anchor-canary-nightly.sh (pattern reuse)',
      'test/product-metric-alerts.test.js',
    ],
    testHints: [
      'unit: matching rollup+snapshot → ok',
      'unit: beforeShare mismatch → fail with field names',
      'unit: zero-anchor vs fabricated median → fail',
    ],
    labels: ['product-metric', 'enhancement'],
  }),
]);

/**
 * lucy#1586 "publish-window-safe issuer acquisition". Core children #1583
 * (verification_reject not sticky), #1491 (VZ EX-99 classic gate), and
 * #1536/#1526 (possible_gate_miss failureCode) shipped; residual acceptance
 * gaps remain: content_too_short still sticky on IR roots (umbrella taxonomy
 * residual), an end-to-end multi-poll publish-window fixture, measurable
 * issuer cooling attribution, and host_cooling_down provenance for weekly
 * "zero from verification_reject cooling" proof.
 * Authored by the queue-feeder (2026-08-03) after needsAuthoring blocked emit.
 * Live GitHub leaves: filed this run; openChildrenCount / title idempotency
 * prevents re-emit once those exist.
 */
export const LUCY_1586_LEAF_PLAN: readonly LeafSpec[] = Object.freeze([
  Object.freeze({
    title:
      'feat(acquisition): armed IR root content_too_short must not open durable host circuit',
    goal:
      'Finish the host-circuit failure-code taxonomy residual from umbrella #1586: ' +
      'content-level `content_too_short` on a ticker\'s configured IR root during an ' +
      'armed window must not open a multi-minute sticky host circuit the way host ' +
      'outages do — same class of publish-window blind as pre-#1583 verification_reject.',
    acceptanceCriteria: [
      'While a watch is armed, consecutive `content_too_short` outcomes against the ' +
        'resolved issuer IR host do not open a durable host-circuit entry that short-circuits ' +
        'later polls with `host_cooling_down` for minutes (unit/fixture proof).',
      'True host walls (`access_denied`, `empty_spa_shell`, `stealth_failed`, rate/upstream) ' +
        'still open the sticky circuit — taxonomy split is content-level vs host-level, not ' +
        '"disable all cooling".',
      'Unit tests cover: (a) armed IR content_too_short chain does not sticky-open; ' +
        '(b) access_denied still sticky-opens; (c) non-armed or non-IR hosts keep existing ' +
        'behavior unless a narrower class-wide content rule is documented.',
    ],
    fileHints: [
      'src/acquisition/host-circuit.js',
      'src/acquisition/acquire.js',
      'src/document-fetch.js',
      'src/config.js (acqHostCircuit*)',
    ],
    testHints: [
      'unit test: armed IR root + N content_too_short → isOpen false; access_denied → isOpen true',
    ],
    labels: ['acquisition', 'product-metric', 'enhancement'],
  }),
  Object.freeze({
    title:
      'test(acquisition): AXP-class multi-poll publish-window fixture never cools issuer on verification_reject',
    goal:
      'Lock umbrella #1586 acceptance with a multi-poll acquire/fixture timeline: ' +
      'pre-publish IR verification_reject polls, then a usable release — assert the ' +
      'issuer tier is never short-circuited with host_cooling_down at publication time.',
    acceptanceCriteria: [
      'A fixture (or acquire-path integration test) replays ≥3 pre-publish ' +
        '`verification_reject` outcomes on an IR host followed by a usable issuer doc at ' +
        'publication; the issuer path is never skipped solely because of ' +
        '`failureCode=host_cooling_down` from those rejects.',
      'Assertion fails if sticky host-circuit state for `verification_reject` reappears ' +
        '(regression of #1583) or if acquire short-circuits the IR host mid-window for that class.',
      'Test is hermetic (no live network); documents the AXP residual class in a short comment.',
    ],
    fileHints: [
      'test/host-circuit.test.js',
      'test/acquisition-acquire.test.js',
      'src/acquisition/host-circuit.js',
      'src/acquisition/acquire.js',
    ],
    testHints: [
      'integration/unit fixture: multi-poll verification_reject then success; assert no host_cooling_down short-circuit',
    ],
    labels: ['acquisition', 'product-metric', 'enhancement'],
  }),
  Object.freeze({
    title:
      'feat(acquisition): attribute host_cooling_down short-circuits to underlying failureClass',
    goal:
      'When a poll is short-circuited with host_cooling_down, record the underlying ' +
      'sticky failureClass (access_denied, content_too_short, rate_limited, …) on the ' +
      'outcome/scoreboard so operators can prove cooling causes — not only that cooling happened.',
    acceptanceCriteria: [
      'Issuer (or document-fetch) outcomes with failureCode=host_cooling_down include a ' +
        'stable field for the underlying circuit failureClass (e.g. reason detail, ' +
        'coolingClass, or nested diagnostic) sourced from host-circuit open state.',
      'Scoreboard / byFailureCode path either counts host_cooling_down with underlying class ' +
        'visible, or dual-counts in a documented way so weekly reports can filter "cooling ' +
        'from verification_reject" (must be zero post-#1583) vs host walls.',
      'Unit test: open circuit for access_denied → short-circuit outcome exposes access_denied ' +
        'as underlying class; verification_reject never appears as an open circuit class.',
    ],
    fileHints: [
      'src/acquisition/host-circuit.js',
      'src/document-fetch.js',
      'src/acquisition/scoreboard.js',
      'src/acquisition/acquire.js',
    ],
    testHints: [
      'unit test: isOpen short-circuit payload includes failureClass; scoreboard fixture preserves it',
    ],
    labels: ['acquisition', 'product-metric', 'enhancement'],
  }),
  Object.freeze({
    title:
      'feat(acquisition): weekly metric for issuer tier_blocked_all_window / host_cooling_down',
    goal:
      'Make umbrella #1586 acceptance measurable over a full earnings week: a pure ' +
      'aggregator (or weekly scoreboard field) counts issuer-tier ' +
      'tier_blocked_all_window and host_cooling_down events from detections/scoreboard ' +
      'so "drops to zero" is a number, not operator memory.',
    acceptanceCriteria: [
      'A pure function (and optional CLI/script) reads detections.jsonl and/or window ' +
        'scoreboard snapshots and reports counts of issuer-tier tier_blocked_all_window ' +
        'and host_cooling_down (optionally split by underlying failureClass) for a ' +
        'configurable week window.',
      'Unit tests cover a fixture JSONL/scoreboard: known issuer cooling + tier_blocked ' +
        'events → expected counts; empty input degrades cleanly.',
      'Output is durable JSON (or weekly-scoreboard field) so daily-report / control-room ' +
        'can surface "issuer cooling blocks this week: N" without recomputing in prose.',
    ],
    fileHints: [
      'src/acquisition/weekly-scoreboard.js',
      'src/acquisition/anomaly.js',
      'src/acquisition/scoreboard.js',
      'data/detections.jsonl consumers',
    ],
    testHints: [
      'unit test: synthetic detections/scoreboard fixture → issuer cooling + tier_blocked counts match hand totals',
    ],
    labels: ['acquisition', 'product-metric', 'enhancement'],
  }),
]);


/**
 * lucy#1593 "replay-corpus validity — backtesting-audit P0.3/P1 roadmap".
 * P0.3 experiment-verify gate (#1233) and core price-audit/extremum CLI (#1234)
 * shipped; residual acceptance gaps: expected_move_missing named regime + dual
 * metrics (P1.3), unresolved extrema as report warnings (P1.2 residual),
 * per-row label-audit trail (P1.1), second-provider OHLC plumbing (P1.1).
 * Authored by the queue-feeder (2026-08-02) after needsAuthoring blocked emit.
 * Live GitHub leaves: #2106–#2109; openChildrenCount / title idempotency
 * prevents re-emit once those exist.
 */
export const LUCY_1593_LEAF_PLAN: readonly LeafSpec[] = Object.freeze([
  Object.freeze({
    title:
      'feat(backtest): name expected_move_missing regime; dual score with/without fallback rows',
    goal:
      'Treat missing point-in-time expected move as a named regime (expected_move_missing), ' +
      'not a silent ±1% band, and report scorecard metrics both with and without fallback rows ' +
      'so n_fallback is countable and zero silent ±1% labels remain (umbrella #1593 P1.3).',
    acceptanceCriteria: [
      'When dossier expectedMove is absent/null, the label records a stable regime/flag (e.g. expected_move_missing or materialBandSource=fallback_1pct) rather than only applying ±1% with no provenance.',
      'score/html-report (or scorecard) expose n_fallback (count of rows using the fallback band) and dual headline metrics: full corpus vs excluding expected_move_missing fallback rows.',
      'Unit tests: (a) row without expected move is tagged and counted in n_fallback; (b) dual metrics differ when fallback rows change realizedDir; (c) rows with real expected move are not counted as fallback.',
    ],
    fileHints: [
      'backtest/label.js',
      'backtest/score.js',
      'backtest/html-report.js',
      'backtest/LABEL-SPEC.md',
    ],
    testHints: [
      'unit test: fixture rows with/without expMove → n_fallback + dual precision match hand counts',
    ],
    labels: ['product-metric', 'enhancement'],
  }),
  Object.freeze({
    title:
      'feat(backtest): surface unresolved price-audit extrema as html-report warnings',
    goal:
      'Wire the existing backtest:price-audit extremum output into score/html-report so ' +
      'unresolved extrema and acted misses are first-class report warnings/artifacts, ' +
      'not only a standalone CLI JSON dump (umbrella #1593 P1.2 residual).',
    acceptanceCriteria: [
      'html-report (or score path) can ingest a price-audit report (or run auditPriceRows on the scored set) and renders a warning section when any extremum/acted-miss row has status unresolved or missing independent confirmation.',
      'A durable audit artifact path is documented or written (JSON under the experiment dir or report sibling) so extremum-audit output is committed/attachable as the umbrella acceptance requires.',
      'Unit/fixture test: audit fixture with one unresolved extremum → report HTML/text contains a visible warning and the key; all-confirmed fixture → no unresolved warning.',
    ],
    fileHints: [
      'backtest/price-audit.js',
      'backtest/html-report.js',
      'backtest/score.js',
    ],
    testHints: [
      'unit test: inject price-audit report with unresolved row → html-report warning panel present',
    ],
    labels: ['product-metric', 'enhancement'],
  }),
  Object.freeze({
    title:
      'feat(backtest): persist per-row label-audit trail (SEC agreement, candidates, chosen-anchor)',
    goal:
      'Persist an auditable per-row label trail covering raw SEC header/JSON agreement, ' +
      'issuer/newswire candidate timestamps, chosen-anchor reason, and price request/response ' +
      'hashes so label choices are reconstructable without re-fetch (umbrella #1593 P1.1).',
    acceptanceCriteria: [
      'Each labeled row (or sidecar audit record) retains: SEC acceptance/header agreement fields when available, candidate timestamps considered, chosen-anchor reason/code, and price provenance hashes already produced by the price path.',
      'Audit records are durable JSON/JSONL (per-row or experiment-level) loadable offline; schema version is documented.',
      'Unit tests cover a fixture label path: known candidates + chosen reason + hash → trail fields present; missing SEC data degrades with explicit nulls rather than silent omission of the trail object.',
    ],
    fileHints: [
      'backtest/label.js',
      'backtest/acceptance-anchor-verify.js',
      'backtest/yahoo.js / reaction-window price provenance',
    ],
    testHints: [
      'unit test: label fixture emits labelAudit with candidates, chosen-anchor reason, price hashes',
    ],
    labels: ['product-metric', 'enhancement'],
  }),
  Object.freeze({
    title:
      'feat(backtest): second-provider OHLC comparison plumbing for price-audit (operator-gated)',
    goal:
      'Add plumbing so price-audit can consume a second OHLC provider comparison when the ' +
      'operator supplies credentials/export — provider choice stays operator-gated; no new ' +
      'mandatory paid API (umbrella #1593 P1.1 plumbing only).',
    acceptanceCriteria: [
      'Documented adapter/CLI path feeds independent OHLC confirmations into auditPriceRows (existing --confirmations or a thin second-provider export script) without hard-coding a single paid vendor in production defaults.',
      'Comparison results attach absolute/relative deltas and agreement status per audited row; missing second provider yields explicit \'no independent confirmation\' rather than false agreement.',
      'Unit tests: mock confirmation map → agreement/disagreement flags; empty confirmations → all audited rows flagged missing confirmation without throwing.',
    ],
    fileHints: [
      'backtest/price-audit.js',
      'backtest/yahoo.js',
      'docs/backtesting-runbook.md (operator second-provider section)',
    ],
    testHints: [
      'unit test: confirm adapter fixture → priceAudit agreement fields; empty confirm → unresolved',
    ],
    labels: ['product-metric', 'enhancement'],
  }),
]);

/**
 * lucy#1589 "forward-corpus denominator hygiene — exclude replays, measure the
 * BMO lane, name the sparse-tape regime". Residual after #1486 open items and
 * prior PRs (#1481/#1482/#1508/#1572/#1558/#1571): structural captureMode
 * provenance, BMO session-stamp contract, unusable-row regime taxonomy,
 * blockingQualityFlags canary on real ledger shape, weekly denominator report.
 * Skips operator-only NBBO entitlement fork (decision memo remains OPERATOR).
 * Authored by the queue-feeder (2026-08-03) after needsAuthoring blocked emit.
 * Live GitHub leaves: #2114–#2118; openChildrenCount / title
 * idempotency prevents re-emit once those exist.
 */
export const LUCY_1589_LEAF_PLAN: readonly LeafSpec[] = Object.freeze([
  Object.freeze({
    title:
      'feat(outcomes): structural captureMode live|recovery_sweep at ledger write',
    goal:
      'Stamp every forward outcome with structural captureMode (live | recovery_sweep) ' +
      'at write time so product denominators can filter recovery-sweep replays without ' +
      'hand-listed symbols (umbrella #1589 / #1486 checkbox (c)).',
    acceptanceCriteria: [
      'Outcome / forward-ledger write path records a stable captureMode field with ' +
        'allowed values live and recovery_sweep (or equivalent documented enum); recovery ' +
        'sweeps and recapture/replay writers set recovery_sweep, normal publish-window ' +
        'first-write sets live.',
      'At least one product denominator filter (scorecard, digest, or weekly report ' +
        'helper) excludes recovery_sweep by default or documents an explicit include-replays ' +
        'flag — RF/PNC/COF-class sweep rows no longer count as capture-eligible n without ' +
        'an opt-in.',
      'Unit tests: (a) live write → captureMode=live; (b) recovery_sweep writer → ' +
        'captureMode=recovery_sweep; (c) denominator helper drops recovery_sweep from ' +
        'eligible n when filter is on.',
    ],
    fileHints: [
      'src/verdict-outcomes.js',
      'src/scheduler-pending-verdict-recovery.js',
      'backtest/reaction-window.js',
      'data/detections.jsonl consumers / outcome ledger writers',
    ],
    testHints: [
      'unit test: writeOutcome fixture with recovery path vs live path sets captureMode; filter counts match',
    ],
    labels: ['product-metric', 'enhancement'],
  }),
  Object.freeze({
    title:
      'fix(outcomes): BMO session stamp only for true pre_market publications',
    goal:
      'Stop labeling regular-hours / mid-afternoon publications as -bmo: define and ' +
      'enforce the BMO measurability contract so 14:40 ET rows cannot get a BMO session ' +
      'suffix (umbrella #1589 / #1486 checkbox (d)).',
    acceptanceCriteria: [
      'Session / eventId stamping treats BMO only when publication (or scheduled session) ' +
        'is true pre-market BMO; a 14:40 ET (18:40Z) publication must not produce a -bmo ' +
        'eventId/session label.',
      'Regression test locks TMUS/FCX-class counterexample (publicationTsUtc ~18:40Z, ' +
        'pre-window drift 0) → not classified as BMO product lane; a genuine BMO pre_market ' +
        'fixture still stamps BMO.',
      'One-time or scripted audit path (test or CLI) can list existing ledger rows that ' +
        'violate the contract (optional write-up in PR body with count), without requiring ' +
        'destructive rewrite of history in this leaf.',
    ],
    fileHints: [
      'src/verdict-identity.js',
      'src/verdict-outcomes.js',
      'src/scheduled-analysis-delivery.js',
      'docs/calibration.md (BMO measurability contract note)',
    ],
    testHints: [
      'unit test: 14:40 ET publication → no -bmo; pre_market BMO fixture → -bmo retained',
    ],
    labels: ['product-metric', 'enhancement', 'bug'],
  }),
  Object.freeze({
    title:
      'feat(outcomes): unusable-row regime taxonomy sparse_after_hours_tape etc.',
    goal:
      'Give every unusable forward row a named regime tag (sparse_after_hours_tape, ' +
      'missing_baseline, stale_baseline, no_entitlement_nbbo, …) surfaced per-row and ' +
      'aggregated so unusable rows self-explain instead of silent exclusion (umbrella #1589).',
    acceptanceCriteria: [
      'Unusable / non-product-usable rows carry a stable regime (or equivalent enum field) ' +
        'from a documented taxonomy including at least sparse_after_hours_tape, ' +
        'missing_baseline, stale_baseline, and no_entitlement_nbbo (plus optional ' +
        'recovery_sweep / mislabeled_session when derived elsewhere).',
      'Digest, html-report, or weekly helper aggregates counts by regime; a fixture with ' +
        'mixed unusable causes yields non-zero per-regime counts that match hand totals.',
      'Unit tests cover mapping from qualityFlags / blocking flags / session state into ' +
        'regime tags and prove unknown causes get an explicit other/unknown regime rather ' +
        'than null silence.',
    ],
    fileHints: [
      'backtest/reaction-window.js',
      'backtest/reaction-pnl.js',
      'src/verdict-outcomes.js',
      'backtest/html-report.js',
    ],
    testHints: [
      'unit test: fixture rows with sparse/missing/stale/no-entitlement flags → correct regime + aggregate counts',
    ],
    labels: ['product-metric', 'enhancement'],
  }),
  Object.freeze({
    title:
      'test(outcomes): blockingQualityFlags canary on real ledger row shape',
    goal:
      'Prove #1508 blockingQualityFlags survives onto REAL ledger/outcome row shape ' +
      '(not only reaction-window internals) with a canary fixture so unusable rows remain ' +
      'diagnosable from the stored record (umbrella #1589 / #1486 checkbox (b)).',
    acceptanceCriteria: [
      'A canary fixture (or integration unit) builds or loads a ledger/outcome row in the ' +
        'production shape written by verdict-outcomes and asserts blockingQualityFlags is ' +
        'present, non-empty for a known blocking case, and distinct from non-blocking ' +
        'qualityFlags noise (e.g. terminal_noise_high alone does not satisfy the canary).',
      'If production write path still drops blockingQualityFlags, the leaf fails the canary ' +
        'and fixes the write path so emitted rows retain the field (closes the #1486 gap).',
      'Test is hermetic (fixture JSON or in-memory writer); documents the post-#1508 ' +
        'contract in a short comment or assertion message.',
    ],
    fileHints: [
      'src/verdict-outcomes.js',
      'backtest/reaction-window.js',
      'test/ (verdict-outcomes / reaction-window canary)',
      'PR #1508 prior art',
    ],
    testHints: [
      'canary unit: synthetic blocking reaction → ledger row.blockingQualityFlags includes expected codes',
    ],
    labels: ['product-metric', 'enhancement'],
  }),
  Object.freeze({
    title:
      'feat(metrics): weekly forward-denominator integrity report JSONL',
    goal:
      'Ship a weekly denominator-integrity report: capture-eligible n, per-regime ' +
      'exclusions, usable n, and days-to-gate-threshold projection so product n is a ' +
      'durable number (umbrella #1589; pairs with headline metrics U5).',
    acceptanceCriteria: [
      'A pure aggregator (and optional CLI) reads outcome/detection ledger JSONL and emits ' +
        'durable weekly JSON/JSONL with: captureEligibleN (post captureMode filter), ' +
        'exclusionsByRegime, usableN, and a simple days-to-threshold projection given ' +
        'current weekly usable rate and docs/calibration.md gate (~20–30).',
      'Unit tests: synthetic week fixture with known live/recovery_sweep/regime mix → ' +
        'hand-computed fields match; empty input degrades cleanly.',
      'Output path is documented (e.g. data/ or experiment dir) so daily-report / ' +
        'control-room can surface it without re-deriving in prose.',
    ],
    fileHints: [
      'src/acquisition/weekly-scoreboard.js (or sibling weekly-denominator.js)',
      'docs/calibration.md',
      'data/detections.jsonl / outcome ledger readers',
    ],
    testHints: [
      'unit test: fixture week → captureEligibleN, exclusionsByRegime, usableN, projection match hand totals',
    ],
    labels: ['product-metric', 'enhancement'],
  }),
]);

/**
 * lucy#1594 "pre-registered forward contracts + frozen holdout — backtesting-audit
 * P2". Residual acceptance from the 2026-07-25 self-reflection U9 / audit P2:
 * versioned action-contract config with anti-backdating grade gate, frozen
 * calibration/holdout manifest (scorer refuses tune-on-holdout), structured
 * leakage arms on a frozen inventory, model-cutoff/memorization control for
 * post-cutoff claims, and regime-timing haircuts / peer-relative baselines on
 * the contract scorecard. Skips OPERATOR-only NBBO entitlement and pure inquiry
 * re-seed process work (bounded one-repair seeds remain a separate ops seed).
 * Authored by the queue-feeder (2026-08-03) after needsAuthoring blocked emit.
 * Live GitHub leaves: emitted this run; openChildrenCount / title
 * idempotency prevents re-emit once those exist.
 */
export const LUCY_1594_LEAF_PLAN: readonly LeafSpec[] = Object.freeze([
  Object.freeze({
    title:
      'feat(backtest): versioned action-contract registry with anti-backdating grade gate',
    goal:
      'Commit a versioned action-contract config (thresholds, latency buckets, ' +
      'execution costs, min coverage) that must pre-date scored events, and make ' +
      'the report refuse to grade any row against a contract registered after that ' +
      "row's event date (umbrella #1594 / audit P2.2).",
    acceptanceCriteria: [
      'A durable, versioned action-contract registry (JSON/module) records at least: selective-precision thresholds, latency buckets, execution-cost schedule ids, and min coverage / min-n; each revision has a stable id + registeredAt (UTC date or ISO timestamp) committed in-repo before use.',
      'Score/report/contract-scorer path refuses to grade a row (or marks the row/contract pair unavailable with an explicit backdated_contract / contract_postdates_event reason) when the chosen contract revision\'s registeredAt is strictly after the row\'s event/publication date — proven by a back-dated fixture test that fails open grading and passes only after the registry timestamp is corrected.',
      'Unit tests: (a) contract registered before event grades normally; (b) same contract with registeredAt after event is refused with a stable reason code; (c) registry load fails closed on missing required fields rather than silently defaulting promotion-grade thresholds.',
    ],
    fileHints: [
      'backtest/contract-outcome.js',
      'backtest/contract-scorer.js',
      'backtest/score.js',
      'backtest/html-report.js',
      'docs/backtesting-audit-2026-07-11.md (P2)',
    ],
    testHints: [
      'unit test: back-dated fixture → grade refused with backdated_contract; pre-dated fixture → grades',
    ],
    labels: ['product-metric', 'enhancement'],
  }),
  Object.freeze({
    title:
      'feat(backtest): frozen calibration/holdout manifest; scorer refuses tune-on-holdout',
    goal:
      'Ship a committed frozen calibration/holdout split manifest and make the ' +
      'scorer/threshold selector mechanically refuse to tune or select operating ' +
      'points on holdout rows (umbrella #1594 / audit P2.1).',
    acceptanceCriteria: [
      'A versioned holdout manifest (event ids and/or date boundary + schema version) is loadable offline and stamped onto score/report output so the calibration vs holdout partition is reconstructable without re-deriving fractions.',
      'Confidence/threshold (and any rule/sweep) selection paths that claim holdout discipline only fit/select on calibration rows; any attempt to include holdout rows in the selection set throws or returns a hard error status (e.g. holdout_leak) rather than silently reporting a snooped bar.',
      'Unit tests: (a) fixture manifest partitions known rows into cal/holdout; (b) selector with holdout rows injected into the fit set fails closed; (c) report path that only reads holdout once still succeeds for reporting metrics.',
    ],
    fileHints: [
      'src/scorecard-stats.js',
      'backtest/calibration.js',
      'backtest/score.js',
      'backtest/html-report.js',
      'backtest/midcap-lag-prereg.js (prereg pattern reference)',
    ],
    testHints: [
      'unit test: holdout rows in fit set → error; cal-only fit + holdout report once → ok',
    ],
    labels: ['product-metric', 'enhancement'],
  }),
  Object.freeze({
    title:
      'feat(backtest): structured leakage-arm harness on frozen contract inventory',
    goal:
      'Run named leakage arms (name-redaction, temporal-recall, precision-vs-days-after-cutoff) ' +
      'against one verified frozen inventory and surface paired results next to ' +
      'contract headlines so promotion claims cannot ignore leakage (umbrella #1594 / audit P2.4).',
    acceptanceCriteria: [
      'A documented leakage-arm runner (CLI or library) accepts a frozen inventory path + model/prompt pins and emits arm results with arm id, n, primary metric, and paired comparison vs the baseline arm on the same row set.',
      'Score/html-report (or contract-scorer companion) can attach or link leakage-arm results to the experiment; missing arms on a promotion-grade claim produce an explicit warning or non-promotable flag rather than silence.',
      'Unit tests: mock inventory → at least two arms produce stable JSON; mismatched row sets between arms fail validation; report helper surfaces a missing-arm warning fixture.',
    ],
    fileHints: [
      'backtest/probe.js',
      'backtest/score.js',
      'backtest/html-report.js',
      'backtest/contract-scorer.js',
      'rfc/RFC-001-backtesting-and-calibration.md (§ leakage)',
    ],
    testHints: [
      'unit test: fixture inventory → leakage arms JSON schema; missing arm → non-promotable flag',
    ],
    labels: ['product-metric', 'enhancement'],
  }),
  Object.freeze({
    title:
      'feat(backtest): model-cutoff map + memorization control for post-cutoff claims',
    goal:
      'Pin per-model training cutoffs and treat likely-memorized earnings dates as a ' +
      'named regime so post-cutoff accuracy claims cannot silently include parametric ' +
      'memorization (umbrella #1594; arXiv:2605.24564 / kb quant-trading).',
    acceptanceCriteria: [
      'A versioned model→cutoff map (at least the models Lucy uses for earnings analysis/replay) is committed and consulted when labeling rows as pre_cutoff, post_cutoff, or unknown_cutoff.',
      'Scorecard/report exposes dual or filtered headline metrics excluding unknown_cutoff and optionally pre_cutoff-only diagnostics; rows near the cutoff boundary are bucketed (existing precision-near-cutoff path may be reused) with an explicit memorization_risk flag or regime when the report date is before/at cutoff for that model.',
      'Unit tests: (a) known model id → cutoff applied; (b) report date before cutoff tagged pre_cutoff/memorization_risk; (c) post_cutoff-only metric n differs from full-corpus n on a mixed fixture.',
    ],
    fileHints: [
      'backtest/replay-import.js (existing GPT_OSS cutoff)',
      'backtest/score.js',
      'backtest/html-report.js',
      'backtest/label.js',
    ],
    testHints: [
      'unit test: mixed pre/post cutoff fixture → dual metrics + memorization_risk tags',
    ],
    labels: ['product-metric', 'enhancement'],
  }),
  Object.freeze({
    title:
      'feat(backtest): regime-timing haircut + peer-relative baseline on contract scorecard',
    goal:
      'Add regime-timing haircuts and a peer-relative baseline arm to the contract ' +
      'scorecard so headline precision is not only pooled across regimes (umbrella ' +
      '#1594; arXiv:2604.18821 / residual of closed #560 on the RFC-014 contract path).',
    acceptanceCriteria: [
      'Contract scorecard/report can stratify or haircut headline metrics by at least one regime dimension (e.g. session AMC/BMO, market regime proxy, or calendar cohort) with n and metric per stratum; strata below min-n are marked underpowered rather than pooled silently.',
      'A peer-relative (or sector-excess) baseline is computed on the same acted-usable contract row set as the model headline and shown alongside always-buy/always-short where price inputs allow; when peer data is missing the baseline is unavailable with a reason, not invented.',
      'Unit tests: fixture with two regimes → stratified metrics match hand counts; peer baseline present when peer returns supplied; missing peer → unavailable reason without crashing the model headline.',
    ],
    fileHints: [
      'backtest/contract-scorer.js',
      'backtest/score.js',
      'backtest/html-report.js',
      'src/scorecard-stats.js',
    ],
    testHints: [
      'unit test: two-regime fixture → stratified n/metric; peer baseline optional path',
    ],
    labels: ['product-metric', 'enhancement'],
  }),
]);

/**
 * Kookr #1548's remaining concrete acceptance gap is the explicitly
 * human-gated worktree cleanup. Keep the wave operationally narrow: reconcile
 * the `main` binding and rescue snapshot first, remove only an exactly
 * revalidated target after owner approval, then verify both dispositions.
 * No leaf authorizes branch deletion or an unreviewed destructive operation.
 */
export const KOOKR_1548_LEAF_PLAN: readonly LeafSpec[] = Object.freeze([
  Object.freeze({
    title: 'audit(worktrees): classify the stale main-bound worktree for #1548',
    goal:
      'Inspect the worktree currently binding branch `main` and the rescue snapshot, then publish a ' +
      'durable evidence record of their identity, ignored files, staged/dirty state, and reachability.',
    acceptanceCriteria: [
      'The audit records fresh `git worktree list --porcelain`, repository identity, path, HEAD/branch, ahead/behind, status/diff summary, and ignored-file evidence for the exact `main` binding and `rescue/gitlab-enoent-staged-snapshot` candidate.',
      'The result is posted on umbrella #1548 with an explicit disposition for both candidates: safe for owner-approved removal, retain/protect, or blocked because user work requires review.',
      'The audit performs no worktree removal, branch deletion, force operation, or file overwrite.',
    ],
    fileHints: ['git worktree list/status evidence', 'kookr#1548 residual acceptance item'],
    testHints: ['read-only shell evidence with the target path and branch identity captured'],
    labels: ['enhancement', 'automation-blocked'],
  }),
  Object.freeze({
    title: 'chore(worktrees): remove the audited main-bound worktree after #1548 owner approval',
    goal:
      'Resolve the audited stale `main` worktree binding only after immediate identity revalidation ' +
      'and explicit owner approval, while keeping the branch and all reachable commits intact.',
    acceptanceCriteria: [
      'Immediately before removal, fresh `git worktree list --porcelain` plus repository identity, path, HEAD, branch, primary-worktree, and ignored-file checks match the audited non-primary target; #1548 must contain explicit owner approval covering the staged/dirty/ignored-file disposition, otherwise the leaf records a blocker and makes no change.',
      'After those guards pass, `git worktree remove --force` may target only that exact non-primary path; it never deletes the branch, and any identity change, primary binding, or missing rescue-snapshot disposition stops the operation.',
      'The post-operation evidence confirms the `main` branch and its commits remain reachable and records the outcome plus the rescue-snapshot disposition on #1548.',
    ],
    fileHints: ['git worktree remove with keep-branch semantics', 'git status --ignored evidence', 'kookr#1548 residual acceptance item'],
    testHints: ['command transcript proving immediate identity/HEAD/path revalidation, ignored-file review, exact-target, and owner-approval guards'],
    labels: ['enhancement', 'automation-blocked'],
  }),
  Object.freeze({
    title: 'verify(worktrees): confirm the main checkout invariant after #1548 cleanup',
    goal:
      'Verify the delivery-debt cleanup outcome so no worktree still binds `main`, the rescue snapshot ' +
      'has a recorded disposition, and the primary Kookr checkout remains on a named working branch.',
    acceptanceCriteria: [
      'A fresh `git worktree list --porcelain` shows no worktree on `refs/heads/main` after the approved cleanup, or records the exact remaining human blocker on #1548.',
      'The primary Kookr checkout reports a named branch, the retained `main` ref remains reachable from the repository without changing tracked source, and the rescue/gitlab-enoent-staged-snapshot candidate has an explicit retain/protect, removed-after-approval, or blocked disposition.',
      'The verification evidence, including ignored-file status where relevant, is posted on #1548 and is sufficient for the umbrella owner to close both residual acceptance items.',
    ],
    fileHints: ['git worktree list/status evidence', 'kookr#1548 residual acceptance item'],
    testHints: ['post-cleanup invariant check against porcelain worktree output'],
    labels: ['enhancement', 'automation-blocked'],
  }),
]);

/**
 * Vetted leaf plans keyed by repo-qualified umbrella ref (`owner/repo#number`).
 * Extend as more umbrellas get curated decompositions; unknown umbrellas return
 * undefined and are flagged `needsAuthoring` by {@link evaluateQueueFeeder}.
 */
export const CURATED_LEAF_PLANS: Readonly<Record<string, readonly LeafSpec[]>> = Object.freeze({
  'kookr-ai/kookr#1548': KOOKR_1548_LEAF_PLAN,
  'jeanibarz/lucy#1588': LUCY_1588_LEAF_PLAN,
  'jeanibarz/lucy#1587': LUCY_1587_LEAF_PLAN,
  'jeanibarz/lucy#1590': LUCY_1590_LEAF_PLAN,
  'jeanibarz/lucy#1586': LUCY_1586_LEAF_PLAN,
  'jeanibarz/lucy#1593': LUCY_1593_LEAF_PLAN,
  'jeanibarz/lucy#1589': LUCY_1589_LEAF_PLAN,
  'jeanibarz/lucy#1594': LUCY_1594_LEAF_PLAN,
});

/** Look up the curated leaf plan for a repo-qualified umbrella ref. */
export function curatedLeafPlan(ref: string): readonly LeafSpec[] | undefined {
  return CURATED_LEAF_PLANS[ref.trim()];
}
