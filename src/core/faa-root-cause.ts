import type { Task } from './task-read-model.js';
import {
  DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS,
  classifyCompletionReadyClosePolicy,
} from './completion/completion-ready-cleanup.js';

/**
 * Root-cause classification for a `finishedAwaitingAck` (FAA) occurrence
 * (issue #2142).
 *
 * FAA is the single highest-churn capacity pattern in the harness: the
 * `finishedAwaitingAck_age` anomaly fires chronically, yet nearly every
 * merged mitigation (reclaim, reapers, skip-reason counters, status pills,
 * Discord pages) is *downstream symptom plumbing* — none records WHY the ack
 * lags in the first place. This taxonomy classifies each live FAA task at the
 * source so one window of data can name the dominant cause and a single root
 * fix can target it, instead of shipping another symptom PR.
 *
 * The four causes map to the distinct stages that can leave a
 * `completion_ready` signal sitting unacknowledged:
 *  - `awaiting_poll`: the signal is younger than the stale threshold — still
 *    inside the normal supervisor/orchestrator poll cadence + sleep window.
 *    Not (yet) a stall; this is the healthy baseline.
 *  - `ack_sweep_backlog`: the signal is past the stale threshold AND the task
 *    is auto-closable (opted in, or past TTL) — so the background auto-close
 *    sweep (`autoCloseStaleCompletionReadyTasks`, capped at 2 per 60s) or the
 *    ack handler is simply behind. This is the machine-side ack lag the issue
 *    is hunting: a burst of completions the drain valve can't keep up with.
 *  - `manual_review_gate`: past the stale threshold, NOT auto-closable because
 *    the task is `deliveryAuthorization: 'ask-first'` — genuinely waiting on a
 *    human decision by design, not a bug.
 *  - `auto_close_disabled`: past the stale threshold, NOT auto-closable and NOT
 *    ask-first — the task never opted into auto-close and no TTL escalation is
 *    configured. A configuration gap, not a latency problem.
 *
 * Pure classification: no I/O, derived only from the task record + a clock, so
 * it is safe to call for every FAA task on the `GET /api/health` hot path.
 */
export type FaaRootCause =
  | 'awaiting_poll'
  | 'ack_sweep_backlog'
  | 'manual_review_gate'
  | 'auto_close_disabled';

/**
 * Canonical cause set, ordered by reporting priority: the actionable stall
 * causes come first so {@link dominantFaaRootCause}'s tie-break surfaces a real
 * backlog ahead of the by-design or healthy-baseline causes. (The `/api/health`
 * tally object uses its own stable display order — see
 * {@link emptyFaaRootCauseTally} — independent of this array.)
 */
export const FAA_ROOT_CAUSES: readonly FaaRootCause[] = [
  'ack_sweep_backlog',
  'auto_close_disabled',
  'manual_review_gate',
  'awaiting_poll',
];

export interface FaaRootCauseDeps {
  /** Sampling clock (ms since epoch). */
  now: number;
  /**
   * The age past which an unacknowledged `completion_ready` signal stops being
   * "normal poll latency" and counts as a genuine stall. Defaults to
   * {@link DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS} so callers match the
   * existing stale-completion reporting window without threading config.
   */
  staleThresholdMs?: number;
  /**
   * The TTL-escalation window (issue #1526 FM5): a not-opted-in signal older
   * than this becomes auto-closable anyway. Mirrors the same `ttlMs` the
   * background sweep uses. `undefined` disables the TTL tier (matching every
   * caller that has not wired an escalation TTL).
   */
  ttlMs?: number;
}

/**
 * Classify a single task's FAA root cause, or `null` when the task is not
 * finished-awaiting-ack at all (not in-progress, or no `completion_ready`
 * signal). The `null` contract is exactly the negation of the ledger's own FAA
 * predicate ({@link classifyTaskCapacity} → `'finishedAwaitingAck'`), so every
 * task the ledger counts as FAA classifies to a non-null cause and the
 * per-cause tally sums to `byClass.finishedAwaitingAck`.
 *
 * An un-ageable signal — a malformed or future `raisedAt` (clock skew or
 * hand-edited state) — is treated as `awaiting_poll`: it cannot be aged, so it
 * is assumed to be within normal poll cadence rather than dropped (which would
 * silently break the sum invariant) or misclassified as a stall.
 */
export function classifyFaaRootCause(
  task: Pick<Task, 'status' | 'pendingSignal' | 'autoCloseOnSignal' | 'deliveryAuthorization'>,
  deps: FaaRootCauseDeps,
): FaaRootCause | null {
  const signal = task.pendingSignal;
  if (task.status !== 'inProgress' || signal?.kind !== 'completion_ready') return null;

  const raisedAtMs = Date.parse(signal.raisedAt);
  // Un-ageable (malformed or future) timestamp: cannot compute an age, so treat
  // as normal poll latency. Keeps null reserved for non-FAA tasks only, so the
  // tally still sums to byClass.finishedAwaitingAck.
  if (!Number.isFinite(raisedAtMs) || raisedAtMs > deps.now) return 'awaiting_poll';

  const ageMs = deps.now - raisedAtMs;
  const staleThresholdMs = deps.staleThresholdMs ?? DEFAULT_STALE_COMPLETION_READY_THRESHOLD_MS;
  if (ageMs < staleThresholdMs) return 'awaiting_poll';

  const policy = classifyCompletionReadyClosePolicy(task, { ageMs, ttlMs: deps.ttlMs });
  if (policy.canAutoClose) return 'ack_sweep_backlog';
  return policy.manualActionRequiredReason === 'delivery_authorization_required'
    ? 'manual_review_gate'
    : 'auto_close_disabled';
}

/** A zeroed tally over every FAA root cause. */
export function emptyFaaRootCauseTally(): Record<FaaRootCause, number> {
  return {
    awaiting_poll: 0,
    ack_sweep_backlog: 0,
    manual_review_gate: 0,
    auto_close_disabled: 0,
  };
}

/**
 * The single dominant cause in a tally (highest count), or `null` when the
 * tally is empty (all zero). Ties are broken by {@link FAA_ROOT_CAUSES} order,
 * which lists the actionable stall causes (`ack_sweep_backlog` first) ahead of
 * the by-design (`manual_review_gate`) and healthy-baseline (`awaiting_poll`)
 * causes, so a tie never hides a real backlog behind a human gate or normal
 * poll latency.
 */
export function dominantFaaRootCause(
  tally: Record<FaaRootCause, number>,
): FaaRootCause | null {
  let dominant: FaaRootCause | null = null;
  let best = 0;
  for (const cause of FAA_ROOT_CAUSES) {
    if (tally[cause] > best) {
      best = tally[cause];
      dominant = cause;
    }
  }
  return dominant;
}
