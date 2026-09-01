/**
 * Post-resume refill decision (issue #2797).
 *
 * When orchestration transitions from paused → live (a documented operator
 * quota pause ends, or SAFE MODE is disengaged), the fleet can be left with
 * free task slots and an empty pending queue. The harness resumes safely but
 * leaves capacity unused, without saying whether that idle state is
 * intentional (no eligible work) or a refill failure (eligible work blocked by
 * disk / provider / claim state).
 *
 * This pure decision fires **once per paused→live transition** and consumes
 * only existing vetted, ownerless leaves — it never invents backlog to fill
 * slots. It classifies the post-resume posture into first-class outcomes so a
 * capacity report can separate pause-expected silence from post-resume idle
 * capacity:
 *
 *  - `launch`           — eligible leaves + free capacity; launch up to the
 *                         current spawn budget.
 *  - `intentional_idle` — no eligible leaves exist; idle by design.
 *  - `refill_blocked`   — eligible leaves exist but a substrate gate (disk,
 *                         provider, or claim state) prevents launching.
 *  - `skip`             — the transition does not warrant a refill pass
 *                         (not resumed, already refilled this transition, a
 *                         pause/SAFE-MODE/drain gate forbids launching, no
 *                         idle capacity, or the queue already has work).
 *
 * Durable per-transition idempotency keys and the launches live in the server
 * service; this module is pure so the guard ordering is exhaustively testable.
 *
 * Reuses the free-slot floor from pipeline-starvation empty-ideation
 * ({@link EMPTY_IDEATION_FREE_SLOTS_THRESHOLD}) so headroom gating stays
 * consistent with #2043 / queue-feeder / post-recovery-queue-fill.
 */

import { EMPTY_IDEATION_FREE_SLOTS_THRESHOLD } from './pipeline-starvation.js';

/** Same free-slot floor as empty-ideation / queue-feeder / post-recovery idle gate. */
export const POST_RESUME_REFILL_MIN_FREE_SLOTS = EMPTY_IDEATION_FREE_SLOTS_THRESHOLD;

/**
 * Substrate gates that block launching *even though* eligible vetted leaves
 * exist. These are the "eligible but cannot launch" reasons from the issue's
 * acceptance criteria; each maps to a distinct `refill_blocked` result reason.
 */
export type RefillBlockedReason =
  | 'disk_floor'
  | 'provider_admission'
  | 'claim_contended';

/**
 * Reasons the transition did not warrant a refill pass at all. Distinct from
 * {@link RefillBlockedReason}: a skip means "no refill situation here", not
 * "wanted to refill but was blocked".
 */
export type PostResumeRefillSkipReason =
  | 'not_resumed'
  | 'already_refilled_transition'
  | 'safe_mode'
  | 'still_paused'
  | 'operator_drain'
  | 'insufficient_free_slots'
  | 'queue_not_empty';

export type PostResumeRefillDecision =
  | { action: 'launch'; count: number }
  | { action: 'intentional_idle' }
  | { action: 'refill_blocked'; reason: RefillBlockedReason }
  | { action: 'skip'; reason: PostResumeRefillSkipReason };

export interface PostResumeRefillInput {
  /** True on the paused→live edge that just occurred (resume actually took effect). */
  resumed: boolean;
  /**
   * Stable identifier for this paused→live transition (the closed pause-record
   * id, or a resume-timestamp fallback). Empty/absent → treated as not a real
   * transition edge.
   */
  transitionId: string | null;
  /**
   * Transition id of the last transition a refill pass already ran for. When it
   * equals {@link transitionId}, the pass has already fired for this transition
   * (at most one refill pass per transition).
   */
  lastRefilledTransitionId: string | null;
  /** SAFE MODE engaged — never launch. */
  safeModeEngaged: boolean;
  /** Orchestration still paused (record active) — never launch. */
  paused: boolean;
  /** Operator drain: false when draining/not accepting new launches. */
  accepting: boolean;
  /** Free general-source slots (prefer `freeForGeneralSources ?? free`). */
  freeGeneralSlots: number;
  /** Launchable pending queue depth; > 0 means work is already queued. */
  pendingQueueDepth: number;
  /** Count of eligible vetted, ownerless leaves available to launch. */
  eligibleLeafCount: number;
  /** Current per-source spawn budget (max leaves this pass may launch). */
  spawnBudget: number;
  /**
   * A substrate gate blocking launches (disk floor, provider admission, claim
   * contention), or null when the substrate is clear.
   */
  substrateBlock: RefillBlockedReason | null;
  /** Free-slot floor (default {@link POST_RESUME_REFILL_MIN_FREE_SLOTS}). */
  minFreeSlots?: number;
}

