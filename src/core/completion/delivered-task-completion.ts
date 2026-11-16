/**
 * Delivery-aware self-completion (issue #1560).
 *
 * Autonomous implement-tasks deliver their PR (merge it) and then hang for
 * hours in the post-merge tail — branch-delete pushes trigger the heavy
 * pre-push gate, CI-rerun loops run unbounded, agents wait on input nobody
 * gives — never raising a `completion_ready` signal. Today only the hung-task
 * reaper eventually frees the slot, hours later, and records `terminated`,
 * masking a successful delivery as failure (umbrella #1545; prod tasks
 * faf7902b / 3a7039c5).
 *
 * This module is the pure decision layer: given a task, its merged-PR
 * attribution, and how long ago the merge was first observed, decide whether
 * the task should self-complete because its post-merge cleanup budget is
 * exceeded. The server sweep (`delivered-task-completion-sweep.ts`) then raises
 * the completion signal through the existing #1541 outbox / `autoCloseOnSignal`
 * path and runs the normal completion lifecycle — no parallel completion
 * surface. The hung-task reaper stays the backstop: this fires ~10-15 min after
 * merge, well before reap eligibility (hours).
 */

import type { CompletionDigest } from '../completion-digest.js';
import type { Task } from '../task-read-model.js';
import { isActiveRalphLoop } from './completion-ready-cleanup.js';

/** Default post-merge cleanup budget: 10 minutes (issue #1560). */
export const DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS = 10 * 60 * 1000;

/**
 * Default settle time for a task that said "finished" after its own pull
 * request merged: 2 minutes (issue #3930). The merged pull request is the proof
 * of delivery, so the task does not need the full cleanup budget; the settle
 * time only lets the agent's last hook events and the closing turn land.
 */
export const DEFAULT_FINISHED_MERGED_SETTLE_MS = 2 * 60 * 1000;

/**
 * A task's attributable merged PR — the delivery evidence. Sourced from the
 * server's `GitHubStateStore` (a task's tracked PR references whose fetched
 * status is `merged`), the same attribution the delivery-aware-reaping sibling
 * issue reads.
 */
export interface MergedPrAttribution {
  prNumber: number;
  prUrl?: string;
  owner?: string;
  repo?: string;
  /**
   * GitHub `mergedAt` of the pull request (issue #3930). The settle path uses
   * it to check that the task said "finished" after the merge, not before.
   */
  mergedAt?: Date;
}

/**
 * `GitHubReference.detectedFrom` sentinel for a PR reference extracted from the
 * **task prompt** rather than the agent's own event stream
 * (`github-scanner-service.ts` passes `'prompt'` to `toGitHubReferences`). A
 * prompt-referenced merged PR (e.g. a prompt "port the fix from PR #1500") is
 * NOT this task's delivery — attributing it would force-complete a live task
 * that merely mentions an already-merged PR.
 */
export const PROMPT_DETECTED_FROM = 'prompt';

/** Minimal shape of a tracked PR reference the delivery selector needs. */
export interface TrackedPrRef {
  /** Fetched PR status; `'merged'` is the delivery signal. */
  status: string;
  number: number;
  url?: string;
  owner?: string;
  repo?: string;
  /** Provenance: an agent/session id for agent-authored refs, `'prompt'` otherwise. */
  detectedFrom: string;
  /** GitHub `mergedAt`, when known (issue #3746). */
  mergedAt?: Date;
}

/** Options for {@link selectDeliveredMergedPr}. */
export interface SelectDeliveredMergedPrOptions {
  /**
   * The task's creation time (issue #3746). When given, a merged PR counts as
   * delivery only if its `mergedAt` is known and not earlier than this — a PR
   * merged before the task existed cannot be the task's work, however often
   * the agent saw its number in docs, fixtures or `gh` output. A PR with no
   * known `mergedAt` is rejected too: this attribution force-completes live
   * tasks, so unprovable evidence must not count. Accepts an ISO string
   * because persisted task records can surface `createdAt` that way; an
   * unparseable value rejects every merged PR (fail closed).
   */
  notBefore?: Date | string;
}

/**
 * Select the task's own merged PR from its tracked references, or null.
 *
 * Only PRs discovered from the **agent's activity** count as delivery —
 * prompt-referenced merged PRs are excluded, so a live task whose prompt cites
 * an already-merged PR is never force-completed (correctness review, #1560).
 * With `opts.notBefore`, PRs merged before the task existed are excluded too
 * (issue #3746). Returns the first qualifying merged PR, so a stale PR listed
 * first never masks a real delivery listed after it.
 */
