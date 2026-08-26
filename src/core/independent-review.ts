/**
 * Independent merge-review gate (issue #1717).
 *
 * Before an autonomous self-merge, a fresh-context reviewer subagent reviews the
 * diff blind to the implementer's reasoning and posts a PR comment carrying a
 * machine-readable verdict. The merge wrapper (`scripts/kookr-merge.sh`) refuses
 * to merge unless the latest verdict is `pass` explicitly bound to the current
 * head SHA. Timeout labels remain useful telemetry, but never authorize a merge.
 *
 * This module is the single source of truth for the marker/label/verdict-line
 * literals. `scripts/kookr-merge.sh` and the `independent-merge-review` skill
 * embed the same strings verbatim; a contract test asserts they stay in sync
 * (substring detection means any drift would silently break the gate).
 */

/** HTML comment that tags a PR comment as an independent-review verdict. */
export const INDEPENDENT_REVIEW_MARKER = '<!-- kookr-independent-review -->';

/** Machine-readable verdict line prefix inside a verdict comment. */
export const REVIEW_VERDICT_LINE_PREFIX = 'kookr-review-verdict:';

/** Optional line binding a verdict to the commit it reviewed (staleness guard). */
export const REVIEW_HEAD_SHA_LINE_PREFIX = 'review-head-sha:';

/** Optional line naming which reviewer lane produced the verdict. */
export const REVIEW_LANE_LINE_PREFIX = 'review-lane:';

/**
 * Label applied when the reviewer did not return a verdict inside the latency
 * budget. It is telemetry only; it never authorizes an autonomous merge.
 */
export const REVIEW_SKIPPED_TIMEOUT_LABEL = 'review-skipped-timeout';

/** Env var that toggles the merge-time review gate in `kookr-merge.sh`. */
export const REQUIRE_REVIEW_ENV = 'KOOKR_MERGE_REQUIRE_REVIEW';

export type ReviewVerdict = 'pass' | 'block';
export type ReviewLane = 'codex' | 'claude' | string;

export interface ParsedVerdict {
  verdict: ReviewVerdict;
  headSha: string | null;
  lane: ReviewLane | null;
}

export interface ReviewComment {
  body: string;
  /** ISO timestamp; used to order verdicts when present. */
  createdAt?: string;
}

/**
 * Parse a single PR comment body into a verdict, or null when the comment is not
 * an independent-review verdict comment.
 */
export function parseVerdictComment(body: string): ParsedVerdict | null {
  if (!body || !body.includes(INDEPENDENT_REVIEW_MARKER)) return null;

  let verdict: ReviewVerdict | null = null;
  let headSha: string | null = null;
  let lane: ReviewLane | null = null;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.toLowerCase().startsWith(REVIEW_VERDICT_LINE_PREFIX)) {
      const value = line.slice(REVIEW_VERDICT_LINE_PREFIX.length).trim().toLowerCase();
      if (value === 'pass' || value === 'block') verdict = value;
    } else if (line.toLowerCase().startsWith(REVIEW_HEAD_SHA_LINE_PREFIX)) {
      const value = line.slice(REVIEW_HEAD_SHA_LINE_PREFIX.length).trim();
      if (value) headSha = value.toLowerCase();
    } else if (line.toLowerCase().startsWith(REVIEW_LANE_LINE_PREFIX)) {
      const value = line.slice(REVIEW_LANE_LINE_PREFIX.length).trim();
      if (value) lane = value.toLowerCase();
    }
  }

  if (!verdict) return null;
  return { verdict, headSha, lane };
}

/**
 * Return the effective (latest) verdict from a list of PR comments. Comments are
 * ordered by `createdAt` when available, otherwise by array position; the last
 * verdict wins so a fix-and-re-review loop is naturally honored.
 */
export function latestVerdict(comments: ReviewComment[]): ParsedVerdict | null {
  const verdicts: Array<{ order: number; createdAt: string | null; parsed: ParsedVerdict }> = [];
  comments.forEach((comment, index) => {
    const parsed = parseVerdictComment(comment.body);
    if (parsed) {
      verdicts.push({ order: index, createdAt: comment.createdAt ?? null, parsed });
    }
  });
  if (verdicts.length === 0) return null;
  verdicts.sort((a, b) => {
    if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? -1 : 1;
    }
    return a.order - b.order;
  });
  return verdicts[verdicts.length - 1].parsed;
}

export type MergeReviewGateCode =
  | 'disabled'
  | 'pass'
  | 'timeout-label'
  | 'blocked-finding'
  | 'stale-verdict'
  | 'unbound-verdict'
  | 'no-verdict';

export interface MergeReviewGateInput {
  comments: ReviewComment[];
  labels: string[];
  /** Current PR head SHA; used to reject a `pass` verdict bound to an older commit. */
  headSha?: string | null;
  /** Defaults to true. When false the gate is a no-op (`disabled`). */
  requireReview?: boolean;
}

export interface MergeReviewGateResult {
  allowed: boolean;
  code: MergeReviewGateCode;
  reason: string;
  verdict: ParsedVerdict | null;
}

