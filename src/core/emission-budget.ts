/**
 * Drain-coupled emission budget for issue-filing playbooks (issue #1607).
 *
 * Emitter playbooks (idea-scout, architecture-health-check, reflection/retro
 * consumers of this helper) previously filed issues unconditionally. When open
 * backlog exceeds a threshold, each run's budget for *new* issues drops so
 * emitters cannot outpace drain workers. Over-budget candidates are deferred
 * (appended to a local deferred-ideas log or an existing umbrella), never
 * silent-dropped without a record.
 *
 * All pure functions — unit-testable without GitHub or filesystem.
 */

/** Open-issue count at/above which new-issue budget is constrained. */
export const DEFAULT_OPEN_BACKLOG_THRESHOLD = 60;

/** Max new issues an emitter may file in one run when over the threshold. */
export const DEFAULT_CONSTRAINED_BUDGET = 2;

/** Token-Jaccard similarity above which a candidate is treated as a duplicate. */
export const DEFAULT_DEDUPE_SIMILARITY_THRESHOLD = 0.72;

/**
 * How many new issues one drained issue "earns" the emitter (issue #1657).
 * A ratio of 1 means a repo draining N issues/window admits at most ~N new
 * issues/window, so a repo draining ~1/window admits ~0–1.
 */
export const DEFAULT_DRAIN_COUPLING_RATIO = 1;

/**
 * Minimum new-issue budget granted regardless of drain (issue #1657). Default
 * 0: a repo that drained nothing in the window earns no new-issue budget. Raise
 * via `--drain-floor` when a genuinely fresh repo should still admit a few.
 */
export const DEFAULT_DRAIN_FLOOR_BUDGET = 0;

// v2 (issue #1657): allowedBudget is additionally capped by the target repo's
// drain rate (closed-in-window), fixing low-backlog / low-drain repos (e.g.
// lucy at backlog 52 < threshold 60 but draining ~1/window) that previously
// received the full requested budget.
export const EMISSION_BUDGET_SCHEMA_VERSION = 'emission-budget.v2' as const;
export const NET_BACKLOG_DELTA_WINDOW_DAYS = 7;

export interface EmissionBudgetInput {
  /** Current open issue count for the target repo. */
  openBacklogCount: number;
  /**
   * How many issues this run wants to file (publish target / maxIssues).
   * Clamped to ≥ 0. Fractional values are floored.
   */
  requestedBudget: number;
  /** Default {@link DEFAULT_OPEN_BACKLOG_THRESHOLD}. */
  openBacklogThreshold?: number;
  /** Default {@link DEFAULT_CONSTRAINED_BUDGET}. */
  constrainedBudget?: number;
  /**
   * Optional hard cap applied even when under the backlog threshold.
   * When omitted, under-threshold runs keep the full requested budget.
   */
  normalBudgetCap?: number;
  /**
   * Drain-coupling (issue #1657): issues drained (closed) in the *target
   * repo's* recent window. When provided, the allowed budget is additionally
   * capped by the drain rate so a low-drain repo cannot admit a full batch of
   * new issues merely because its absolute backlog sits under the threshold.
   * This cap is keyed on the repo being filed into, never the emitting actor's
   * home repo. Omit to disable drain coupling (legacy backlog-only behavior).
   */
  drainCount?: number;
  /** New issues earned per drained issue. Default {@link DEFAULT_DRAIN_COUPLING_RATIO}. */
  drainCouplingRatio?: number;
  /** Minimum budget regardless of drain. Default {@link DEFAULT_DRAIN_FLOOR_BUDGET}. */
  drainFloorBudget?: number;
}

export type EmissionBudgetAction = 'allow' | 'constrain' | 'refuse';

export interface EmissionBudgetPlan {
  schemaVersion: typeof EMISSION_BUDGET_SCHEMA_VERSION;
  openBacklogCount: number;
  openBacklogThreshold: number;
  overThreshold: boolean;
  requestedBudget: number;
  /** How many new issues this run may file after drain coupling. */
  allowedBudget: number;
  /** How many requested filings must be deferred/redirected. */
  deferredCount: number;
  constrainedBudget: number;
  /** True when a drain-rate cap was applied (issue #1657). */
  drainCoupled: boolean;
  /** Drained (closed-in-window) count used for coupling, when provided. */
  drainCount?: number;
  /** The drain-derived cap on allowedBudget, when drain coupling is active. */
  drainCap?: number;
  action: EmissionBudgetAction;
  reason: string;
}

export interface IssueRef {
  number: number;
  title: string;
  state?: string;
  url?: string;
  body?: string;
}

export interface DedupeCheckResult {
  candidateTitle: string;
  match: IssueRef | null;
  similarity: number;
  isDuplicate: boolean;
  threshold: number;
  /** Always present — every filing path must log this line. */
  logLine: string;
}

