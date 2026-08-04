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
 * Cap on ready issues (idea-scout / ready-labeled) pulled into the implementable
 * set per fire when primary product shred is empty (#2044). Bounds blast radius
 * and keeps re-fires from flooding the queue.
 */
export const DEFAULT_MAX_SECONDARY_PER_FIRE = 3;

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
  productMetricLabels: DEFAULT_PRODUCT_METRIC_LABELS,
  harnessLabels: DEFAULT_HARNESS_LABELS,
  readyIssueLabels: DEFAULT_READY_ISSUE_LABELS,
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
  | 'skip-invent';

/** Provenance for an `emit-secondary` (or shred) decision. */
export type QueueFeederActionSource =
  | 'umbrella-shred'
  | 'idea-scout'
  | 'curated-umbrella'
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

/**
 * Rank + cap ready issues for secondary emit. Skips assigned / closed / already
 * emitted; prefers idea-scout / ready labels; stable input order as final key.
 * Cap defaults to {@link DEFAULT_MAX_SECONDARY_PER_FIRE}.
 */
export function selectReadyIssues(
  issues: readonly ReadyIssue[] | undefined,
  config?: Partial<QueueFeederConfig>,
): { selected: SecondaryEmitItem[]; skipped: SkippedUmbrella[] } {
  const cfg = mergeQueueFeederConfig(config);
  if (!issues || issues.length === 0) {
    return { selected: [], skipped: [] };
  }
  const preferred = new Set(cfg.readyIssueLabels.map(normalizeLabel));
  const eligible: Array<SecondaryEmitItem & { score: number; index: number }> = [];
  const skipped: SkippedUmbrella[] = [];

  issues.forEach((issue, index) => {
    const reason = readyIssueSkipReason(issue);
    if (reason) {
      skipped.push({ ref: readyIssueRef(issue), reason });
      return;
    }
    const labels = (issue.labels ?? []).map((l) => String(l));
    const hasPreferred = labels.some((l) => preferred.has(normalizeLabel(l)));
    // Preferred labels rank above unlabeled/other; within tier keep input order.
    eligible.push({
      ref: readyIssueRef(issue),
      repo: issue.repo.trim(),
      number: issue.number,
      title: issue.title,
      labels,
      score: hasPreferred ? 10 : 0,
      index,
    });
  });

  eligible.sort((a, b) => b.score - a.score || a.index - b.index);
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
   * Resolve the curated / authored leaf plan for a selected umbrella. Defaults
   * to {@link curatedLeafPlan} (the built-in vetted registry). Return undefined
   * when no plan exists yet — the umbrella is still selected but flagged
   * `needsAuthoring`.
   */
  resolveLeaves?: (candidate: UmbrellaCandidate) => readonly LeafSpec[] | undefined;
  config?: Partial<QueueFeederConfig>;
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
 * prefers a shreddable product umbrella, then falls through to secondary emit
 * of ready issues / residual curated plans (#2044). Never performs side effects.
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
      action: 'not-triggered',
      actionSource: null,
      selected: null,
      secondaryEmitted: [],
      skipped: [],
      leafCount: 0,
      dryRun: true,
    };
  }

  const { eligible, skipped } = rankUmbrellas(input.candidates, cfg);

  // Resolve leaf plans for every eligible umbrella once — primary shred picks
  // the highest-ranked plan-ready umbrella; secondary curated residual reuses
  // the same resolutions.
  const resolved = eligible.map((ranked) => ({
    ranked,
    plan: normalizeLeafPlan(resolve(ranked.candidate), cfg),
  }));

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
      dryRun: true,
    };
  }

  // Product leaf inventory is empty when the caller reports 0 open product-
  // metric leaves, or (when the count is omitted) when no product-metric
  // umbrella remains shreddable this run. A positive caller count blocks
  // secondary emit — product leaves already exist for other actuators.
  const productInventoryEmpty =
    input.openProductMetricIssues !== undefined
      ? input.openProductMetricIssues === 0
      : !resolved.some(
          (r) => r.ranked.classification.productMetricBlocking && r.plan.ok,
        );

  // --- Secondary #1: open unassigned idea-scout / ready issues (#2044)
  if (productInventoryEmpty) {
    const ready = selectReadyIssues(input.readyIssues, cfg);
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
        dryRun: true,
      };
    }
  }

  // --- Secondary #2 is already covered when shreddable exists above. If we
  // reach here every eligible umbrella needs authoring (or none exist).

  if (eligible.length === 0) {
    // No umbrellas and no ready issues → honest skip-invent (or empty fire).
    const readyEmpty = selectReadyIssues(input.readyIssues, cfg);
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
      dryRun: true,
    };
  }

  // Residual needsAuthoring umbrella selected for ledger observability only —
  // action is skip-invent so agents do not free-form invent leaves.
  const top = resolved[0]!;
  const rest = eligible.slice(1).map((r) => ({
    ref: umbrellaRef(r.candidate),
    reason: `not selected this run (${umbrellaRef(top.ranked.candidate)} ranked higher, one umbrella per run)`,
  }));
  const selected = toSelected(top.ranked, top.plan);
  const readySkipped = selectReadyIssues(input.readyIssues, cfg).skipped;
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
  /** Ledger action for reflection / agent audit (#2044). */
  action: QueueFeederAction;
  /** Provenance when action is shred / emit-secondary. */
  source: QueueFeederActionSource;
  selectedRef: string | null;
  selectedTitle: string | null;
  productMetricBlocking: boolean | null;
  needsAuthoring: boolean;
  leafCount: number;
  leafTitles: string[];
  /** Ready-issue refs selected for secondary emit (idea-scout path). */
  secondaryEmitted: string[];
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
 * lucy#1587 "acquisition redundancy & failover". Original children (#1515,
 * #1524, #1522, #1541, #1584) shipped; residual acceptance gaps remain:
 * pre-window zero-healthy search backends, arm-time EDGAR-only flags, a
 * measurable EDGAR-only armed-ticker counter, and RFC-012 epic body sync.
 * Authored by the queue-feeder (2026-08-02) after needsAuthoring blocked emit.
 * Live GitHub leaves: #2082–#2085. Once those exist, the feeder skips re-emit
 * via openChildrenCount / title idempotency.
 */
