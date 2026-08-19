import type { Task } from './task-read-model.js';
import type { TurnState } from '../shared/contracts/task-status.js';
import { classifyFaaRootCause } from './faa-root-cause.js';
import { capacityHasResidualPhantomPressure } from './capacity-ledger.js';

/**
 * finishedAwaitingAck TTL reclaim (issue #1884) + meta/playbook auto-complete
 * (issue #2070) + capacity-pressure soft TTL for `awaiting_poll` phantoms
 * (issues #2355 / #2357 residual under idle_capacity).
 *
 * `finishedAwaitingAck` is a CAPACITY CLASS (see `core/capacity-ledger.ts`
 * `classifyTaskCapacity`), not a task status: a task is finishedAwaitingAck
 * when `status === 'inProgress'` AND `pendingSignal?.kind === 'completion_ready'`
 * — the agent finished its work and raised the completion signal, but nobody
 * has acknowledged it yet. Until that ack arrives the task keeps occupying an
 * active concurrency slot. In practice these sit for 15–45 minutes at a time
 * (the `finishedAwaitingAck_age` sentinel trips every ~30m), chronically
 * starving the pool the same way a hung task would, just without looking hung.
 *
 * This module is the pure selector for "which finishedAwaitingAck tasks have
 * sat past the TTL and should be force-completed to free their slot." It is
 * intentionally the sibling of `pending-task-ttl.ts` — same shape, same
 * age-from-signal-timestamp / inclusive-boundary rules — wired on the liveness
 * tick from `server/finished-awaiting-ack-ttl-sweep.ts`.
 *
 * Force-complete, not cancel: cancelling a task that already finished its work
 * would inflate `cancelled_delta` noise for no benefit (lucy #1995 lesson) —
 * the work is done, only the ack is missing. The wiring layer force-completes
 * with reason `finished_awaiting_ack_ttl` (hard path) or
 * `finished_awaiting_ack_capacity_pressure` (soft path under pressure).
 *
 * Stranded-PR exemption: a finishedAwaitingAck task that still holds an open,
 * unmerged PR (the `merge_required` delivery path) must NEVER be force-completed
 * out from under it — that PR is the actual deliverable and a premature
 * "completed" status would strand it with no task left driving it home. See
 * {@link ListExpiredFinishedAwaitingAckTasksOpts.isHoldingOpenPr} for the
 * fail-safe contract.
 *
 * Issue #2070 residual: meta/playbook tasks (orchestrator, issue-batch,
 * sentinel, reflection, …) correctly raise `completion_ready` but often have
 * *unfetched* PR refs scanned from child-PR mentions in their notes. The
 * strict fail-safe (`isHoldingOpenPr !== false`) then exempts them forever.
 * {@link listMetaFinishedAwaitingAckAutoCompleteTasks} is the allowlisted
 * drain that only blocks on a *confirmed-open* PR and defers live turns.
 *
 * Issue #2355: when effective utilization is low (or phantoms dominate) and the
 * pending queue is empty, `awaiting_poll` FAA may reclaim at a shorter soft TTL
 * so nominal-full fleets stop under-driving real work. Soft path never applies
 * to `manual_review_gate` / `auto_close_disabled` / `ack_sweep_backlog`.
 *
 * Issue #2357 residual: also fire soft path when
 * {@link capacityHasResidualPhantomPressure} matches idle_capacity + multi-slot
 * phantom hold (e.g. util=75%, phantom=3) that the #2355 util/phantom bounds
 * alone still skipped.
 *
 * Issue #2695: the #2355 soft path never covered actionable `auto_close_disabled`
 * FAA, so a finished non-ask-first task holding an *unconfirmed* PR ref squatted
 * a slot until the 120m completion-ready TTL escalation. Under capacity pressure,
 * such a task past {@link DEFAULT_FINISHED_AWAITING_ACK_ACTIONABLE_RECLAIM_TTL_MS}
 * now reclaims under a *relaxed* open-PR fail-safe (only a confirmed delivery-open
 * PR blocks). Ask-first and confirmed delivery-open holds are never relaxed.
 */

/** Default hard TTL (issue #1884): 15 minutes. */
export const DEFAULT_FINISHED_AWAITING_ACK_TTL_MS = 15 * 60_000;

/**
 * Soft TTL for capacity-pressure early reclaim of `awaiting_poll` FAA
 * (issue #2355): 5 minutes. Used only when
 * {@link capacityAllowsFinishedAwaitingAckEarlyReclaim} is true.
 */