export interface NetBacklogDelta7d {
  windowDays: typeof NET_BACKLOG_DELTA_WINDOW_DAYS;
  opened7d: number;
  closed7d: number;
  /** opened7d − closed7d. Positive means the backlog is still inflating. */
  netBacklogDelta7d: number;
}

export interface DeferredIdeaRecord {
  deferredAt: string;
  repo: string;
  title: string;
  reason: string;
  source: string;
  bodyPreview?: string;
  openBacklogCount?: number;
  allowedBudget?: number;
}

function clampNonNegInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/**
 * Resolve how many new issues an emitter run may file given the live open
 * backlog. Pure and side-effect free.
 */
export function resolveEmissionBudget(input: EmissionBudgetInput): EmissionBudgetPlan {
  const openBacklogCount = clampNonNegInt(input.openBacklogCount);
  const requestedBudget = clampNonNegInt(input.requestedBudget);
  const openBacklogThreshold = clampNonNegInt(
    input.openBacklogThreshold ?? DEFAULT_OPEN_BACKLOG_THRESHOLD,
  );
  const constrainedBudget = clampNonNegInt(
    input.constrainedBudget ?? DEFAULT_CONSTRAINED_BUDGET,
  );
  const overThreshold = openBacklogCount >= openBacklogThreshold;

  let allowedBudget: number;
  let action: EmissionBudgetAction;
  let reason: string;

  if (overThreshold) {
    allowedBudget = Math.min(requestedBudget, constrainedBudget);
    if (allowedBudget === 0) {
      action = 'refuse';
      reason =
        requestedBudget === 0
          ? `Requested budget is 0 (report-only / filing disabled); open backlog ${openBacklogCount} ≥ threshold ${openBacklogThreshold}.`
          : `Open backlog ${openBacklogCount} ≥ threshold ${openBacklogThreshold}; ` +
            `emission refused (constrained budget is ${constrainedBudget}, requested ${requestedBudget}). ` +
            `Redirect remaining candidates to an existing umbrella or the deferred-ideas log.`;
    } else if (allowedBudget < requestedBudget) {
      action = 'constrain';
      reason =
        `Open backlog ${openBacklogCount} ≥ threshold ${openBacklogThreshold}; ` +
        `emission budget constrained to ${allowedBudget} (requested ${requestedBudget}). ` +
        `Defer or umbrella-append the remaining ${requestedBudget - allowedBudget} candidate(s).`;
    } else {
      action = 'allow';
      reason =
        `Open backlog ${openBacklogCount} ≥ threshold ${openBacklogThreshold}, ` +
        `but requested ${requestedBudget} is within the constrained budget ${constrainedBudget}.`;
    }
  } else {
    const cap = input.normalBudgetCap;
    if (cap !== undefined && Number.isFinite(cap)) {
      allowedBudget = Math.min(requestedBudget, clampNonNegInt(cap));
    } else {
      allowedBudget = requestedBudget;
    }
    if (allowedBudget === 0 && requestedBudget === 0) {
      action = 'refuse';
      reason = 'Requested budget is 0 (report-only / filing disabled).';
    } else if (allowedBudget < requestedBudget) {
      action = 'constrain';
      reason =
        `Under backlog threshold (${openBacklogCount} < ${openBacklogThreshold}) ` +
        `but normalBudgetCap ${clampNonNegInt(cap!)} limits filings to ${allowedBudget}.`;
    } else {
      action = 'allow';
      reason =
        `Open backlog ${openBacklogCount} < threshold ${openBacklogThreshold}; ` +
        `full requested budget ${requestedBudget} allowed.`;
    }
  }

  // Drain-coupling (issue #1657): additionally cap the allowed budget by the
  // *target* repo's drain rate, so a low-drain repo cannot admit a full batch
  // of new issues merely because its absolute backlog sits under the
  // threshold. This is a strict tightening layered on the backlog logic above.
  let drainCoupled = false;
  let drainCount: number | undefined;
  let drainCap: number | undefined;
  if (input.drainCount !== undefined && Number.isFinite(input.drainCount)) {
    drainCoupled = true;
    drainCount = clampNonNegInt(input.drainCount);
    const ratio =
      input.drainCouplingRatio !== undefined && Number.isFinite(input.drainCouplingRatio)
        ? Math.max(0, input.drainCouplingRatio)
        : DEFAULT_DRAIN_COUPLING_RATIO;
    const floor = clampNonNegInt(input.drainFloorBudget ?? DEFAULT_DRAIN_FLOOR_BUDGET);
    drainCap = floor + Math.ceil(drainCount * ratio);
    if (drainCap < allowedBudget) {
      const priorAllowed = allowedBudget;
      allowedBudget = drainCap;
      action = allowedBudget === 0 ? 'refuse' : 'constrain';
      reason =
        `Drain-coupled: target repo drained ${drainCount} issue(s) in window → ` +
        `drain cap ${drainCap} (ratio ${ratio}, floor ${floor}); ` +
        `tightened allowedBudget from ${priorAllowed} to ${allowedBudget}. ` +
        (allowedBudget === 0
          ? 'Emission refused — the repo is not draining; defer all candidates.'
          : `Defer or umbrella-append the remaining ${requestedBudget - allowedBudget} candidate(s).`);
    }
  }

  return {
    schemaVersion: EMISSION_BUDGET_SCHEMA_VERSION,
    openBacklogCount,
    openBacklogThreshold,
    overThreshold,
    requestedBudget,
    allowedBudget,
    deferredCount: Math.max(0, requestedBudget - allowedBudget),
    constrainedBudget,
    drainCoupled,
    ...(drainCount !== undefined ? { drainCount } : {}),
    ...(drainCap !== undefined ? { drainCap } : {}),
    action,
    reason,
  };
}

