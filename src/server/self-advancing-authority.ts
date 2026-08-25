/**
 * Merge-safety predicates for the self-advancing phase contract (umbrella #2711,
 * RFC `docs/rfc/rfc-self-advancing-phased-chains.md`, Phase 1 / D1).
 *
 * Self-merge is the sharpest new power a self-advancing chain wields, so every
 * gate that authorizes it is expressed here as a **pure, unit-tested predicate**.
 * The running merge step (the merge wrapper — the only path a self-advancing
 * phase may merge through) calls these to decide, at merge time, whether it is
 * actually allowed to proceed. Keeping the decisions pure means the authority
 * model is testable in isolation and cannot drift between call sites.
 *
 * None of these predicates perform I/O. The caller gathers the facts (env,
 * recorded merge timestamps, the task registry, the reviewer verdict) and passes
 * them in.
 */

import {
  DEFAULT_AUTONOMOUS_REVIEW_ITERATION_CAP,
  resolveAutonomousReviewIterationCap,
} from '../core/autonomous-review-policy.js';

/**
 * Global env kill switch. When set to a truthy value it halts **all**
 * self-advancing merges and spawns regardless of any issue's content — the
 * operator's out-of-band stop, outside the per-chain data path.
 *
 * Truthy = present and not one of the explicit "off" spellings. Anything else
 * (`1`, `true`, `yes`, `on`, or any other non-empty value) disables.
 */
export function isSelfAdvancingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.KOOKR_SELF_ADVANCING_DISABLED;
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (value === '') return false;
  return !['0', 'false', 'no', 'off'].includes(value);
}

/** Default per-chain self-merge rate cap: at most this many self-merges per hour. */
export const DEFAULT_SELF_MERGE_RATE_CAP_PER_HOUR = 4;
/** Default rate-cap window in milliseconds (one hour). */
export const SELF_MERGE_RATE_CAP_WINDOW_MS = 60 * 60 * 1000;
/** Default cap on independent-review attempts before hard-blocking to a human. */
export const MAX_INDEPENDENT_REVIEW_ATTEMPTS = DEFAULT_AUTONOMOUS_REVIEW_ITERATION_CAP;

export interface SelfMergeGrantInput {
  /** The PR's head branch (e.g. `refactor/product-metric-alerts-#3272-p2`). */
  prHeadBranch: string;
  /**
   * The chain's branch namespace: the recorded branch, or a branch prefix that
   * every phase of this chain shares. The grant is only valid for a PR whose
   * head branch is exactly this or lives under it.
   */
  chainNamespace: string;
  /** Whether the umbrella issue carries the chain marker (proves this is a real chain). */
  umbrellaHasChainMarker: boolean;
}

export interface GrantDecision {
  granted: boolean;
  reason: string;
}

/** True when `branch` is exactly `namespace` or a path segment under it. */
function branchMatchesNamespace(branch: string, namespace: string): boolean {
  if (namespace === '') return false;
  if (branch === namespace) return true;
  return branch.startsWith(`${namespace}/`) || branch.startsWith(`${namespace}-`);
}

/**
 * Verify the self-merge grant **at merge time**, not merely that a policy value
 * was carried. A self-advancing PR may self-merge only when its head branch
 * matches the chain namespace AND the umbrella issue carries the chain marker.
 * A stray `self-advancing` policy value on an unrelated child therefore
 * authorizes nothing.
 */
export function verifySelfMergeGrant(input: SelfMergeGrantInput): GrantDecision {
  if (!input.umbrellaHasChainMarker) {
    return { granted: false, reason: 'umbrella issue is missing the chain marker' };
  }
  if (!branchMatchesNamespace(input.prHeadBranch, input.chainNamespace)) {
    return {
      granted: false,
      reason: `PR head branch "${input.prHeadBranch}" is outside chain namespace "${input.chainNamespace}"`,
    };
  }
  return { granted: true, reason: 'head branch in namespace and umbrella marker present' };
}

export interface RateCapInput {
  /** Epoch-ms timestamps of prior self-merges in this chain. */
  recentMergeTimestamps: readonly number[];
  /** Current time, epoch ms (injected so the predicate stays pure). */
  now: number;
  /** Sliding window in ms. Defaults to one hour. */
  windowMs?: number;
  /** Max self-merges allowed within the window. Defaults to the per-chain cap. */
  maxPerWindow?: number;
}

export interface RateCapDecision {
  allowed: boolean;
  /** Self-merges already recorded within the window. */
  countInWindow: number;
  reason: string;
}

/**
 * Circuit breaker: block a self-merge once the chain has already merged
 * `maxPerWindow` PRs within the sliding window. Guards against a runaway ledger
 * / mis-tick self-merging many PRs in minutes.
 */
export function checkSelfMergeRateCap(input: RateCapInput): RateCapDecision {
  const windowMs = input.windowMs ?? SELF_MERGE_RATE_CAP_WINDOW_MS;
  const maxPerWindow = input.maxPerWindow ?? DEFAULT_SELF_MERGE_RATE_CAP_PER_HOUR;
  const threshold = input.now - windowMs;
  const countInWindow = input.recentMergeTimestamps.filter((ts) => ts > threshold).length;
  if (countInWindow >= maxPerWindow) {
    return {
      allowed: false,
      countInWindow,
      reason: `self-merge rate cap reached: ${countInWindow}/${maxPerWindow} within ${windowMs}ms`,
    };
  }
  return {
    allowed: true,
    countInWindow,
    reason: `within rate cap: ${countInWindow}/${maxPerWindow}`,
  };
}