export const DEFAULT_FINISHED_AWAITING_ACK_SOFT_TTL_MS = 5 * 60_000;

/**
 * Floor for soft TTL (issue #2355): 2 minutes — never race a just-raised
 * completion_ready that is still within one poll cadence.
 */
export const MIN_FINISHED_AWAITING_ACK_SOFT_TTL_MS = 2 * 60_000;

/**
 * Conservative age threshold for capacity-pressure reclaim of *actionable*
 * (non-ask-first) FAA whose open-PR state cannot be positively cleared
 * (issue #2695): 30 minutes.
 *
 * Root cause this re-enables: an `auto_close_disabled` FAA (finished, not
 * opted-in, not ask-first) that holds an agent-authored PR ref whose GitHub
 * state is unconfirmed (`delivery_state_unknown`, fetch lag) is skipped by
 * every fast reclaim path — the #2355 soft path is `awaiting_poll`-only, and
 * the #2170 ack-reaper / #1884 strict TTL both require the *strict* open-PR
 * fail-safe (`isHoldingOpenPr === false`). Its only drain is the completion-
 * ready TTL escalation at `completionReadyTtlMinutes` (120m default), so under
 * exactly the idle-capacity pressure the accelerated reclaim exists to relieve
 * it squats a live slot for tens of minutes (regression of #2355).
 *
 * Past this threshold, under capacity pressure, such a task reclaims under the
 * *relaxed* fail-safe: only a **confirmed** delivery-open PR (`=== true`)
 * blocks; an unconfirmed / unfetched ref no longer exempts it on fetch lag
 * alone. Ask-first (`manual_review_gate`) and confirmed delivery-open holds are
 * NEVER relaxed. Deliberately generous (well above the 5m soft TTL, at or under
 * the 30–60m the issue asks for) so it never races a genuine ack.
 */
export const DEFAULT_FINISHED_AWAITING_ACK_ACTIONABLE_RECLAIM_TTL_MS = 30 * 60_000;

/**
 * Floor for the actionable-FAA reclaim threshold (issue #2695): the hard TTL
 * (15m). The relaxed-fail-safe path must never fire *before* the strict hard
 * TTL reclaim has had its window — that keeps the strict open-PR fail-safe the
 * sole gate for the first 15m and guarantees the relaxed path only ever acts on
 * a genuinely long-lived squat, never on a task one poll away from an ack.
 */
export const MIN_FINISHED_AWAITING_ACK_ACTIONABLE_RECLAIM_TTL_MS = 15 * 60_000;

/**
 * Default age gate for meta/playbook FAA auto-complete (issue #2070): 12
 * minutes — slightly under the general 15m reclaim so allowlisted meta tasks
 * drain within one reaper cycle even when the strict PR fail-safe would hold
 * them for the unfetched-ref residual.
 */
export const DEFAULT_META_FAA_AUTO_COMPLETE_TTL_MS = 12 * 60_000;

/**
 * Hard max TTL (issue #1884): 30 minutes. `settings-store.ts` clamps
 * `finishedAwaitingAckTtlMinutes` to this ceiling so an operator override can
 * never restore the chronic 30–45m holds this feature exists to bound. Exported
 * so any caller that bypasses settings (tests, scripts) can enforce the same cap.
 */
export const MAX_FINISHED_AWAITING_ACK_TTL_MS = 30 * 60_000;

/**
 * Default effective-utilization ceiling for FAA capacity-pressure soft reclaim
 * (issue #2355). Below this percentage of productive occupancy, soft TTL may
 * apply (when the pending queue is empty).
 */
export const DEFAULT_FAA_CAPACITY_PRESSURE_EFFECTIVE_UTIL_PCT = 75;

/**
 * Default phantomActive bound for FAA capacity-pressure soft reclaim
 * (issue #2355). With an empty pending queue, phantom occupancy at or above
 * this bound also enables the soft path (even if effective util is high).
 */
export const DEFAULT_FAA_CAPACITY_PRESSURE_PHANTOM_BOUND = 4;

/**
 * Substring patterns matched against `playbookId` (and as a fallback, `name`)
 * for meta/playbook FAA auto-complete (issue #2070). Keep these supervisory —
 * never add implementer playbooks like `implement-github-issue` here.
 */