/**
 * Split an ordered candidate list into the ones that may be filed this run
 * and the ones that must be deferred/redirected.
 */
export function partitionByBudget<T>(items: readonly T[], budget: number): {
  file: T[];
  defer: T[];
} {
  const n = clampNonNegInt(budget);
  return {
    file: items.slice(0, n) as T[],
    defer: items.slice(n) as T[],
  };
}

/** Normalize titles for fuzzy dedupe (lowercase, strip punctuation, collapse space). */
export function normalizeIssueTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^repository idea:\s*/i, '')
    .replace(/^arch:\s*/i, '')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleTokens(title: string): Set<string> {
  const normalized = normalizeIssueTitle(title);
  if (!normalized) return new Set();
  // Drop very short tokens that inflate Jaccard on shared stop-words.
  return new Set(normalized.split(' ').filter((t) => t.length >= 2));
}

/**
 * Title similarity in [0, 1]. Empty titles → 0. Identical → 1.
 *
 * Uses the max of:
 * - token Jaccard (symmetric overlap)
 * - directed containment of the shorter token set in the longer (so a short
 *   candidate that is almost a subset of a longer open issue still scores high)
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeIssueTitle(a);
  const nb = normalizeIssueTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  // Whole-string containment of a reasonably long shorter title.
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (shorter.length >= 16 && longer.includes(shorter)) return 0.95;

  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) {
    if (tb.has(t)) intersection++;
  }
  const union = ta.size + tb.size - intersection;
  const jaccard = union === 0 ? 0 : intersection / union;
  const smaller = Math.min(ta.size, tb.size);
  const containment = smaller === 0 ? 0 : intersection / smaller;
  // When ≥80% of the shorter title's tokens appear in the longer, treat as a
  // strong near-duplicate even if extra words dilute Jaccard.
  const containmentScore = containment >= 0.8 ? 0.55 + 0.45 * containment : 0;
  return Math.max(jaccard, containmentScore);
}

/**
 * Mandatory pre-filing dedupe check. Always returns a `logLine` so callers
 * can (and must) log the check even when no match is found.
 */
export function checkDedupe(
  candidateTitle: string,
  openIssues: readonly IssueRef[],
  similarityThreshold: number = DEFAULT_DEDUPE_SIMILARITY_THRESHOLD,
): DedupeCheckResult {
  const threshold = Number.isFinite(similarityThreshold)
    ? Math.min(1, Math.max(0, similarityThreshold))
    : DEFAULT_DEDUPE_SIMILARITY_THRESHOLD;

  let best: IssueRef | null = null;
  let bestScore = 0;

  const exactNorm = normalizeIssueTitle(candidateTitle);
  for (const issue of openIssues) {
    if (normalizeIssueTitle(issue.title) === exactNorm && exactNorm.length > 0) {
      best = issue;
      bestScore = 1;
      break;
    }
    const score = titleSimilarity(candidateTitle, issue.title);
    if (score > bestScore) {
      bestScore = score;
      best = issue;
    }
  }

  const isDuplicate = best !== null && bestScore >= threshold;
  const match = isDuplicate ? best : bestScore > 0 ? best : null;
  const reportedMatch = isDuplicate ? best : null;

  const logLine = isDuplicate
    ? `dedupe-check: DUPLICATE candidate=${JSON.stringify(candidateTitle)} ` +
      `match=#${reportedMatch!.number} similarity=${bestScore.toFixed(3)} ` +
      `threshold=${threshold.toFixed(3)} title=${JSON.stringify(reportedMatch!.title)}`
    : `dedupe-check: OK candidate=${JSON.stringify(candidateTitle)} ` +
      `bestSimilarity=${bestScore.toFixed(3)} threshold=${threshold.toFixed(3)} ` +
      `scanned=${openIssues.length}` +
      (match && bestScore > 0
        ? ` nearest=#${match.number}`
        : '');

  return {
    candidateTitle,
    match: reportedMatch,
    similarity: bestScore,
    isDuplicate,
    threshold,
    logLine,
  };
}