function nonNegativeInt(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Decide whether the paused→live transition should launch a bounded refill
 * pass, and if not, why.
 *
 * Guards (first match wins):
 *  1. resume did not take effect / no transition id  → skip `not_resumed`
 *  2. already refilled this exact transition          → skip `already_refilled_transition`
 *  3. SAFE MODE engaged                               → skip `safe_mode`
 *  4. orchestration still paused                      → skip `still_paused`
 *  5. operator drain (not accepting)                  → skip `operator_drain`
 *  6. free general slots < floor                      → skip `insufficient_free_slots`
 *  7. pending queue already has work                  → skip `queue_not_empty`
 *  8. no eligible leaves                              → `intentional_idle`
 *  9. substrate gate blocks launching                 → `refill_blocked`
 * 10. otherwise → `launch` min(eligibleLeaves, spawnBudget, freeGeneralSlots)
 *
 * Ordering rationale: the safety gates (2–5) are checked before capacity so a
 * paused/draining fleet can never launch; capacity/queue (6–7) gate whether
 * there is genuine post-resume idle capacity to fill at all; only then do we
 * separate `intentional_idle` (nothing eligible) from `refill_blocked`
 * (eligible but a substrate gate is in the way). The pass never invents work —
 * it can only launch as many leaves as already exist.
 */
export function decidePostResumeRefill(input: PostResumeRefillInput): PostResumeRefillDecision {
  const transitionId = (input.transitionId ?? '').trim();
  if (!input.resumed || !transitionId) {
    return { action: 'skip', reason: 'not_resumed' };
  }
  if (input.lastRefilledTransitionId != null && input.lastRefilledTransitionId === transitionId) {
    return { action: 'skip', reason: 'already_refilled_transition' };
  }
  if (input.safeModeEngaged) {
    return { action: 'skip', reason: 'safe_mode' };
  }
  if (input.paused) {
    return { action: 'skip', reason: 'still_paused' };
  }
  if (!input.accepting) {
    return { action: 'skip', reason: 'operator_drain' };
  }
  const minFree = input.minFreeSlots ?? POST_RESUME_REFILL_MIN_FREE_SLOTS;
  if (!Number.isFinite(input.freeGeneralSlots) || input.freeGeneralSlots < minFree) {
    return { action: 'skip', reason: 'insufficient_free_slots' };
  }
  if (!Number.isFinite(input.pendingQueueDepth) || input.pendingQueueDepth > 0) {
    return { action: 'skip', reason: 'queue_not_empty' };
  }
  if (nonNegativeInt(input.eligibleLeafCount) <= 0) {
    return { action: 'intentional_idle' };
  }
  if (input.substrateBlock != null) {
    return { action: 'refill_blocked', reason: input.substrateBlock };
  }
  const count = Math.min(
    nonNegativeInt(input.eligibleLeafCount),
    nonNegativeInt(input.spawnBudget),
    Math.floor(input.freeGeneralSlots),
  );
  if (count <= 0) {
    // Eligible leaves exist and the substrate is clear, but the spawn budget is
    // exhausted this window — a launch cannot proceed, so it is blocked rather
    // than idle. Budget exhaustion is a claim/spawn-rate constraint.
    return { action: 'refill_blocked', reason: 'claim_contended' };
  }
  return { action: 'launch', count };
}

/**
 * Idempotency key for a single refill leaf launch within one transition.
 * `leafKey` is a stable per-leaf token (e.g. the issue number/URL slug) so two
 * leaves in the same transition get distinct keys, while a replayed resume tick
 * for the same transition+leaf collapses onto the same launch.
 */
export function postResumeRefillIdempotencyKey(transitionId: string, leafKey: string): string {
  const t = transitionId.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const l = leafKey.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `post-resume-refill:${t}:${l}`;
}

/** Durable state schema version for per-fleet post-resume refill bookkeeping. */
export const POST_RESUME_REFILL_STATE_SCHEMA = 1 as const;

export interface PostResumeRefillState {
  schemaVersion: typeof POST_RESUME_REFILL_STATE_SCHEMA;
  /** Transition id the last refill pass ran for (idempotency latch). */
  lastRefilledTransitionId?: string;
  lastRefilledAt?: string;
  updatedAt: string;
}