export const LUCY_1587_LEAF_PLAN: readonly LeafSpec[] = Object.freeze([
  Object.freeze({
    title:
      'feat(acquisition): schedule-readiness flags zero-healthy search backends before window',
    goal:
      'Wire runtime zero-healthy web-search backend state into schedule readiness so the ' +
      'operator sees a degraded/action signal before an armed earnings window opens — not ' +
      'only after a live fan-out fails mid-watch.',
    acceptanceCriteria: [
      '`schedule-readiness` (or the pre-window readiness path it shares) reports a warning ' +
        'or action when retrieval-health reports healthyCount === 0 with configuredCount > 0, ' +
        'distinct from the existing "no search backend is configured" config-only check.',
      'Unit/fixture test covers both: (a) backends configured but all unhealthy → readiness ' +
        'flags it; (b) backends configured and ≥1 healthy → no false positive.',
      'Signal is visible via the existing `!bot schedule readiness` (or control-room readiness) ' +
        'surface without requiring a live publish window.',
    ],
    fileHints: [
      'src/schedule-readiness.js',
      'src/retrieval-health.js',
      'src/scheduler-commands.js',
    ],
    testHints: [
      'unit test: inject a zero-healthy retrieval-health snapshot into readiness evaluation; assert problem code + severity',
    ],
    labels: ['acquisition', 'product-metric', 'enhancement'],
  }),
  Object.freeze({
    title:
      'feat(acquisition): flag EDGAR-only tickers at arm/readiness time (0 non-SEC channels)',
    goal:
      'Surface EDGAR-only risk at arm / schedule-readiness time using the existing ' +
      'knownNonSecChannels helper, so a ticker with zero known non-SEC channels is flagged ' +
      'before the window opens (not only on `!bot acquire status`).',
    acceptanceCriteria: [
      'When arming a watch or evaluating schedule readiness for an armed ticker, a ticker ' +
        'whose knownNonSecChannels(...).edgarOnly === true is flagged (warning or action) ' +
        'with a remediation hint (`!bot acquire status TICKER` or seed IR/feed/wire).',
      'The flag reuses knownNonSecChannels from src/acquisition/status.js — no second ' +
        'counting implementation.',
      'Unit test: synthetic registry entry with no IR/feed/wire → flagged; entry with ' +
        'IR+feed → not EDGAR-only flagged.',
    ],
    fileHints: [
      'src/acquisition/status.js',
      'src/schedule-readiness.js',
      'arming path (scheduler-commands / watchlist / control-room)',
    ],
    testHints: [
      'unit test: readiness/arm evaluation with edgarOnly fixture; assert problem includes channel count or EDGAR-only label',
    ],
    labels: ['acquisition', 'product-metric', 'enhancement'],
  }),
  Object.freeze({
    title:
      'chore(acquisition): sync RFC-012 epic #1157 Phase-0 checkboxes to closed children',
    goal:
      'Bring the open RFC-012 epic body in line with reality: Phase-0 children #1158–#1163 ' +
      'are already closed, but the epic checkboxes still show unchecked — update the epic so ' +
      'the umbrella trail no longer looks unfinished.',
    acceptanceCriteria: [
      'jeanibarz/lucy#1157 body Phase-0 checkboxes for #1158–#1163 are marked done (or ' +
        'replaced with closed/merged notes) matching each child\'s current GitHub state.',
      'Any Phase-1+ residual still open is left unchecked and remains discoverable; no false ' +
        '"all done" if later phases remain.',
      'No product code change required; PR may be docs-only or a direct issue-body update ' +
        'with a short note on the epic.',
    ],
    fileHints: [
      'GitHub issue jeanibarz/lucy#1157 body',
      'optional: rfc/RFC-012-robust-report-acquisition.md status section',
    ],
    testHints: [
      'manual: gh issue view 1157 shows Phase-0 items checked; remaining open work still listed',
    ],
    labels: ['acquisition', 'documentation'],
  }),
  Object.freeze({
    title:
      'feat(acquisition): armed-ticker EDGAR-only count as measurable redundancy metric',
    goal:
      'Add a durable, testable acquisition-redundancy metric (or readiness counter) for ' +
      '"armed tickers with 0 known non-SEC channels" so failover health is measurable ' +
      'day-over-day rather than only as a one-off status line.',
    acceptanceCriteria: [
      'A counter/metric (or daily-report field) reports how many currently-armed tickers ' +
        'are EDGAR-only (knownNonSecChannels.edgarOnly).',
      'Unit test computes the counter from a fixture set of armed tickers + issuer registry entries.',
      'Metric appears on an existing operator surface (acquire status summary, daily report, ' +
        'or control-room readiness) so umbrella #1587 acceptance is measurable in aggregate.',
    ],
    fileHints: [
      'src/acquisition/status.js',
      'daily-report / metrics emitter if present',
      'control-room readiness surfaces',
    ],
    testHints: ['unit test: N armed tickers, K edgar-only → counter equals K'],
    labels: ['acquisition', 'product-metric', 'enhancement'],
  }),
]);