export function selectDeliveredMergedPr(
  prs: readonly TrackedPrRef[],
  opts: SelectDeliveredMergedPrOptions = {},
): MergedPrAttribution | null {
  const notBeforeMs = opts.notBefore === undefined ? undefined : toEpochMs(opts.notBefore);
  const merged = prs.find(
    (pr) => pr.status === 'merged'
      && pr.detectedFrom !== PROMPT_DETECTED_FROM
      && (notBeforeMs === undefined || mergedNotBefore(pr.mergedAt, notBeforeMs)),
  );
  if (!merged) return null;
  return {
    prNumber: merged.number,
    ...(merged.url ? { prUrl: merged.url } : {}),
    ...(merged.owner ? { owner: merged.owner } : {}),
    ...(merged.repo ? { repo: merged.repo } : {}),
    ...(merged.mergedAt instanceof Date ? { mergedAt: merged.mergedAt } : {}),
  };
}

function toEpochMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/** True only when `mergedAt` is known and at or after `notBeforeMs` (NaN → false). */
function mergedNotBefore(mergedAt: Date | undefined, notBeforeMs: number): boolean {
  if (!(mergedAt instanceof Date)) return false;
  return mergedAt.getTime() >= notBeforeMs;
}

/**
 * Why a delivered task was (not) auto-completed.
 * - `finished_after_merge` — the task said "finished" after its own PR merged
 *   and the settle time has passed (issue #3930). The sweep still applies the
 *   live-work veto (live turn, human at the terminal, viewer attached, open
 *   PR) before completing.
 * - `within_settle` — said "finished" after the merge, settle time not over.
 * - `post_merge_budget_exceeded` — merged PR, no "finished" signal after the
 *   merge, cleanup ran past the budget.
 * - `not_merged` — no attributable merged PR (never auto-complete: negative).
 * - `within_budget` — merged, but still inside the cleanup budget.
 * - `not_in_progress` — task is not a running task.
 * - `not_opted_in` — task did not opt into `autoCloseOnSignal`; an ask-first /
 *   human-review task keeps the existing completion-ready TTL fallback instead.
 * - `ralph_active` — an active Ralph loop owns the lifecycle.
 * - `already_signaled` — a `completion_ready` signal is already pending; the
 *   normal auto-close / TTL path owns it.
 * - `provider_paused` — agent is stalled on billing/quota (issue #1667); a
 *   pause is neither delivery nor a hang, so auto-complete must not fire.
 */
export type DeliveredCompletionReason =
  | 'finished_after_merge'
  | 'within_settle'
  | 'post_merge_budget_exceeded'
  | 'not_merged'
  | 'within_budget'
  | 'not_in_progress'
  | 'not_opted_in'
  | 'ralph_active'
  | 'already_signaled'
  | 'provider_paused';

export interface DeliveredCompletionDecision {
  autoComplete: boolean;
  reason: DeliveredCompletionReason;
  /**
   * Milliseconds elapsed on the clock that applies: since the post-merge
   * "finished" signal for the settle path, since the merge was first observed
   * for the budget path.
   */
  elapsedSinceMergeMs?: number;
}

/**
 * The time (epoch ms) the task said "finished" after its own PR merged, or
 * undefined (issue #3930). Requires both times to be known and the signal to be
 * at or after the merge: a "finished" raised before the merge says nothing
 * about the delivered work, and an unknown merge time fails closed.
 */
export function finishedAfterMergeAtMs(
  task: Pick<Task, 'finishedSignalAt'>,
  merged: Pick<MergedPrAttribution, 'mergedAt'>,
): number | undefined {
  if (typeof task.finishedSignalAt !== 'string') return undefined;
  const signalMs = Date.parse(task.finishedSignalAt);
  if (!Number.isFinite(signalMs)) return undefined;
  if (!(merged.mergedAt instanceof Date)) return undefined;
  const mergedMs = merged.mergedAt.getTime();
  if (!Number.isFinite(mergedMs) || signalMs < mergedMs) return undefined;
  return signalMs;
}

/**
 * Decide whether a running task should self-complete because its PR is merged
 * and either it said "finished" after the merge and the settle time has passed
 * (issue #3930), or post-merge cleanup has exceeded the budget.
 *
 * Pure and clock-injected: `now` and `firstObservedMergedAtMs` are supplied by
 * the caller so the boundary (`elapsed >= budget`) is exact under a controlled
 * clock. Guards, in order, so the reason is the first failing precondition:
 *   1. task must be `inProgress` (a running task),
 *   2. task must have opted into `autoCloseOnSignal` (ask-first / human-review
 *      tasks keep the existing completion-ready TTL fallback),
 *   3. no active Ralph loop (that lifecycle owns completion),
 *   4. agent must not be provider-paused on billing/quota (issue #1667),
 *   5. an attributable merged PR must exist (never auto-complete otherwise),
 *   6. said "finished" after the merge → `now - signal >= settle`,
 *   7. otherwise no pending `completion_ready` signal (the normal
 *      auto-close/TTL path owns a task that signaled before its merge),
 *   8. `now - firstObservedMergedAt >= budget`.
 */
