/**
 * Phase-ledger eligibility for self-advancing phased-decomposition chains
 * (umbrella #2711, RFC `docs/rfc/rfc-self-advancing-phased-chains.md`, Phase 1 / D1).
 *
 * A dependent-phase chain decomposes large work into an ordered list of phases,
 * each landing as its own PR, each phase's prerequisite being that the
 * **previous phase merged to the base branch**. The historical failure was that
 * nothing re-evaluated the chain after a phase PR merged, so it deadlocked at
 * the first merge boundary (reproduced on `jeanibarz/lucy#3272`).
 *
 * This module is the **single** place that decides "what is the next workable
 * phase" — {@link nextEligiblePhase}. It is pure and synchronous: the only
 * dependency is an injected {@link PhaseMergeProbe} that reports whether a
 * phase's *recorded PR number* is merge-reachable against a freshly-fetched
 * base. The caller owns the `git fetch` + reachability I/O (see
 * `worktree-merge-status.ts` semantics) and passes the result in here.
 *
 * ## Satisfaction = PR-merge reachability, never file existence
 *
 * A phase counts as done **only** when it has a recorded PR number and that PR
 * is merge-reachable against the fresh base. Bare file existence is never
 * enough: a move-and-reexport facade leaves the moved file present after a
 * revert, and an unrelated PR can create the same path — either would falsely
 * satisfy a phase. Keying satisfaction to the recorded PR number also lets a
 * task that crashed between merge and ledger-tick recover by re-querying that
 * exact PR rather than guessing from an ambiguous path.
 *
 * ## Strict-sequential selection
 *
 * Selection stops at the **first** phase that is not merge-reachable, regardless
 * of any later phase's individual dependency. There is no DAG here: the chain is
 * a simple ordered list and each phase depends only on its predecessor.
 */

/** Lifecycle status a ledger records for a phase. Advisory — reachability wins. */
export type PhaseStatus = 'pending' | 'in-flight' | 'blocked' | 'merged';

/** A single phase in a dependent-phase chain, as recorded in the umbrella ledger. */
export interface Phase {
  /** Stable phase id, e.g. `"Phase 1"` or `"P1"`. */
  id: string;
  /**
   * The PR number recorded for this phase at branch-open, before merge. Absent
   * until the phase's branch/PR exists. Satisfaction is keyed to this number.
   */
  prNumber?: number;
  /**
   * Ledger-recorded status. **Advisory only** — {@link nextEligiblePhase} trusts
   * the injected merge probe for "is this phase merged", never this field. Used
   * only to enrich the human-readable reason.
   */
  status?: PhaseStatus;
}

/**
 * Reports whether a recorded PR number is merge-reachable against a
 * freshly-fetched base. Injected so the git/PR I/O stays at the call site and
 * this module remains pure and fully unit-testable. A previously-merged PR that
 * has since been reverted must report `false` (reachability, not a one-time
 * "was merged" flag), so a reverted dependency correctly re-blocks the chain.
 */
export type PhaseMergeProbe = (prNumber: number) => boolean;

/** Why {@link nextEligiblePhase} returned what it did. */
export type PhaseEligibilityOutcome =
  /** A phase is workable now: all predecessors are merge-reachable. */
  | 'eligible'
  /**
   * The chain is waiting on a dependency: the next non-merged phase already has
   * a recorded PR that is not merge-reachable (open, or merged-then-reverted).
   * This is distinct from "complete" — the chain has not finished.
   */
  | 'blocked'
  /** Every phase is merge-reachable: the chain is done. */
  | 'complete';

/** Result of {@link nextEligiblePhase}. */
export interface NextEligiblePhaseResult {
  outcome: PhaseEligibilityOutcome;
  /** The phase to work next when `outcome === 'eligible'`; otherwise `null`. */
  phase: Phase | null;
  /**
   * The phase the chain is waiting on when `outcome === 'blocked'` (the first
   * non-merged phase, which carries the unmerged PR); otherwise `null`.
   */
  blockedOn: Phase | null;
  /** Human-readable diagnostic for logging / tracing. */
  reason: string;
}

/** True when a phase's recorded PR is merge-reachable against the fresh base. */
function isPhaseMerged(phase: Phase, isMerged: PhaseMergeProbe): boolean {
  return phase.prNumber !== undefined && isMerged(phase.prNumber);
}

function describePr(phase: Phase): string {
  return phase.prNumber === undefined ? 'no recorded PR' : `PR #${phase.prNumber}`;
}

/**
 * Decide the next workable phase in a strict-sequential dependent-phase chain.
 *
 * Walks the phases in order and stops at the **first** one whose recorded PR is
 * not merge-reachable (per the injected {@link PhaseMergeProbe}):
 *
 *   - No phase stops the walk → every phase is merged → `complete`.
 *   - The stopping phase has **no recorded PR** → it has not been started and all
 *     predecessors are merged → `eligible` (work it).
 *   - The stopping phase **has a recorded PR** that is not merge-reachable → its
 *     PR is open (in-flight) or was reverted → `blocked` (the chain is waiting on
 *     that PR to merge, not finished).
 *
 * Recorded {@link PhaseStatus} is never trusted for the merged decision; it only
 * colours the returned `reason`.
 */
export function nextEligiblePhase(
  phases: readonly Phase[],
  isMerged: PhaseMergeProbe,
): NextEligiblePhaseResult {
  for (const phase of phases) {
    if (isPhaseMerged(phase, isMerged)) continue;

    // First non-merge-reachable phase. All predecessors are merge-reachable
    // (we only reached here by skipping merged phases), so this phase's
    // prerequisite is satisfied — the question is whether it is startable.
    if (phase.prNumber === undefined) {
      return {
        outcome: 'eligible',
        phase,
        blockedOn: null,
        reason: `phase ${phase.id} is next (predecessors merged, ${describePr(phase)})`,
      };
    }

    // The phase already has a recorded PR that is not merge-reachable: it is
    // in-flight (PR open, awaiting merge) or was merged then reverted. Either
    // way the chain is waiting on it — not complete.
    const statusHint = phase.status === 'blocked'
      ? 'recorded blocked'
      : phase.status === 'merged'
        ? 'recorded merged but not reachable (reverted?)'
        : 'in-flight';
    return {
      outcome: 'blocked',
      phase: null,
      blockedOn: phase,
      reason: `phase ${phase.id} is waiting on ${describePr(phase)} to merge (${statusHint})`,
    };
  }

  return {
    outcome: 'complete',
    phase: null,
    blockedOn: null,
    reason: phases.length === 0 ? 'no phases in chain' : 'all phases merged',
  };
}