/**
 * Decide whether an autonomous merge may proceed given the PR's review verdict
 * comments and labels.
 *
 * NOTE: the live production gate is the jq reimplementation inside
 * `scripts/kookr-merge.sh` (`require_review_verdict`) — bash cannot import this
 * module. This function is the executable *specification* of that decision
 * table: it is what the unit tests pin, and the two must agree branch-for-branch
 * (`pass` / `block` / `stale-verdict` / `unbound-verdict` / `timeout-label` / `no-verdict` /
 * `disabled`). When you change one, change the other and update both suites.
 *
 * Precedence:
 *  1. Gate disabled → allow.
 *  2. Latest verdict is `block` → refuse (an explicit block is never overridden
 *     by the timeout label).
 *  3. Latest verdict is `pass` bound to the current head SHA → allow.
 *  4. A missing head binding, stale verdict, timeout label, or no verdict → refuse.
 */
export function evaluateMergeReviewGate(input: MergeReviewGateInput): MergeReviewGateResult {
  const requireReview = input.requireReview ?? true;
  if (!requireReview) {
    return { allowed: true, code: 'disabled', reason: 'review gate disabled', verdict: null };
  }

  const hasTimeoutLabel = input.labels.some(
    (label) => label.trim().toLowerCase() === REVIEW_SKIPPED_TIMEOUT_LABEL,
  );
  const verdict = latestVerdict(input.comments);

  if (verdict && verdict.verdict === 'block') {
    return {
      allowed: false,
      code: 'blocked-finding',
      reason:
        'latest independent-review verdict is BLOCK — fix or rebut each confirmed finding, then re-run the reviewer',
      verdict,
    };
  }

  const headSha = input.headSha ? input.headSha.toLowerCase() : null;
  if (verdict && verdict.verdict === 'pass') {
    if (!headSha || !verdict.headSha) {
      return {
        allowed: false,
        code: 'unbound-verdict',
        reason: 'independent-review PASS is missing an exact current-head binding',
        verdict,
      };
    }
    const stale = verdict.headSha !== headSha;
    if (!stale) {
      return {
        allowed: true,
        code: 'pass',
        reason: 'independent-review verdict is PASS for the current head',
        verdict,
      };
    }
    return {
      allowed: false,
      code: 'stale-verdict',
      reason: `independent-review PASS is stale — it reviewed ${verdict.headSha}, not the current head; re-run the reviewer`,
      verdict,
    };
  }

  if (hasTimeoutLabel) {
    return {
      allowed: false,
      code: 'timeout-label',
      reason: `no fresh exact-head verdict; ${REVIEW_SKIPPED_TIMEOUT_LABEL} is telemetry only — re-run the reviewer`,
      verdict,
    };
  }

  return {
    allowed: false,
    code: 'no-verdict',
    reason: 'no independent-review verdict comment — run the independent-merge-review reviewer first',
    verdict: null,
  };
}

export type ReviewCoverageOutcome = 'reviewed' | 'timed-out' | 'unreviewed';

export interface MergedPrRecord {
  number: number;
  comments: ReviewComment[];
  labels: string[];
}

export interface ReviewCoverageRow {
  number: number;
  outcome: ReviewCoverageOutcome;
  verdict: ReviewVerdict | null;
  lane: ReviewLane | null;
}

export interface ReviewCoverageSummary {
  total: number;
  reviewed: number;
  timedOut: number;
  unreviewed: number;
  /** reviewed-before-merge %: PRs with a verdict comment / total. Null when total=0. */
  coveragePct: number | null;
  rows: ReviewCoverageRow[];
}

/**
 * Compute reviewed-before-merge coverage over a set of merged PRs (issue #1717
 * daily-report metric). A PR counts as `reviewed` when it carries any
 * independent-review verdict comment; `timed-out` when it only carries the
 * timeout label; `unreviewed` otherwise (should be unreachable once the gate is
 * enforced — surfaced so a regression is visible rather than silent).
 */
export function computeReviewCoverage(prs: MergedPrRecord[]): ReviewCoverageSummary {
  const rows: ReviewCoverageRow[] = prs.map((pr) => {
    const verdict = latestVerdict(pr.comments);
    if (verdict) {
      return { number: pr.number, outcome: 'reviewed', verdict: verdict.verdict, lane: verdict.lane };
    }
    const hasTimeoutLabel = pr.labels.some(
      (label) => label.trim().toLowerCase() === REVIEW_SKIPPED_TIMEOUT_LABEL,
    );
    return {
      number: pr.number,
      outcome: hasTimeoutLabel ? 'timed-out' : 'unreviewed',
      verdict: null,
      lane: null,
    };
  });

  const reviewed = rows.filter((r) => r.outcome === 'reviewed').length;
  const timedOut = rows.filter((r) => r.outcome === 'timed-out').length;
  const unreviewed = rows.filter((r) => r.outcome === 'unreviewed').length;
  const total = rows.length;

  return {
    total,
    reviewed,
    timedOut,
    unreviewed,
    coveragePct: total === 0 ? null : Math.round((reviewed / total) * 1000) / 10,
    rows,
  };
}