export const META_FAA_AUTO_COMPLETE_PLAYBOOK_PATTERNS: readonly RegExp[] = [
  /orchestrator/i,
  /issue-batch/i,
  /parallel-issue-batch/i,
  /sentinel/i,
  /reflection/i,
  /progress[\s_-]?watchdog/i,
  /idea-scout/i,
  /queue-feeder/i,
  /deploy-convergence/i,
  /orchestration/i,
  /prod-update[\s_-]?watchdog/i,
  /merge-rebase[\s_-]?watchdog/i,
];

export interface ExpiredFinishedAwaitingAckEntry {
  task: Task;
  /** How long the completion_ready signal has sat unacknowledged (now − pendingSignal.raisedAt). */
  ageMs: number;
  /**
   * True when selected under the capacity-pressure soft TTL (issue #2355) —
   * age is past soft but may still be under the hard TTL. Hard-path reclaim
   * leaves this false/undefined.
   */
  capacityPressureEarlyReclaim?: boolean;
  /**
   * True when the *relaxed* actionable fail-safe (issue #2695) is what cleared
   * this task — i.e. `isHoldingOpenPr` was `undefined` and the candidate would
   * have been `skipped_open_pr_unknown` under the strict path. Lets the sweep
   * audit a relaxed reclaim distinctly from an ordinary hard-TTL reclaim.
   * Hard/soft/strict selections leave this false/undefined.
   */
  actionableRelaxedReclaim?: boolean;
}

/**
 * Why a finishedAwaitingAck candidate was not selected for strict TTL reclaim
 * (issue #2084). Cumulative counters live on `FinishedAwaitingAckTtlReclaimMetrics`.
 *
 * - `skipped_bad_raised_at` — missing/unparseable `pendingSignal.raisedAt`
 *   (cannot compute age; fail-safe leave alone).
 * - `skipped_under_ttl` — completion_ready younger than the TTL.
 * - `skipped_open_pr_confirmed` — confirmed-open PR hold (`isHoldingOpenPr === true`).
 * - `skipped_open_pr_unknown` — unknown/unwired PR hold (`isHoldingOpenPr` is
 *   `undefined` or the predicate is omitted). Distinct from confirmed so GitHub
 *   state-fetch lag is not reported as a stranded PR (issue #2228).
 *   Aggregate `skippedOpenPrFailsafe` on health/metrics = confirmed + unknown.
 *   Dominant residual after #1884/#2070 when unfetched PR refs keep implementers
 *   (and non-allowlisted tasks) exempt from both strict and meta reclaim.
 */
export type FinishedAwaitingAckReclaimSkipReason =
  | 'skipped_bad_raised_at'
  | 'skipped_under_ttl'
  | 'skipped_open_pr_confirmed'
  | 'skipped_open_pr_unknown';

export const FINISHED_AWAITING_ACK_RECLAIM_SKIP_REASONS: readonly FinishedAwaitingAckReclaimSkipReason[] =
  [
    'skipped_bad_raised_at',
    'skipped_under_ttl',
    'skipped_open_pr_confirmed',
    'skipped_open_pr_unknown',
  ] as const;

export type FinishedAwaitingAckReclaimSkipCounts = Record<
  FinishedAwaitingAckReclaimSkipReason,
  number
>;

export function emptyFinishedAwaitingAckReclaimSkipCounts(): FinishedAwaitingAckReclaimSkipCounts {
  return {
    skipped_bad_raised_at: 0,
    skipped_under_ttl: 0,
    skipped_open_pr_confirmed: 0,
    skipped_open_pr_unknown: 0,
  };
}

/** Aggregate open-PR fail-safe skips (confirmed + unknown) for health/metrics compat. */
export function finishedAwaitingAckOpenPrFailsafeSkipTotal(
  skips: Pick<
    FinishedAwaitingAckReclaimSkipCounts,
    'skipped_open_pr_confirmed' | 'skipped_open_pr_unknown'
  >,
): number {
  return skips.skipped_open_pr_confirmed + skips.skipped_open_pr_unknown;
}

/**
 * One finishedAwaitingAck candidate's fate on a single strict-path selection
 * pass (issue #2084 / #2355). Answers why residual FAA occupancy stays high when
 * `reclaimedTotal` is flat.
 */
export interface FinishedAwaitingAckReclaimCandidateOutcome {
  taskId: string;
  /**
   * Selected for reclaim (`selected` = hard TTL; `capacity_pressure_early_reclaim`
   * = soft TTL under capacity pressure, issue #2355), or the skip reason.
   */
  outcome:
    | 'selected'
    | 'capacity_pressure_early_reclaim'
    | FinishedAwaitingAckReclaimSkipReason;
  /** Present when age was computed (not for bad raisedAt). */
  ageMs?: number;
}

