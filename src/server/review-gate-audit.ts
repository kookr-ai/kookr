/**
 * Post-merge review-gate auditing for self-advancing umbrella chains
 * (umbrella #2711 Phase 2, RFC `docs/rfc/rfc-self-advancing-phased-chains.md`).
 *
 * A self-advancing phase may auto-merge its own PR, so the sharpest failure to
 * detect after the fact is an auto-merge that shipped **without** a genuine
 * independent review: no verdict at all, a verdict recorded before the merge
 * even happened, a verdict bound to a stale head, or a verdict produced by the
 * implementer itself (same task id). This module is the single, pure predicate
 * that flags those cases. The umbrella-chain advancer delegates to it so the
 * merge-authority decision lives in exactly one tested place rather than being
 * re-encoded at each call site.
 *
 * The function performs no I/O. The advancer gathers the facts (the ledger
 * phase, the current PR head) and passes them in; a separate registry check
 * that the reviewer task truly exists outside the implementer lineage stays in
 * the advancer because it needs the live task registry.
 */

import type { PhaseLedgerPhase } from '../core/phase-ledger-codec.js';
import { evaluateIndependentReview, type IndependentReviewInput } from './self-advancing-authority.js';

/**
 * The outcome of auditing one merged phase's review gate.
 *
 * - `pass` — an independent reviewer (a distinct task id) returned PASS against
 *   the current head; the auto-merge is authorized.
 * - `block` — a reviewer returned BLOCK; the merge should never have happened.
 * - `missing` — no usable independent verdict (none recorded, recorded before
 *   the merge point, stale head, or produced by the implementer's own task).
 * - `not-required` — there is no merged PR to audit.
 */
export type ReviewGateAuditStatus = 'pass' | 'block' | 'missing' | 'not-required';

export interface ReviewGateAuditResult {
  status: ReviewGateAuditStatus;
  /** True when an auto-merge lacks a valid, independent PASS verdict. */
  flagged: boolean;
  reason: string;
}

export interface ReviewGateAuditInput {
  /** Whether the phase's PR was actually merged; a non-merge is `not-required`. */
  merged: boolean;
  /** The implementing (phase owner) task id. Absent means independence is unprovable. */
  implementerTaskId?: string;
  /** The reviewer task id that produced the verdict, if any. */
  reviewerTaskId?: string;
  /** The recorded verdict, if any. */
  reviewVerdict?: 'pass' | 'block';
  /** When the review was recorded. */
  reviewedAt?: string;
  /** When the PR merged. A verdict at or before this cannot have reviewed the merged head. */
  mergedAt?: string;
  /** Exact PR head the verdict reviewed. */
  reviewHeadSha?: string;
  /** Exact PR head at audit time. */
  currentHeadSha?: string;
  /** Review attempts so far (this one included). */
  reviewAttempts?: number;
  /** Per-chain cap on review attempts before hard-blocking to a human. */
  reviewIterationCap?: number;
}

/** True when both timestamps parse and `reviewedAt` is at or before `mergedAt`. */
function reviewPredatesMerge(reviewedAt: string, mergedAt: string): boolean {
  const reviewed = Date.parse(reviewedAt);
  const merged = Date.parse(mergedAt);
  return Number.isFinite(reviewed) && Number.isFinite(merged) && reviewed <= merged;
}

/**
 * Audit one merged phase's review gate.
 *
 * Flags an auto-merge that lacks a passing independent verdict from a task id
 * distinct from the implementer's. A same-task verdict fails the independence
 * check inside {@link evaluateIndependentReview} and is reported as `missing`
 * (there is no independent verdict), never as `pass`.
 */
