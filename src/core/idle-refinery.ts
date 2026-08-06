/**
 * Idle-slot idea refinery — spawn decision core (issue #2144).
 *
 * When the harness has free concurrency slots AND an empty pending queue, it
 * has no supply of vetted work to consume. Meanwhile human-sanctioned umbrella
 * issues sit undecomposed. This module decides — as a pure function, with no
 * I/O — whether the current capacity posture warrants spawning one bounded
 * umbrella-decomposition task that turns an approved umbrella into sized leaf
 * issues (which then flow through the normal vetting path, never auto-executed).
 *
 * The scarce resource is vetted supply DEPTH, not scout cadence (#2073/#2074
 * already fixed *when* the scout runs). This raises *what deep, human-sanctioned
 * work exists to run*.
 *
 * Separation of concerns:
 *  - This function owns the trigger condition only (idle + empty + single-flight
 *    + cooldown). It never picks the umbrella, files issues, or does judgment —
 *    that is the umbrella-decompose playbook's job, run by the spawned agent.
 *  - The runner ({@link ../server/idle-refinery-runner}) owns the timer, the
 *    launch, and the durable last-spawn bookkeeping.
 *
 * Relationship to the queue-feeder ({@link ./umbrella-decomposer}): that older
 * mechanism (issues #1845/#2044/#2069) is a CLI-invoked, pure-decision path that
 * shreds a HARD-CODED set of product-metric umbrellas from curated leaf plans and
 * ranks harness/orchestration umbrellas LAST (rankScore 0). It structurally never
 * touches maintainer-sanctioned harness umbrellas like #1549/#1699/#1545 — which
 * is exactly the "0 vetted stalled work despite open umbrellas" gap #2144 names.
 * This refinery is the complementary path: a live server timer that spawns an
 * agent to author fresh leaves from ANY open, human-sanctioned umbrella, curated
 * plan or not. The two are deliberately distinct, not duplicates.
 */

/** Why a tick did (or did not) spawn a refinery task. `'spawn'` is the go verdict. */
export type IdleRefineryReason =
  | 'spawn'
  | 'disabled'
  | 'queue_not_empty'
  | 'insufficient_free_slots'
  | 'refinery_in_flight'
  | 'cooldown';

export interface IdleRefineryLedgerView {
  /** Free concurrency slots right now (`CapacityLedger.free`). */
  free: number;
  /** Depth of the pending (queued, not-yet-launched) task queue. */
  pendingQueueDepth: number;
}

export interface IdleRefineryDecisionInput {
  /** Feature flag. When false the refinery never fires (dark-launch default). */
  enabled: boolean;
  /** Live capacity posture. */
  ledger: IdleRefineryLedgerView;
  /** Config threshold `N`: minimum free slots required to fire (issue #2144). */
  minFreeSlots: number;
  /**
   * Count of refinery tasks currently non-terminal (launching/pending/running).
   * A positive count means one is already in flight → single-flight guard.
   */
  activeRefineryCount: number;
  /** Epoch-ms of the last successful refinery spawn, or null if never. */
  lastSpawnAt: number | null;
  /** Minimum gap between two refinery spawns, in ms. */
  cooldownMs: number;
  /** Current time (epoch ms) — injected for determinism. */
  now: number;
}

export interface IdleRefineryDecision {
  spawn: boolean;
  reason: IdleRefineryReason;
}

/**
 * Decide whether to spawn one umbrella-decomposition task this tick.
 *
 * Guards are evaluated in a deliberate order so the returned `reason` names the
 * FIRST blocking condition (cheapest / most fundamental first), which keeps the
 * operator-facing log unambiguous:
 *
 *  1. `disabled`               — feature flag off.
 *  2. `queue_not_empty`        — there is already vetted work queued; no need to refine.
 *  3. `insufficient_free_slots`— headroom below the configured `N`.
 *  4. `refinery_in_flight`     — a refinery task is already working (single-flight).
 *  5. `cooldown`               — fired too recently.
 *  6. otherwise                — `spawn`.
 */
export function decideIdleRefinerySpawn(input: IdleRefineryDecisionInput): IdleRefineryDecision {
  if (!input.enabled) return { spawn: false, reason: 'disabled' };
  if (input.ledger.pendingQueueDepth > 0) return { spawn: false, reason: 'queue_not_empty' };
  if (input.ledger.free < input.minFreeSlots) {
    return { spawn: false, reason: 'insufficient_free_slots' };
  }
  if (input.activeRefineryCount > 0) return { spawn: false, reason: 'refinery_in_flight' };
  if (
    input.lastSpawnAt !== null
    && input.now - input.lastSpawnAt < input.cooldownMs
  ) {
    return { spawn: false, reason: 'cooldown' };
  }
  return { spawn: true, reason: 'spawn' };
}