/** Full selection result for one strict FAA reclaim pass (issue #2084). */
export interface FinishedAwaitingAckReclaimSelection {
  /** Tasks past TTL and clear of the open-PR fail-safe — oldest-first. */
  expired: ExpiredFinishedAwaitingAckEntry[];
  /**
   * How many inProgress + completion_ready tasks were considered this pass
   * (denominator for skip-reason breakdown). Non-FAA tasks are not counted.
   */
  candidatesConsidered: number;
  /** Per-reason skip counts for candidates that were not selected. */
  skips: FinishedAwaitingAckReclaimSkipCounts;
  /** Per-candidate outcomes with task ids. */
  outcomes: FinishedAwaitingAckReclaimCandidateOutcome[];
}

export interface ListExpiredFinishedAwaitingAckTasksOpts {
  now?: Date;
  /** Hard TTL (default {@link DEFAULT_FINISHED_AWAITING_ACK_TTL_MS}). */
  ttlMs?: number;
  /**
   * Soft TTL for capacity-pressure early reclaim of `awaiting_poll` FAA
   * (issue #2355). Used only when {@link capacityAllowsEarlyReclaim} is true
   * and the candidate classifies as `awaiting_poll`. Defaults to
   * {@link DEFAULT_FINISHED_AWAITING_ACK_SOFT_TTL_MS}.
   */
  softTtlMs?: number;
  /**
   * When true, `awaiting_poll` candidates may select once age reaches the soft
   * TTL instead of waiting for the hard bound (issue #2355). Wire from the
   * capacity ledger via {@link capacityAllowsFinishedAwaitingAckEarlyReclaim}.
   */
  capacityAllowsEarlyReclaim?: boolean;
  /**
   * Conservative age threshold for the actionable relaxed-fail-safe reclaim
   * (issue #2695). Used only when {@link capacityAllowsEarlyReclaim} is true and
   * the candidate is NOT ask-first: past this age, a candidate reclaims even when
   * its open-PR state is unconfirmed (`isHoldingOpenPr === undefined`) — only a
   * *confirmed* open PR still blocks. Clamped to a floor of the hard TTL by
   * {@link effectiveFinishedAwaitingAckActionableReclaimTtlMs}. Defaults to
   * {@link DEFAULT_FINISHED_AWAITING_ACK_ACTIONABLE_RECLAIM_TTL_MS}.
   */
  actionableReclaimTtlMs?: number;
  /**
   * Stale-completion threshold for FAA root-cause classification (soft-path
   * cause filter). Defaults match {@link classifyFaaRootCause}.
   */
  staleThresholdMs?: number;
  /**
   * Stranded-PR / `merge_required` exemption predicate (issue #1884). Injected
   * so this selector stays pure and I/O-free — the wiring layer supplies a
   * real implementation backed by `GitHubStateStore`. Returns:
   *
   * - `true`  — the task holds a confirmed-open PR. Exempt, always.
   * - `false` — confirmed no open PR is tied to the task. Safe to reclaim.
   * - `undefined` — unknown or unavailable (never checked, GitHub state not
   *   yet fetched, predicate not wired, etc). FAIL-SAFE: treated exactly like
   *   `true`. A possible stranded delivery must never be clobbered just
   *   because we couldn't confirm it either way.
   *
   * Omitting this option entirely has the same fail-safe effect as a predicate
   * that always returns `undefined` — every finishedAwaitingAck task is
   * treated as a possible PR hold and left alone. Callers that want the TTL to
   * actually reclaim anything MUST wire a real predicate.
   */
  isHoldingOpenPr?: (task: Task) => boolean | undefined;
}

/**
 * Soft TTL clamp for one FAA selection pass (issue #2355). Soft is always at
 * or below hard and never below {@link MIN_FINISHED_AWAITING_ACK_SOFT_TTL_MS}.
 */
export function effectiveFinishedAwaitingAckSoftTtlMs(opts: {
  ttlMs?: number;
  softTtlMs?: number;
}): number {
  const hard = opts.ttlMs ?? DEFAULT_FINISHED_AWAITING_ACK_TTL_MS;
  const soft = opts.softTtlMs ?? DEFAULT_FINISHED_AWAITING_ACK_SOFT_TTL_MS;
  return Math.min(hard, Math.max(MIN_FINISHED_AWAITING_ACK_SOFT_TTL_MS, soft));
}

