import type { RalphIterationExitReason } from '../shared/contracts/ralph-iteration-log.js';
import type { RalphNeedsHumanReason } from '../shared/contracts/ralph.js';

/**
 * Terminal-loop relaunch policy (issue #1901 / WS2.3 of #1699).
 *
 * When a Ralph loop hits a terminal exit reason, nothing decides whether to
 * relaunch or escalate — a capped/stalled loop just stops, and a
 * budget-exhausted loop stops *silently* (it lands in `status: 'completed'`,
 * indistinguishable from a clean success). This pure classifier maps a
 * {@link RalphIterationExitReason} to one of three dispositions so the loop
 * service can act on the terminal exit:
 *
 *   - `relaunch` — capped or stalled with potentially-eligible remaining work.
 *     The loop service re-arms it, gated by the WS0.5 {@link RelaunchArbiter}
 *     (issue #1711) so concurrent actuators cannot double-launch and a post-run
 *     cooldown prevents thundering-herd relaunch.
 *   - `escalate` — budget exhausted (cost caps). Retrying can only burn more
 *     budget, so the loop is surfaced in an explicit needs-human state rather
 *     than relaunched.
 *   - `stop` — clean completion, user-driven stops, crashes, and everything the
 *     policy does not own. No automatic action; other subsystems (crash
 *     reconciliation, manual replace) own these paths.
 *
 * Pure and synchronous: no IO, no clock. The service layer owns actuation.
 */

export type TerminalRelaunchDisposition = 'relaunch' | 'escalate' | 'stop';

/**
 * The subset of `RalphNeedsHumanReason` this pure classifier can produce.
 * `relaunch_exhausted` is decided by the service layer (relaunch-count cap), not
 * by exit-reason classification, so it is not in this union.
 */
export type TerminalEscalationReason = 'budget_exhausted';

export interface TerminalRelaunchDecision {
  disposition: TerminalRelaunchDisposition;
  /** Present iff `disposition === 'escalate'`. */
  escalationReason?: TerminalEscalationReason;
}

/**
 * Capped/stalled exits with potentially-eligible remaining work. A relaunch is
 * still arbiter-gated: eligibility here only means "the exit reason itself does
 * not forbid a relaunch", not "relaunch unconditionally".
 */
const RELAUNCH_ELIGIBLE: ReadonlySet<RalphIterationExitReason> = new Set<RalphIterationExitReason>([
  'iteration_cap',
  'target_stalled',
  'all_targets_stalled',
]);

/**
 * Budget-exhaustion exits. Relaunching cannot help — the cap will just be hit
 * again — so these escalate to a visible needs-human state.
 */
const BUDGET_EXHAUSTED: ReadonlySet<RalphIterationExitReason> = new Set<RalphIterationExitReason>([
  'cost_cap',
  'iteration_cost_cap',
]);

/**
 * Classify a terminal exit reason into a relaunch/escalate/stop disposition.
 *
 * Everything not explicitly relaunch-eligible or budget-exhausted maps to
 * `stop` — including clean success (`predicate_satisfied`, `zero_diff_convergence`),
 * user-driven stops (`cancelled`, `paused`, `replaced_by_user`), and failure
 * modes owned elsewhere (`kookr_crash`, `session_dead`, `predicate_error`).
 * `continued` / `predicate_timeout` are non-terminal in practice; they map to
 * `stop` defensively.
 */
export function classifyTerminalExit(reason: RalphIterationExitReason): TerminalRelaunchDecision {
  if (BUDGET_EXHAUSTED.has(reason)) {
    return { disposition: 'escalate', escalationReason: 'budget_exhausted' };
  }
  if (RELAUNCH_ELIGIBLE.has(reason)) {
    return { disposition: 'relaunch' };
  }
  return { disposition: 'stop' };
}

/** Operator-facing one-line explanation for a needs-human escalation. */
export function escalationDetail(
  reason: RalphNeedsHumanReason,
  exitReason: RalphIterationExitReason,
): string {
  switch (reason) {
    case 'budget_exhausted':
      return exitReason === 'iteration_cost_cap'
        ? 'Loop hit the per-iteration cost cap repeatedly; review spend, then raise the cap and start a fresh loop or close the work.'
        : 'Loop reached its cumulative cost cap; review spend, then raise the cap and start a fresh loop or close the work.';
    case 'relaunch_exhausted':
      return `Loop was relaunched to its cap without reaching a clean stop (last exit: ${exitReason}); it is likely stuck — investigate, then start a fresh loop once unblocked.`;
    default:
      return 'Loop needs a human decision before it can continue.';
  }
}
