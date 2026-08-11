import type { Task } from './task-read-model.js';
import type { TurnState } from '../shared/contracts/task-status.js';

/**
 * finishedAwaitingAck TTL reclaim (issue #1884) + meta/playbook auto-complete
 * (issue #2070).
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
 * with reason `finished_awaiting_ack_ttl` instead.
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
 */

/** Default TTL (issue #1884): 15 minutes. */
export const DEFAULT_FINISHED_AWAITING_ACK_TTL_MS = 15 * 60_000;

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
 * pass (issue #2084). Answers why residual FAA occupancy stays high when
 * `reclaimedTotal` is flat.
 */
export interface FinishedAwaitingAckReclaimCandidateOutcome {
  taskId: string;
  /** Selected for reclaim, or the skip reason that applied. */
  outcome: 'selected' | FinishedAwaitingAckReclaimSkipReason;
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
  ttlMs?: number;
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
 * Pure selection of finishedAwaitingAck tasks past the TTL, with skip-reason
 * breakdown (issue #2084). Mirrors {@link selectExpiredHungSuspectTasks}.
 *
 * Age is measured from `task.pendingSignal.raisedAt` (ISO string) — the same
 * field `buildCapacityLedger` uses for `oldestFinishedAwaitingAckAgeMs`, so
 * "past the TTL" here agrees with what the capacity ledger already reports.
 * Boundary is inclusive: `ageMs >= ttlMs` selects. Guards (evaluation order
 * for a finishedAwaitingAck candidate):
 *
 * - only `status === 'inProgress'` with `pendingSignal?.kind === 'completion_ready'`
 *   counts as a candidate — matches `classifyTaskCapacity` exactly;
 * - missing / unparseable `raisedAt` → `skipped_bad_raised_at`;
 * - age under TTL → `skipped_under_ttl`;
 * - open-PR fail-safe true → `skipped_open_pr_confirmed`; unknown/unwired →
 *   `skipped_open_pr_unknown` (issue #2228; reclaim still blocked either way);
 * - otherwise selected.
 *
 * Invariant: `candidatesConsidered === expired.length + sum(skips.*)`.
 */
export function selectExpiredFinishedAwaitingAckTasks(
  tasks: readonly Task[],
  opts: ListExpiredFinishedAwaitingAckTasksOpts = {},
): FinishedAwaitingAckReclaimSelection {
  const nowMs = (opts.now ?? new Date()).getTime();
  const ttlMs = opts.ttlMs ?? DEFAULT_FINISHED_AWAITING_ACK_TTL_MS;
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
    if (ageMs < ttlMs) {
      skips.skipped_under_ttl += 1;
      outcomes.push({ taskId: task.id, outcome: 'skipped_under_ttl', ageMs });
      continue;
    }

    // Fail-safe: only a definite `false` clears the task for reclaim. `true`
    // and `undefined` (including "no predicate wired") both exempt it.
    // Issue #2228: split confirmed-open vs unknown (state-fetch lag / unwired).
    const openPrHold = opts.isHoldingOpenPr?.(task);
    if (openPrHold !== false) {
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

    out.push({ task, ageMs });
    outcomes.push({ taskId: task.id, outcome: 'selected', ageMs });
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