export function classifyDeliveredCompletion(
  task: Pick<Task, 'status' | 'ralphLoop' | 'pendingSignal' | 'autoCloseOnSignal' | 'finishedSignalAt'>,
  merged: MergedPrAttribution | null,
  opts: {
    now: Date;
    firstObservedMergedAtMs?: number;
    budgetMs?: number;
    /** Settle time after a post-merge "finished" signal (issue #3930). */
    settleMs?: number;
    /**
     * Precomputed via `classifyProviderPause` / `isProviderPaused` (issue
     * #1667). When true, refuse auto-complete even if the merge budget has
     * elapsed — a billing/quota stall is not post-merge cleanup hang.
     */
    providerPaused?: boolean;
  },
): DeliveredCompletionDecision {
  if (task.status !== 'inProgress') {
    return { autoComplete: false, reason: 'not_in_progress' };
  }
  if (task.autoCloseOnSignal !== true) {
    return { autoComplete: false, reason: 'not_opted_in' };
  }
  if (isActiveRalphLoop(task)) {
    return { autoComplete: false, reason: 'ralph_active' };
  }
  if (opts.providerPaused === true) {
    return { autoComplete: false, reason: 'provider_paused' };
  }
  if (!merged) {
    return { autoComplete: false, reason: 'not_merged' };
  }

  const nowMs = opts.now.getTime();
  const finishedAtMs = finishedAfterMergeAtMs(task, merged);
  if (finishedAtMs !== undefined) {
    const settleMs = opts.settleMs ?? DEFAULT_FINISHED_MERGED_SETTLE_MS;
    const elapsed = Math.max(0, nowMs - finishedAtMs);
    if (elapsed < settleMs) {
      return { autoComplete: false, reason: 'within_settle', elapsedSinceMergeMs: elapsed };
    }
    return { autoComplete: true, reason: 'finished_after_merge', elapsedSinceMergeMs: elapsed };
  }

  if (task.pendingSignal?.kind === 'completion_ready') {
    return { autoComplete: false, reason: 'already_signaled' };
  }

  const budgetMs = opts.budgetMs ?? DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS;
  // The budget clock starts when the merge was FIRST observed by the sweep.
  // Absent a recorded observation (first sighting this tick), elapsed is 0 —
  // never immediately complete on the very tick that discovers the merge, so a
  // just-delivered task always gets at least one budget window of cleanup.
  const observedAtMs = Number.isFinite(opts.firstObservedMergedAtMs)
    ? (opts.firstObservedMergedAtMs as number)
    : nowMs;
  const elapsedSinceMergeMs = Math.max(0, nowMs - observedAtMs);

  if (elapsedSinceMergeMs < budgetMs) {
    return { autoComplete: false, reason: 'within_budget', elapsedSinceMergeMs };
  }
  return { autoComplete: true, reason: 'post_merge_budget_exceeded', elapsedSinceMergeMs };
}

/** Which delivered-completion path fired: the settle path (#3930) or the budget path (#1560). */
export type DeliveredCompletionPath = 'finished_after_merge' | 'post_merge_budget_exceeded';

/** Format a wait in minutes for operator text: whole minutes, never "0m". */
function formatWaitMinutes(waitMs: number): string {
  return `${Math.max(1, Math.round(waitMs / 60_000))}m`;
}

/**
 * The note carried on the raised `completion_ready` signal. Names the merged PR
 * and the wait that applied, so the surfaced signal is self-evident.
 */
export function buildDeliveredCompletionNote(
  prNumber: number,
  waitMs: number,
  path: DeliveredCompletionPath = 'post_merge_budget_exceeded',
): string {
  if (path === 'finished_after_merge') {
    return (
      `Delivered: PR #${prNumber} merged and the task said it was finished; `
      + `completing after the ${formatWaitMinutes(waitMs)} settle time.`
    );
  }
  return (
    `Delivered: PR #${prNumber} merged; post-merge cleanup exceeded the ${formatWaitMinutes(waitMs)} `
    + 'budget — auto-completing.'
  );
}

/**
 * Build the completion digest for a delivery-aware auto-completion. The first
 * bullet explicitly names the merged PR **number** (acceptance criterion), and
 * the PR URL — when known — is carried in `prUrls` and a second bullet so the
 * dashboard links it.
 */
export function buildDeliveredCompletionDigest(
  merged: MergedPrAttribution,
  waitMs: number,
  path: DeliveredCompletionPath = 'post_merge_budget_exceeded',
): CompletionDigest {
  const bullets: string[] = [
    path === 'finished_after_merge'
      ? `Auto-completed on delivery: PR #${merged.prNumber} merged and the task said it was `
        + `finished; completed after the ${formatWaitMinutes(waitMs)} settle time`
      : `Auto-completed on delivery: PR #${merged.prNumber} merged; post-merge cleanup `
        + `exceeded the ${formatWaitMinutes(waitMs)} budget`,
  ];
  if (merged.prUrl) {
    bullets.push(`Merged PR: ${merged.prUrl}`);
  }
  const digest: CompletionDigest = {
    bullets,
    filesChanged: [],
  };
  if (merged.prUrl) digest.prUrls = [merged.prUrl];
  return digest;
}
