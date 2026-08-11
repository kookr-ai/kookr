/**
 * Delivery-scoped open-PR fail-safe for capacity reclaim (issue #2225).
 *
 * Prior reclaim paths treated ANY tracked PR reference as a hold: prompt-cited
 * historical PRs, Dependabot/bot deps PRs on foreign branches, and unfetched
 * refs all became `skipped_open_pr_*` and kept `reclaimedTotal` at 0 while the
 * host had almost no real open delivery PRs.
 *
 * This module is the pure decision: only an agent-authored delivery PR that is
 * still open/unmerged (or whose state is unknown) blocks reclaim. Prompt-only
 * linkage, bot/foreign open PRs, and fully closed/merged sets clear the hold.
 *
 * Tri-state matches {@link ListExpiredHungSuspectTasksOpts.isHoldingOpenPr}:
 * - `true`  — confirmed open delivery PR
 * - `false` — safe to reclaim
 * - `undefined` — unknown delivery-PR state (fail-safe hold)
 */

import { PROMPT_DETECTED_FROM } from './completion/delivered-task-completion.js';

/** Why the open-PR fail-safe did or did not hold reclaim (issue #2225). */
export type OpenPrFailsafeReason =
  | 'no_pr_refs'
  | 'prompt_cited_only'
  | 'all_closed_or_merged'
  | 'bot_or_foreign_open'
  | 'delivery_open'
  | 'delivery_state_unknown';

export const OPEN_PR_FAILSAFE_REASONS: readonly OpenPrFailsafeReason[] = [
  'no_pr_refs',
  'prompt_cited_only',
  'all_closed_or_merged',
  'bot_or_foreign_open',
  'delivery_open',
  'delivery_state_unknown',
] as const;

/** Reasons that block reclaim (`isHolding !== false`). */
export const OPEN_PR_FAILSAFE_HOLD_REASONS: readonly OpenPrFailsafeReason[] = [
  'delivery_open',
  'delivery_state_unknown',
] as const;

/** Cap sample rows on health snapshots. */
export const MAX_OPEN_PR_FAILSAFE_SAMPLES = 8;

const KNOWN_BOT_LOGINS = new Set([
  'dependabot',
  'dependabot[bot]',
  'renovate',
  'renovate[bot]',
  'github-actions',
  'github-actions[bot]',
  'greenkeeper',
  'greenkeeper[bot]',
  'imgbot',
  'imgbot[bot]',
]);

const BOT_AUTHOR_SUFFIX_RE = /\[bot\]$/i;

/** Minimal PR shape the pure evaluator needs (I/O stays in the wiring layer). */
export interface OpenPrHoldCandidate {
  number: number;
  owner?: string;
  repo?: string;
  /**
   * Provenance: agent/session id for agent-authored refs, `'prompt'` for
   * prompt extraction ({@link PROMPT_DETECTED_FROM}).
   */
  detectedFrom: string;
  /**
   * Verified open state:
   * - `true`  — open or draft
   * - `false` — closed or merged
   * - `undefined` — never successfully fetched
   */
  isOpen: boolean | undefined;
  /** PR author login when state has been fetched. */
  author?: string | null;
  /** PR head branch when state has been fetched. */
  headBranch?: string | null;
}

export interface EvaluateOpenPrHoldOpts {
  prs: readonly OpenPrHoldCandidate[];
  /**
   * Task session git branch when known. Used to reject bot/foreign open PRs
   * whose head does not match this task's delivery branch.
   */
  taskBranch?: string | null;
}

export interface OpenPrHoldSample {
  prNumber: number;
  owner?: string;
  repo?: string;
  author?: string;
  headBranch?: string;
  detectedFrom?: string;
}

export interface OpenPrHoldEvaluation {
  /**
   * Reclaim tri-state: only `false` clears the fail-safe.
   * `true` = confirmed delivery hold; `undefined` = unknown delivery state.
   */
  isHolding: boolean | undefined;
  reason: OpenPrFailsafeReason;
  sample?: OpenPrHoldSample;
}

export function isBotPrAuthor(author: string | null | undefined): boolean {
  if (typeof author !== 'string') return false;
  const trimmed = author.trim();
  if (!trimmed) return false;
  if (KNOWN_BOT_LOGINS.has(trimmed.toLowerCase())) return true;
  return BOT_AUTHOR_SUFFIX_RE.test(trimmed);
}