/** Simple opened − closed delta (any window). */
export function computeNetBacklogDelta(opened: number, closed: number): number {
  return clampNonNegInt(opened) - clampNonNegInt(closed);
}

/**
 * 7-day rolling net open-issue delta from discrete opened/closed counts.
 * Callers obtain the counts via `gh` search (`created:>=` / `closed:>=`).
 */
export function computeNetBacklogDelta7d(opened7d: number, closed7d: number): NetBacklogDelta7d {
  const opened = clampNonNegInt(opened7d);
  const closed = clampNonNegInt(closed7d);
  return {
    windowDays: NET_BACKLOG_DELTA_WINDOW_DAYS,
    opened7d: opened,
    closed7d: closed,
    netBacklogDelta7d: opened - closed,
  };
}

/**
 * ISO calendar day key for "now − N days" in UTC, suitable for `gh` search
 * `created:>=YYYY-MM-DD` / `closed:>=YYYY-MM-DD` filters.
 */
export function utcDayKeyDaysAgo(days: number, now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setUTCDate(d.getUTCDate() - clampNonNegInt(days));
  return d.toISOString().slice(0, 10);
}

/**
 * Build a deferred-idea record for append-only JSONL logging. Pure — the
 * caller writes the line.
 */
export function buildDeferredIdeaRecord(input: {
  repo: string;
  title: string;
  reason: string;
  source: string;
  bodyPreview?: string;
  openBacklogCount?: number;
  allowedBudget?: number;
  now?: Date;
}): DeferredIdeaRecord {
  return {
    deferredAt: (input.now ?? new Date()).toISOString(),
    repo: input.repo,
    title: input.title,
    reason: input.reason,
    source: input.source,
    ...(input.bodyPreview !== undefined ? { bodyPreview: input.bodyPreview.slice(0, 500) } : {}),
    ...(input.openBacklogCount !== undefined
      ? { openBacklogCount: clampNonNegInt(input.openBacklogCount) }
      : {}),
    ...(input.allowedBudget !== undefined
      ? { allowedBudget: clampNonNegInt(input.allowedBudget) }
      : {}),
  };
}

/**
 * Default on-disk path for deferred ideas of a repo (`owner/repo` → slug).
 * Callers must pass an absolute `kookrDir` (CLI defaults to `~/.kookr` via
 * `homedir()`); the pure core does not read process.env.
 */
export function deferredIdeasPath(repo: string, kookrDir: string): string {
  const slug = repo.replace(/[/.]/g, '-');
  return `${kookrDir.replace(/\/$/, '')}/playbook-state/deferred-ideas/${slug}.jsonl`;
}

/**
 * Deploy-freshness check for the emission-budget logic (issue #1657, acceptance
 * criterion 3). The 07-27 budget (#1611) "worked for kookr but not lucy" partly
 * because the running daemon's playbook/CLI version could silently lag
 * origin/main. These helpers let a preflight compare the *running* schema
 * version against the version compiled into origin/main's source and surface an
 * anomaly line when they diverge, rather than failing silently.
 */

/** Extract `EMISSION_BUDGET_SCHEMA_VERSION`'s literal from TypeScript source. */
export function extractSchemaVersion(source: string): string | null {
  const m = source.match(
    /EMISSION_BUDGET_SCHEMA_VERSION\s*=\s*['"]([^'"]+)['"]/,
  );
  return m ? m[1]! : null;
}

export interface BudgetLogicVersionStatus {
  /** Schema version of the running (compiled-in) budget logic. */
  running: string;
  /** Schema version parsed from the reference source (origin/main), or null. */
  reference: string | null;
  /** True when a reference was resolved and differs from the running version. */
  lagging: boolean;
  /** Always present — the audit/anomaly line callers must log. */
  logLine: string;
}

/**
 * Compare the running budget-logic version against a reference (origin/main).
 * A null reference means "could not verify" (git unavailable) — not lagging,
 * but the log line says so, so the absence of a check is never silent.
 */
export function budgetLogicVersionStatus(
  running: string,
  reference: string | null,
): BudgetLogicVersionStatus {
  const lagging = reference !== null && reference !== running;
  const logLine =
    reference === null
      ? `emission-version: running=${running} reference=unknown ` +
        `(could not read origin/main); cannot verify deploy freshness.`
      : lagging
        ? `emission-version: ANOMALY running=${running} reference=${reference} — ` +
          `running budget logic lags origin/main; redeploy before trusting the budget.`
        : `emission-version: OK running=${running} reference=${reference}.`;
  return { running, reference, lagging, logLine };
}