/**
 * Actionable relaxed-fail-safe reclaim threshold for one FAA selection pass
 * (issue #2695). Floored at the hard TTL (and at
 * {@link MIN_FINISHED_AWAITING_ACK_ACTIONABLE_RECLAIM_TTL_MS}) so the relaxed
 * path can never fire before the strict hard-TTL reclaim has had its window.
 */
export function effectiveFinishedAwaitingAckActionableReclaimTtlMs(opts: {
  ttlMs?: number;
  actionableReclaimTtlMs?: number;
}): number {
  const hard = opts.ttlMs ?? DEFAULT_FINISHED_AWAITING_ACK_TTL_MS;
  const actionable =
    opts.actionableReclaimTtlMs ?? DEFAULT_FINISHED_AWAITING_ACK_ACTIONABLE_RECLAIM_TTL_MS;
  return Math.max(hard, MIN_FINISHED_AWAITING_ACK_ACTIONABLE_RECLAIM_TTL_MS, actionable);
}

/**
 * Capacity gate for soft `awaiting_poll` FAA reclaim (issues #2355 / #2357).
 *
 * Fires only when the pending queue is empty (no work waiting on free slots
 * that would already drain phantoms via normal spawn pressure) AND either:
 * - effective utilization is below threshold (nominal-full / effective-idle), or
 * - phantomActive is at or above the #2355 occupancy bound, or
 * - residual idle_capacity pressure (issue #2357): idleEffectiveSlots > 0 and
 *   phantomActive ≥ 2 — the live residual util=75%/phantom=3 shape that
 *   capacityThroughputVerdict already labels idle_capacity.
 *
 * Complements (does not replace) the provider_paused soft gate (#2225 / #2357),
 * which also keys residual pressure on idle effective slots.
 */
export function capacityAllowsFinishedAwaitingAckEarlyReclaim(input: {
  effectiveUtilizationPct: number;
  phantomActive: number;
  pendingQueueDepth: number;
  /**
   * Productive free slots (issue #2357). Same key as
   * capacityThroughputVerdict.idleEffectiveSlots — when present, residual
   * multi-phantom hold under idle_capacity enables soft reclaim even if util
   * is at the #2355 threshold and phantomActive is under the #2355 bound of 4.
   */
  idleEffectiveSlots?: number;
  /** Default {@link DEFAULT_FAA_CAPACITY_PRESSURE_EFFECTIVE_UTIL_PCT}. */
  effectiveUtilThresholdPct?: number;
  /** Default {@link DEFAULT_FAA_CAPACITY_PRESSURE_PHANTOM_BOUND}. */
  phantomBound?: number;
}): boolean {
  const pending = input.pendingQueueDepth;
  if (!Number.isFinite(pending) || pending > 0) return false;

  // Residual idle_capacity + multi-phantom (issue #2357) — agree with
  // capacityThroughputVerdict so soft reclaim fires on the residual shape.
  if (
    input.idleEffectiveSlots !== undefined
    && capacityHasResidualPhantomPressure({
      idleEffectiveSlots: input.idleEffectiveSlots,
      phantomActive: input.phantomActive,
      pendingQueueDepth: pending,
    })
  ) {
    return true;
  }

  const utilThreshold =
    input.effectiveUtilThresholdPct ?? DEFAULT_FAA_CAPACITY_PRESSURE_EFFECTIVE_UTIL_PCT;
  const phantomBound =
    input.phantomBound ?? DEFAULT_FAA_CAPACITY_PRESSURE_PHANTOM_BOUND;

  const util = input.effectiveUtilizationPct;
  if (Number.isFinite(util) && util < utilThreshold) return true;

  const phantoms = input.phantomActive;
  return Number.isFinite(phantoms) && phantoms >= phantomBound;
}