function branchesMatch(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

function toSample(pr: OpenPrHoldCandidate): OpenPrHoldSample {
  return {
    prNumber: pr.number,
    ...(pr.owner ? { owner: pr.owner } : {}),
    ...(pr.repo ? { repo: pr.repo } : {}),
    ...(pr.author ? { author: pr.author } : {}),
    ...(pr.headBranch ? { headBranch: pr.headBranch } : {}),
    ...(pr.detectedFrom ? { detectedFrom: pr.detectedFrom } : {}),
  };
}

/**
 * True when an open PR is this task's delivery PR (not prompt citation, not a
 * bot deps PR on another branch).
 */
export function isDeliveryOpenPr(
  pr: OpenPrHoldCandidate,
  taskBranch?: string | null,
): boolean {
  if (pr.detectedFrom === PROMPT_DETECTED_FROM) return false;

  const branch =
    typeof taskBranch === 'string' && taskBranch.trim().length > 0
      ? taskBranch.trim()
      : null;
  const head =
    typeof pr.headBranch === 'string' && pr.headBranch.trim().length > 0
      ? pr.headBranch.trim()
      : null;

  if (isBotPrAuthor(pr.author)) {
    // Dependabot-class: only hold when head matches this task's branch.
    if (branch && head && branchesMatch(branch, head)) return true;
    return false;
  }

  // Agent-authored open PR with a known mismatched head is historical/foreign
  // linkage (e.g. mentioned another PR), not this task's delivery branch.
  if (branch && head && !branchesMatch(branch, head)) return false;

  return true;
}

/**
 * Pure open-PR fail-safe decision for reclaim (issue #2225).
 *
 * Evaluation order:
 * 1. no PR refs → clear
 * 2. only prompt-cited refs → clear (not this task's delivery)
 * 3. any agent-authored delivery-open PR → hold true
 * 4. any agent-authored unfetched ref → hold undefined (fail-safe)
 * 5. only bot/foreign open PRs among agent refs → clear
 * 6. all closed/merged → clear
 */
export function evaluateTaskOpenPrHold(
  opts: EvaluateOpenPrHoldOpts,
): OpenPrHoldEvaluation {
  const prs = opts.prs;
  if (prs.length === 0) {
    return { isHolding: false, reason: 'no_pr_refs' };
  }

  const agentPrs = prs.filter((pr) => pr.detectedFrom !== PROMPT_DETECTED_FROM);
  if (agentPrs.length === 0) {
    // Prompt-only linkage must not permanent-block reclaim (issue #2225 AC2).
    return {
      isHolding: false,
      reason: 'prompt_cited_only',
      sample: toSample(prs[0]!),
    };
  }

  let unknownSample: OpenPrHoldCandidate | undefined;
  let foreignOpenSample: OpenPrHoldCandidate | undefined;

  for (const pr of agentPrs) {
    if (pr.isOpen === true) {
      if (isDeliveryOpenPr(pr, opts.taskBranch)) {
        return {
          isHolding: true,
          reason: 'delivery_open',
          sample: toSample(pr),
        };
      }
      if (!foreignOpenSample) foreignOpenSample = pr;
      continue;
    }
    if (pr.isOpen === undefined) {
      if (!unknownSample) unknownSample = pr;
    }
  }

  // Fail-safe: unfetched agent-authored PR state still blocks reclaim — a
  // possible live delivery PR must not be clobbered on fetch lag alone.
  if (unknownSample) {
    return {
      isHolding: undefined,
      reason: 'delivery_state_unknown',
      sample: toSample(unknownSample),
    };
  }

  if (foreignOpenSample) {
    return {
      isHolding: false,
      reason: 'bot_or_foreign_open',
      sample: toSample(foreignOpenSample),
    };
  }

  return {
    isHolding: false,
    reason: 'all_closed_or_merged',
    sample: toSample(agentPrs[0]!),
  };
}

// ---------------------------------------------------------------------------
// Health breakdown: openPrFailsafeByReason (issue #2225 AC1)
// ---------------------------------------------------------------------------

export interface OpenPrFailsafeReasonBucket {
  count: number;
  /** Sample task ids that hit this reason (capped). */
  sampleTaskIds: string[];
  /** Sample PR linkage for operator audit (capped). */
  samples: Array<OpenPrHoldSample & { taskId: string }>;
}

export type OpenPrFailsafeByReason = Record<
  OpenPrFailsafeReason,
  OpenPrFailsafeReasonBucket
>;

export function emptyOpenPrFailsafeByReason(): OpenPrFailsafeByReason {
  const out = {} as OpenPrFailsafeByReason;
  for (const reason of OPEN_PR_FAILSAFE_REASONS) {
    out[reason] = { count: 0, sampleTaskIds: [], samples: [] };
  }
  return out;
}

/**
 * Process-lifetime counters for open-PR fail-safe skip *reasons* (issue #2225).
 * Record only when reclaim is blocked (`isHolding !== false`). Sample task ids
 * / PR linkage rotate as a capped ring of first-seen ids per reason.
 */
export class OpenPrFailsafeReasonMetrics {
  private readonly buckets = emptyOpenPrFailsafeByReason();

  /**
   * Record one hold evaluation. Only hold reasons increment counters
   * (`delivery_open` / `delivery_state_unknown`). Clear reasons are ignored so
   * health stays focused on why reclaim was blocked.
   */
  recordHold(taskId: string, evaluation: OpenPrHoldEvaluation): void {
    if (evaluation.isHolding === false) return;
    const bucket = this.buckets[evaluation.reason];
    bucket.count += 1;
    if (
      bucket.sampleTaskIds.length < MAX_OPEN_PR_FAILSAFE_SAMPLES
      && !bucket.sampleTaskIds.includes(taskId)
    ) {
      bucket.sampleTaskIds.push(taskId);
    }
    if (evaluation.sample && bucket.samples.length < MAX_OPEN_PR_FAILSAFE_SAMPLES) {
      bucket.samples.push({ taskId, ...evaluation.sample });
    }
  }

  /** Cumulative hold-reason breakdown since process start. */
  getSnapshot(): OpenPrFailsafeByReason {
    const out = emptyOpenPrFailsafeByReason();
    for (const reason of OPEN_PR_FAILSAFE_REASONS) {
      const b = this.buckets[reason];
      out[reason] = {
        count: b.count,
        sampleTaskIds: [...b.sampleTaskIds],
        samples: b.samples.map((s) => ({ ...s })),
      };
    }
    return out;
  }
}