export function auditReviewGate(input: ReviewGateAuditInput): ReviewGateAuditResult {
  if (!input.merged) {
    return { status: 'not-required', flagged: false, reason: 'no merged PR to audit' };
  }
  // A verdict recorded at or before the merge point cannot have reviewed the
  // head that actually merged — treat it as no independent review at all.
  if (input.mergedAt !== undefined && input.reviewedAt !== undefined
    && reviewPredatesMerge(input.reviewedAt, input.mergedAt)) {
    return { status: 'missing', flagged: true, reason: 'independent review predates the merge point' };
  }
  if (input.implementerTaskId === undefined || input.reviewedAt === undefined) {
    return { status: 'missing', flagged: true, reason: 'independent review is missing' };
  }

  const reviewerRan = input.reviewerTaskId !== undefined || input.reviewVerdict !== undefined;
  const decision = evaluateIndependentReview({
    implementerLineage: [input.implementerTaskId],
    reviewerTaskId: input.reviewerTaskId,
    reviewerRan,
    ...(input.reviewVerdict !== undefined
      ? { verdict: input.reviewVerdict === 'pass' ? ('PASS' as const) : ('BLOCK' as const) }
      : {}),
    reviewAttempts: input.reviewAttempts ?? (reviewerRan ? 1 : 0),
    ...(input.reviewIterationCap !== undefined ? { maxReviewAttempts: input.reviewIterationCap } : {}),
    ...(input.reviewHeadSha !== undefined ? { reviewHeadSha: input.reviewHeadSha } : {}),
    ...(input.currentHeadSha !== undefined ? { currentHeadSha: input.currentHeadSha } : {}),
  });

  if (decision.decision === 'merge-allowed') {
    return { status: 'pass', flagged: false, reason: decision.reason };
  }
  // A recorded BLOCK is its own status; every other non-pass outcome (stale
  // head, non-independent reviewer, no verdict) means no usable verdict exists.
  return {
    status: input.reviewVerdict === 'block' ? 'block' : 'missing',
    flagged: true,
    reason: decision.reason,
  };
}

/** Map a ledger phase to the pure independent-review input the authority expects. */
export function phaseIndependentReviewInput(
  phase: PhaseLedgerPhase,
  currentHeadSha?: string,
): IndependentReviewInput {
  const reviewerRan = phase.reviewerTaskId !== undefined || phase.reviewVerdict !== undefined;
  return {
    implementerLineage: phase.taskId !== undefined ? [phase.taskId] : [],
    reviewerTaskId: phase.reviewerTaskId,
    reviewerRan,
    ...(phase.reviewVerdict !== undefined
      ? { verdict: phase.reviewVerdict === 'pass' ? ('PASS' as const) : ('BLOCK' as const) }
      : {}),
    reviewAttempts: phase.reviewAttempts ?? (reviewerRan ? 1 : 0),
    ...(phase.reviewIterationCap !== undefined ? { maxReviewAttempts: phase.reviewIterationCap } : {}),
    ...(phase.reviewHeadSha !== undefined ? { reviewHeadSha: phase.reviewHeadSha } : {}),
    ...(currentHeadSha !== undefined ? { currentHeadSha } : {}),
  };
}

/** Map a ledger phase (plus its current head) to the review-gate audit input. */
export function phaseReviewGateAuditInput(
  phase: PhaseLedgerPhase,
  currentHeadSha?: string,
): ReviewGateAuditInput {
  return {
    merged: phase.prNumber !== undefined,
    ...(phase.taskId !== undefined ? { implementerTaskId: phase.taskId } : {}),
    ...(phase.reviewerTaskId !== undefined ? { reviewerTaskId: phase.reviewerTaskId } : {}),
    ...(phase.reviewVerdict !== undefined ? { reviewVerdict: phase.reviewVerdict } : {}),
    ...(phase.reviewedAt !== undefined ? { reviewedAt: phase.reviewedAt } : {}),
    ...(phase.mergedAt !== undefined ? { mergedAt: phase.mergedAt } : {}),
    ...(phase.reviewHeadSha !== undefined ? { reviewHeadSha: phase.reviewHeadSha } : {}),
    ...(currentHeadSha !== undefined ? { currentHeadSha } : {}),
    ...(phase.reviewAttempts !== undefined ? { reviewAttempts: phase.reviewAttempts } : {}),
    ...(phase.reviewIterationCap !== undefined ? { reviewIterationCap: phase.reviewIterationCap } : {}),
  };
}

/** The audit status of one ledger phase, used for chain-health rollups. */
export function phaseReviewGateAuditStatus(
  phase: PhaseLedgerPhase,
  currentHeadSha?: string,
): ReviewGateAuditStatus {
  return auditReviewGate(phaseReviewGateAuditInput(phase, currentHeadSha)).status;
}