/**
 * Pure selection of finishedAwaitingAck tasks past the (hard or soft) TTL,
 * with skip-reason breakdown (issues #2084 / #2355). Mirrors
 * {@link selectExpiredHungSuspectTasks}.
 *
 * Age is measured from `task.pendingSignal.raisedAt` (ISO string) — the same
 * field `buildCapacityLedger` uses for `oldestFinishedAwaitingAckAgeMs`, so
 * "past the TTL" here agrees with what the capacity ledger already reports.
 * Boundary is inclusive: `ageMs >= effectiveTtlMs` selects.
 *
 * Effective TTL per candidate (issue #2355):
 * - hard TTL by default;
 * - soft TTL only when `capacityAllowsEarlyReclaim` AND the task classifies as
 *   `awaiting_poll` (never soft-reclaim `manual_review_gate` /
 *   `auto_close_disabled` / `ack_sweep_backlog`).
 *
 * Fail-safe strictness per candidate (issue #2695):
 * - strict by default and for the soft path — only `isHoldingOpenPr === false`
 *   clears; `true`/`undefined` both exempt;
 * - relaxed for an actionable (non-ask-first) candidate past
 *   `actionableReclaimTtlMs` under `capacityAllowsEarlyReclaim` — only a
 *   *confirmed* open PR (`=== true`) blocks, so an unconfirmed ref no longer
 *   exempts a long-lived squat on fetch lag alone.
 *
 * Guards (evaluation order for a finishedAwaitingAck candidate):
 *
 * - only `status === 'inProgress'` with `pendingSignal?.kind === 'completion_ready'`
 *   counts as a candidate — matches `classifyTaskCapacity` exactly;
 * - missing / unparseable `raisedAt` → `skipped_bad_raised_at`;
 * - age under effective TTL → `skipped_under_ttl`;
 * - open-PR fail-safe blocks → `skipped_open_pr_confirmed` (confirmed-open) or
 *   `skipped_open_pr_unknown` (unknown/unwired, strict path only — issue #2228);
 * - otherwise selected (`capacity_pressure_early_reclaim` when soft path and
 *   age still under hard TTL; `selected` for hard-path / actionable reclaim).
 *
 * Invariant: `candidatesConsidered === expired.length + sum(skips.*)`.
 */