/**
 * lucy#1590 "headline metrics in tested code". Core children #1513 / #1540 /
 * #1966 / #1967 / #1999 / host-circuits #1548 shipped; residual acceptance gaps
 * remain: threshold alerts on anchorCoverage/sessionHitRate, first-class
 * search-backend + tier degraded signals in the control room, per-tier block
 * attribution during armed windows, and a durable weekly acquisition scoreboard.
 * Authored by the queue-feeder (2026-08-02) after needsAuthoring blocked emit.
 * Live GitHub leaves: filed this run; openChildrenCount / title idempotency
 * prevents re-emit once those exist.
 */
export const LUCY_1590_LEAF_PLAN: readonly LeafSpec[] = Object.freeze([
  Object.freeze({
    title:
      'feat(metrics): alert when anchorCoverage or sessionHitRate drops below threshold',
    goal:
      'Post a durable operator warning via the existing safeSend chokepoint when ' +
      'detection-rollup anchorCoverage or earnings-date sessionHitRate falls below ' +
      'configured thresholds, so low product-metric health is not only visible in ' +
      'status text but actively alerted.',
    acceptanceCriteria: [
      'When the latest detection-rollup row has anchorCoverage below a documented ' +
        'threshold (default or config), Lucy emits one warning path through safeSend ' +
        '(or the shared alert helper it uses) with the measured value and denominator.',
      'When buildEarningsDateReliabilityMetrics (or the acquire-status path that wraps it) ' +
        'reports sessionHitRate below a documented threshold with a measurable sample, ' +
        'the same alert path fires (session hits / measurable n in the message).',
      'Unit/fixture tests cover: (a) below threshold → alert; (b) at/above threshold → ' +
        'no alert; (c) null/unmeasurable rate → no false alert.',
    ],
    fileHints: [
      'src/message-footer.js / safeSend path',
      'scripts/detection-report.mjs or rollup consumer',
      'src/earnings-date/metrics.js',
      'src/acquisition/status.js',
    ],
    testHints: [
      'unit test: inject rollup row + reliability metrics fixture; assert alert fired/not',
    ],
    labels: ['product-metric', 'enhancement'],
  }),
  Object.freeze({
    title:
      'feat(metrics): control-room first-class search-backend and tier degraded health',
    goal:
      'Surface search-backend health and acquisition-tier health as first-class ' +
      'degraded signals in the control room (and keep `!bot acquire sources` / ' +
      'status consistent) so operators see retrieval degradation without grepping logs.',
    acceptanceCriteria: [
      'Control-room snapshot exposes search-backend health (healthy/configured counts ' +
        'or equivalent from retrieval-health / searchBackendHealthSnapshot) and ' +
        'per-tier degraded/blocked status for the current or last armed window.',
      'Control-room UI renders those signals as explicit degraded badges/rows (not only ' +
        'buried in free-text status), distinct from the host-circuits strip.',
      '`!bot acquire sources` (or acquire status) remains consistent with the same ' +
        'underlying health helpers — no second counting implementation.',
      'Unit or control-room fixture test: unhealthy backend / blocked tier appears in ' +
        'snapshot + render path.',
    ],
    fileHints: [
      'src/retrieval-health.js',
      'src/control-room-snapshot-compose.js',
      'src/control-room/',
      'src/acquisition/status.js',
    ],
    testHints: [
      'unit test: compose snapshot with unhealthy search backend; assert field + panel render',
    ],
    labels: ['product-metric', 'enhancement'],
  }),
  Object.freeze({
    title:
      'feat(metrics): per-tier block attribution in control room during armed windows',
    goal:
      'Extend the #1548 host-circuits control-room surface so an operator can answer ' +
      '"why didn\'t the issuer tier win for ticker X" from the control room alone — ' +
      'per-tier failureCode / block attribution while windows are armed.',
    acceptanceCriteria: [
      'During an armed window (or from job.lastRun / scoreboard state), control-room ' +
        'shows per-tier attempts/ok/blocked and top failureCode counts (reuse ' +
        'src/acquisition/scoreboard.js — no parallel aggregation).',
      'At least one issuer-tier (or IR) block path is attributed with failureCode so ' +
        'the operator sees *which* tier failed and *why*, not only host-level circuits.',
      'Unit/fixture test: scoreboard with IR blocked by a known failureCode → control-room ' +
        'payload/render includes that tier + code.',
    ],
    fileHints: [
      'src/acquisition/scoreboard.js',
      'src/control-room-snapshot-compose.js',
      'src/control-room/host-circuits-panel.js (or sibling panel)',
      'src/scheduler.js job.lastRun scoreboard',
    ],
    testHints: [
      'unit test: scoreboard fixture → snapshot field; optional panel render assertion',
    ],
    labels: ['product-metric', 'enhancement'],
  }),
  Object.freeze({
    title: 'feat(metrics): weekly acquisition scoreboard from detections.jsonl',
    goal:
      'Add a tested pure aggregator that builds a weekly acquisition scoreboard ' +
      '(per-tier win rate, first-seen latency distribution, failureCode histogram) ' +
      'from detections.jsonl so longitudinal tier performance is measurable in code, ' +
      'not operator memory.',
    acceptanceCriteria: [
      'A pure function (and optional CLI/script) reads detections.jsonl (or event-latency ' +
        'spans) and emits per-tier win rate, first-seen latency summary, and failureCode ' +
        'histogram for a configurable week window.',
      'Unit tests cover a fixture JSONL: known per-tier wins/blocks → expected rates and ' +
        'histogram buckets; empty input degrades cleanly.',
      'Output is durable (JSON/JSONL under data/ or printed via npm script) so daily-report ' +
        'or control-room can consume it later without recomputing in prose.',
    ],
    fileHints: [
      'src/acquisition/scoreboard.js (reuse fold helpers where possible)',
      'scripts/ or src/ acquisition weekly scoreboard module',
      'data/detections.jsonl schema consumers',
    ],
    testHints: [
      'unit test: synthetic detections fixture → weekly scoreboard totals match hand counts',
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
 * Vetted leaf plans keyed by repo-qualified umbrella ref (`owner/repo#number`).
 * Extend as more umbrellas get curated decompositions; unknown umbrellas return
 * undefined and are flagged `needsAuthoring` by {@link evaluateQueueFeeder}.
 */
export const CURATED_LEAF_PLANS: Readonly<Record<string, readonly LeafSpec[]>> = Object.freeze({
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
