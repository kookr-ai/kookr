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

import type { CompletionDigest } from './completion-digest.js';
import type { Task } from './task-read-model.js';

/** Default post-merge cleanup budget: 10 minutes (issue #1560). */
export const DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS = 10 * 60 * 1000;

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
}

/**
 * Select the task's own merged PR from its tracked references, or null.
 *
 * Only PRs discovered from the **agent's activity** count as delivery —
 * prompt-referenced merged PRs are excluded, so a live task whose prompt cites
 * an already-merged PR is never force-completed (correctness review, #1560).
 * Returns the first qualifying merged PR (references are agent-authored PRs the
 * task opened during its run).
 */
export function selectDeliveredMergedPr(prs: readonly TrackedPrRef[]): MergedPrAttribution | null {
  const merged = prs.find(
    (pr) => pr.status === 'merged' && pr.detectedFrom !== PROMPT_DETECTED_FROM,
  );
  if (!merged) return null;
  return {
    prNumber: merged.number,
    ...(merged.url ? { prUrl: merged.url } : {}),
    ...(merged.owner ? { owner: merged.owner } : {}),
    ...(merged.repo ? { repo: merged.repo } : {}),
  };
}

/**
 * Why a delivered task was (not) auto-completed.
 * - `post_merge_budget_exceeded` — the actionable case: merged PR, cleanup ran
 *   past the budget.
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
  /** Milliseconds elapsed since the merge was first observed, when merged. */
  elapsedSinceMergeMs?: number;
}

function isActiveRalphLoop(task: Pick<Task, 'ralphLoop'>): boolean {
  return task.ralphLoop?.status === 'running' || task.ralphLoop?.status === 'paused';
}

/**
 * Decide whether a running task should self-complete because its PR is merged
 * and post-merge cleanup has exceeded the budget.
 *
 * Pure and clock-injected: `now` and `firstObservedMergedAtMs` are supplied by
 * the caller so the boundary (`elapsed >= budget`) is exact under a controlled
 * clock. Guards, in order, so the reason is the first failing precondition:
 *   1. task must be `inProgress` (a running task),
 *   2. task must have opted into `autoCloseOnSignal` (ask-first / human-review
 *      tasks keep the existing completion-ready TTL fallback),
 *   3. no active Ralph loop (that lifecycle owns completion),
 *   4. no pending `completion_ready` signal (the normal auto-close/TTL path
 *      already owns a task that signaled),
 *   5. agent must not be provider-paused on billing/quota (issue #1667),
 *   6. an attributable merged PR must exist (never auto-complete otherwise),
 *   7. `now - firstObservedMergedAt >= budget`.
 */
export function classifyDeliveredCompletion(
  task: Pick<Task, 'status' | 'ralphLoop' | 'pendingSignal' | 'autoCloseOnSignal'>,
  merged: MergedPrAttribution | null,
  opts: {
    now: Date;
    firstObservedMergedAtMs?: number;
    budgetMs?: number;
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
  if (task.pendingSignal?.kind === 'completion_ready') {
    return { autoComplete: false, reason: 'already_signaled' };
  }
  if (opts.providerPaused === true) {
    return { autoComplete: false, reason: 'provider_paused' };
  }
  if (!merged) {
    return { autoComplete: false, reason: 'not_merged' };
  }

  const budgetMs = opts.budgetMs ?? DEFAULT_POST_MERGE_CLEANUP_BUDGET_MS;
  const nowMs = opts.now.getTime();
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

/**
 * The note carried on the raised `completion_ready` signal AND the audit row.
 * Names the merged PR so the surfaced signal and audit trail are self-evident.
 */
export function buildDeliveredCompletionNote(prNumber: number, budgetMs: number): string {
  const budgetMin = Math.round(budgetMs / 60_000);
  return (
    `Delivered: PR #${prNumber} merged; post-merge cleanup exceeded the ${budgetMin}m `
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
  budgetMs: number,
): CompletionDigest {
  const budgetMin = Math.round(budgetMs / 60_000);
  const bullets: string[] = [
    `Auto-completed on delivery: PR #${merged.prNumber} merged; post-merge cleanup `
      + `exceeded the ${budgetMin}m budget`,
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