export function selectExpiredFinishedAwaitingAckTasks(
  tasks: readonly Task[],
  opts: ListExpiredFinishedAwaitingAckTasksOpts = {},
): FinishedAwaitingAckReclaimSelection {
  const nowMs = (opts.now ?? new Date()).getTime();
  const hardTtlMs = opts.ttlMs ?? DEFAULT_FINISHED_AWAITING_ACK_TTL_MS;
  const softTtlMs = effectiveFinishedAwaitingAckSoftTtlMs({
    ttlMs: hardTtlMs,
    softTtlMs: opts.softTtlMs,
  });
  const actionableReclaimTtlMs = effectiveFinishedAwaitingAckActionableReclaimTtlMs({
    ttlMs: hardTtlMs,
    actionableReclaimTtlMs: opts.actionableReclaimTtlMs,
  });
  const capacityEarly = opts.capacityAllowsEarlyReclaim === true;
  const out: ExpiredFinishedAwaitingAckEntry[] = [];
  const skips = emptyFinishedAwaitingAckReclaimSkipCounts();
  const outcomes: FinishedAwaitingAckReclaimCandidateOutcome[] = [];
  let candidatesConsidered = 0;

  for (const task of tasks) {
    if (task.status !== 'inProgress') continue;
    const signal = task.pendingSignal;
    if (signal?.kind !== 'completion_ready') continue;

    candidatesConsidered += 1;

    const raisedAtMs = Date.parse(signal.raisedAt);
    if (!Number.isFinite(raisedAtMs)) {
      skips.skipped_bad_raised_at += 1;
      outcomes.push({ taskId: task.id, outcome: 'skipped_bad_raised_at' });
      continue;
    }

    const ageMs = nowMs - raisedAtMs;

    // Soft path only for awaiting_poll under capacity pressure (issue #2355).
    // Other causes keep the hard TTL so manual_review_gate / auto_close_disabled
    // never get an accelerated reclaim window. Also exclude ask-first delivery:
    // under production defaults (stale 60m, hard 15m) ask-first stays classified
    // as awaiting_poll for the entire soft window — accelerating it would collapse
    // the human review hold before hard TTL / manual_review_gate classification.
    let useSoftPath = false;
    // Actionable relaxed-fail-safe reclaim (issue #2695): a non-ask-first FAA
    // squatting past the conservative actionable threshold under capacity
    // pressure. Keyed on `deliveryAuthorization` directly (not the cause label)
    // so the path is cause-independent — the exemption is precisely the
    // human-review population (ask-first / manual_review_gate) and nothing else.
    // This is the `auto_close_disabled` squatter as the /api/health ledger
    // classifies it (faaTtlMs = completionReadyTtl); note that inside THIS
    // selector the same task labels as `ack_sweep_backlog` because the local
    // classification passes the 15m hard TTL, which is why the gate is keyed on
    // authorization + age, not the cause. Covers the squat whose unconfirmed PR
    // ref the strict fail-safe would exempt until the 120m TTL escalation.
    let useActionableRelaxed = false;
    if (capacityEarly && task.deliveryAuthorization !== 'ask-first') {
      const cause = classifyFaaRootCause(task, {
        now: nowMs,
        staleThresholdMs: opts.staleThresholdMs,
        ttlMs: hardTtlMs,
      });
      useSoftPath = cause === 'awaiting_poll';
      useActionableRelaxed = ageMs >= actionableReclaimTtlMs;
    }
    const effectiveTtlMs = useSoftPath ? softTtlMs : hardTtlMs;

    if (ageMs < effectiveTtlMs) {
      skips.skipped_under_ttl += 1;
      outcomes.push({ taskId: task.id, outcome: 'skipped_under_ttl', ageMs });
      continue;
    }

    // Fail-safe. Strict path (default): only a definite `false` clears — `true`
    // and `undefined` (state-fetch lag / no predicate wired) both exempt it
    // (issue #2228 splits confirmed-open vs unknown). Relaxed path (issue #2695,
    // actionable non-ask-first past the conservative threshold under capacity
    // pressure): only a *confirmed* open PR (`=== true`) blocks — an unconfirmed
    // ref no longer exempts a long-lived squat on fetch lag alone. A confirmed
    // delivery-open PR is never clobbered under either path.
    const openPrHold = opts.isHoldingOpenPr?.(task);
    const blockedByOpenPr = useActionableRelaxed
      ? openPrHold === true
      : openPrHold !== false;
    if (blockedByOpenPr) {
      if (openPrHold === true) {
        skips.skipped_open_pr_confirmed += 1;
        outcomes.push({
          taskId: task.id,
          outcome: 'skipped_open_pr_confirmed',
          ageMs,
        });
      } else {
        skips.skipped_open_pr_unknown += 1;
        outcomes.push({
          taskId: task.id,
          outcome: 'skipped_open_pr_unknown',
          ageMs,
        });
      }
      continue;
    }

    // Soft-path selection under hard TTL → capacity_pressure_early_reclaim;
    // at or past hard TTL the reclaim is normal hard-path (even if soft applied).
    const capacityPressureEarlyReclaim = useSoftPath && ageMs < hardTtlMs;
    // The relaxed fail-safe *materially* cleared this task only when the strict
    // path would have blocked it — i.e. the open-PR state was unknown. A cleared
    // (`false`) PR would have selected under the strict path too, so it is not a
    // relaxed reclaim (issue #2695).
    const actionableRelaxedReclaim = useActionableRelaxed && openPrHold === undefined;
    out.push({
      task,
      ageMs,
      capacityPressureEarlyReclaim,
      ...(actionableRelaxedReclaim ? { actionableRelaxedReclaim: true } : {}),
    });
    outcomes.push({
      taskId: task.id,
      outcome: capacityPressureEarlyReclaim
        ? 'capacity_pressure_early_reclaim'
        : 'selected',
      ageMs,
    });
  }

  return {
    expired: out.sort(
      (a, b) =>
        Date.parse(a.task.pendingSignal!.raisedAt) - Date.parse(b.task.pendingSignal!.raisedAt),
    ),
    candidatesConsidered,
    skips,
    outcomes,
  };
}

/**
 * Pure selection of finishedAwaitingAck tasks past the TTL, oldest-first.
 * Thin wrapper over {@link selectExpiredFinishedAwaitingAckTasks} for call
 * sites that only need the expired list (issue #1884 API).
 */
export function listExpiredFinishedAwaitingAckTasks(
  tasks: readonly Task[],
  opts: ListExpiredFinishedAwaitingAckTasksOpts = {},
): ExpiredFinishedAwaitingAckEntry[] {
  return selectExpiredFinishedAwaitingAckTasks(tasks, opts).expired;
}

/**
 * True when a task matches the meta/playbook allowlist for age-gated FAA
 * auto-complete (issue #2070).
 *
 * Matching order (deliberate):
 * 1. When `playbookId` is present, match **only** against it — never against
 *    `name`. An implementer whose generated name happens to contain
 *    "orchestrator" / "sentinel" / "reflection" must keep the strict PR
 *    fail-safe.
 * 2. When `playbookId` is absent, fall back to `name` so schedule-launched
 *    meta tasks without a playbook stamp (e.g. "Lucy Progress Watchdog") still
 *    qualify.
 */