export interface IndependentReviewInput {
  /**
   * Task ids in the implementer's lineage (the implementing task and its
   * ancestors). The reviewer must not be any of these.
   */
  implementerLineage: readonly string[];
  /** The task id that produced the review verdict, if a reviewer ran at all. */
  reviewerTaskId?: string;
  /** Whether the reviewer task actually ran to completion. */
  reviewerRan: boolean;
  /** The verdict the reviewer returned, if any. */
  verdict?: 'PASS' | 'BLOCK';
  /** How many review attempts have been made so far (this one included). */
  reviewAttempts: number;
  /** Cap on attempts before hard-blocking to a human. Defaults to the module cap. */
  maxReviewAttempts?: number;
  /** Exact PR head reviewed by this verdict. Required for a merge grant. */
  reviewHeadSha?: string;
  /** Exact PR head at the merge decision. Required for a merge grant. */
  currentHeadSha?: string;
}

export type IndependentReviewDecision =
  /** Identity is independent and the verdict is PASS — the merge may proceed. */
  | { decision: 'merge-allowed'; reason: string }
  /** The reviewer returned BLOCK at the cap — stop; never force-merge. */
  | { decision: 'blocked'; reason: string }
  /** The reviewer failed to run (or returned no verdict) — retry and alert. */
  | { decision: 'retry-review'; reason: string }
  /** Cap exhausted or identity unforgeable check failed — hand to a human. */
  | { decision: 'human-required'; reason: string };

/**
 * Decide whether an independent-review verdict authorizes a self-merge.
 *
 * The verdict is **unforgeable**: it must come from a task whose id differs from
 * every id in the implementer's lineage. A reviewer that never ran is
 * distinguished from a reviewer that returned BLOCK — the former retries/alerts,
 * the latter stops. Re-review attempts are capped; past the cap the chain hard-
 * blocks to a human rather than looping.
 */
export function evaluateIndependentReview(input: IndependentReviewInput): IndependentReviewDecision {
  let maxAttempts: number;
  try {
    maxAttempts = resolveAutonomousReviewIterationCap(input.maxReviewAttempts ?? MAX_INDEPENDENT_REVIEW_ATTEMPTS).cap;
  } catch {
    return { decision: 'human-required', reason: 'review attempt cap exceeds the shared autonomous review cap' };
  }

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    return { decision: 'human-required', reason: 'review attempt cap is invalid' };
  }
  if (!Number.isInteger(input.reviewAttempts) || input.reviewAttempts < 0 || input.reviewAttempts > maxAttempts) {
    return {
      decision: 'human-required',
      reason: `review attempt count ${input.reviewAttempts} exceeds the configured cap ${maxAttempts}`,
    };
  }

  // A reviewer that ran but shares the implementer's lineage (or reported no
  // task id) can never authorize a merge — this is an identity failure, not a
  // transient "did not run", so it goes straight to a human.
  if (input.reviewerRan) {
    if (!input.reviewerTaskId) {
      return { decision: 'human-required', reason: 'reviewer ran but reported no task id — cannot verify independence' };
    }
    if (input.implementerLineage.includes(input.reviewerTaskId)) {
      return {
        decision: 'human-required',
        reason: `reviewer task ${input.reviewerTaskId} is in the implementer lineage — verdict is not independent`,
      };
    }
  }

  const headMatches = Boolean(input.reviewHeadSha && input.currentHeadSha
    && input.reviewHeadSha.toLowerCase() === input.currentHeadSha.toLowerCase());
  if (input.reviewerRan && input.verdict !== undefined && !headMatches) {
    if (input.reviewAttempts >= maxAttempts) {
      return {
        decision: 'human-required',
        reason: `review verdict is not bound to the current PR head after ${input.reviewAttempts}/${maxAttempts} attempts`,
      };
    }
    return {
      decision: 'retry-review',
      reason: 'review verdict is missing or stale for the current PR head — run a fresh review',
    };
  }

  // A BLOCK is a correction signal, not a terminal success or a reason to
  // abandon autonomous work. Give the implementer a fresh correction/review
  // cycle while durable budget remains; the cap turns an unresolved finding
  // into a concrete human-required blocker.
  if (input.reviewerRan && input.verdict === 'BLOCK') {
    if (input.reviewAttempts >= maxAttempts) {
      return {
        decision: 'human-required',
        reason: `independent reviewer returned BLOCK after ${input.reviewAttempts}/${maxAttempts} correction/review attempts`,
      };
    }
    return {
      decision: 'retry-review',
      reason: `independent reviewer returned BLOCK — start correction/review attempt ${input.reviewAttempts + 1}/${maxAttempts}`,
    };
  }

  // Independent PASS → merge may proceed.
  if (input.reviewerRan && input.verdict === 'PASS') {
    return { decision: 'merge-allowed', reason: 'independent reviewer returned PASS' };
  }

  // Reviewer failed to run, or ran without a verdict: retry until the cap, then
  // escalate to a human. "Failed to run" is deliberately not "BLOCK".
  if (input.reviewAttempts >= maxAttempts) {
    return {
      decision: 'human-required',
      reason: `review could not produce a verdict after ${input.reviewAttempts}/${maxAttempts} attempts`,
    };
  }
  return {
    decision: 'retry-review',
    reason: input.reviewerRan
      ? 'reviewer ran but returned no verdict — retry and alert'
      : 'reviewer failed to run — retry and alert',
  };
}