export function isMetaFaaAutoCompletePlaybook(
  task: Pick<Task, 'playbookId' | 'name'>,
): boolean {
  const primary =
    typeof task.playbookId === 'string' && task.playbookId.length > 0
      ? task.playbookId
      : typeof task.name === 'string' && task.name.length > 0
        ? task.name
        : null;
  if (!primary) return false;
  return META_FAA_AUTO_COMPLETE_PLAYBOOK_PATTERNS.some((re) => re.test(primary));
}

/**
 * True when the task is eligible for the #2070 meta FAA auto-complete path:
 * allowlisted meta/playbook only. Non-allowlist tasks (including implementers
 * that raised `completion_ready` via HTTP) stay on the strict #1884 reclaim
 * path so unfetched open-PR refs are never auto-completed under the relaxed
 * fail-safe.
 *
 * Live-turn / interactive TOCTOU is applied at sweep re-GET time
 * ({@link taskHasLiveTurn} / pane veto), not in pure selection.
 */
export function isMetaFaaAutoCompleteEligible(
  task: Pick<Task, 'playbookId' | 'name' | 'pendingSignal'>,
): boolean {
  return isMetaFaaAutoCompletePlaybook(task);
}

/**
 * True when any non-terminal session reports a live/interactive turn. Used as
 * the pure half of the Lucy #2238 TOCTOU veto: never auto-complete while the
 * agent is still mid-turn, waiting on a human, or hard-blocked (permission).
 */
export function taskHasLiveTurn(task: Pick<Task, 'sessions'>): boolean {
  for (const session of task.sessions) {
    if (session.lastStatus === 'completed' || session.lastStatus === 'aborted') continue;
    const turn: TurnState | undefined = session.lastTurnState;
    if (turn === 'running' || turn === 'waiting_for_input' || turn === 'blocked') return true;
  }
  return false;
}

export interface ListMetaFaaAutoCompleteOpts {
  now?: Date;
  /** Age gate; defaults to {@link DEFAULT_META_FAA_AUTO_COMPLETE_TTL_MS}. */
  ttlMs?: number;
  /**
   * PR-hold predicate. For meta auto-complete the fail-safe is *relaxed*:
   * only a definite `true` (confirmed-open PR) blocks. `false` and
   * `undefined` (unfetched / unknown refs — the chronic residual) both allow
   * completion for allowlisted meta tasks.
   */
  isHoldingOpenPr?: (task: Task) => boolean | undefined;
  /**
   * Optional pure pre-filter. Live-turn / interactive TOCTOU is **not**
   * applied here — the sweep re-GETs and defers so deferrals stay countable.
   * Inject this only when a pure caller wants an extra exclusion.
   */
  shouldDefer?: (task: Task) => boolean;
}

/**
 * Pure selection of aged allowlisted meta/playbook finishedAwaitingAck tasks
 * for auto-complete (issue #2070). Oldest-first. Does not complete — the
 * sweep re-GETs + re-checks TOCTOU immediately before `completeTask`.
 */
export function listMetaFinishedAwaitingAckAutoCompleteTasks(
  tasks: readonly Task[],
  opts: ListMetaFaaAutoCompleteOpts = {},
): ExpiredFinishedAwaitingAckEntry[] {
  const nowMs = (opts.now ?? new Date()).getTime();
  const ttlMs = opts.ttlMs ?? DEFAULT_META_FAA_AUTO_COMPLETE_TTL_MS;
  const out: ExpiredFinishedAwaitingAckEntry[] = [];

  for (const task of tasks) {
    if (task.status !== 'inProgress') continue;
    const signal = task.pendingSignal;
    if (signal?.kind !== 'completion_ready') continue;
    if (!isMetaFaaAutoCompleteEligible(task)) continue;

    const raisedAtMs = Date.parse(signal.raisedAt);
    if (!Number.isFinite(raisedAtMs)) continue;

    const ageMs = nowMs - raisedAtMs;
    if (ageMs < ttlMs) continue;

    // Live-turn / interactive veto is applied at TOCTOU re-GET time in the
    // sweep (so deferrals are countable). Optional shouldDefer still lets a
    // pure caller pre-filter when desired.
    if (opts.shouldDefer?.(task) === true) continue;

    // Allowlist-only eligibility above; relaxed fail-safe: only confirmed-open
    // PR blocks (unfetched refs are the residual this path exists to drain).
    if (opts.isHoldingOpenPr?.(task) === true) continue;

    out.push({ task, ageMs });
  }

  return out.sort(
    (a, b) => Date.parse(a.task.pendingSignal!.raisedAt) - Date.parse(b.task.pendingSignal!.raisedAt),
  );
}
