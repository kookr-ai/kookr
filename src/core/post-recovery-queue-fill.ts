/**
 * Post-recovery queue-fill kick (issue #2196).
 *
 * When capacity returns after an outage (free slots, empty queue, healthy
 * dispatch) and no scout/batch is already active for a product repo, spawn at
 * most one supply-aware starvation scout + arm/batch-kick path per repo per
 * UTC day. Pure decision logic — durable day keys and launches live in the
 * server service.
 *
 * Reuses the free-slot floor from pipeline-starvation empty-ideation
 * ({@link EMPTY_IDEATION_FREE_SLOTS_THRESHOLD}) so headroom gating stays
 * consistent with #2043 / queue-feeder.
 */

import { EMPTY_IDEATION_FREE_SLOTS_THRESHOLD } from './pipeline-starvation.js';

/** Same free-slot floor as empty-ideation / queue-feeder idle gate. */
export const POST_RECOVERY_MIN_FREE_SLOTS = EMPTY_IDEATION_FREE_SLOTS_THRESHOLD;

export type PostRecoveryKickSkipReason =
  | 'insufficient_free_slots'
  | 'queue_not_empty'
  | 'dispatch_unhealthy'
  | 'scout_or_batch_in_flight'
  | 'already_kicked_utc_day'
  | 'no_repo';

export type PostRecoveryKickDecision =
  | { kick: true; utcDay: string }
  | { kick: false; reason: PostRecoveryKickSkipReason; utcDay: string };

export interface PostRecoveryKickInput {
  /** Free concurrency slots (prefer general-source free). */
  free: number;
  pendingQueueDepth: number;
  /**
   * True when schedule/task dispatch is healthy enough to launch product work
   * (not in a fleet-wide auth_expired / no-launchable-agent posture).
   */
  dispatchHealthy: boolean;
  /** True when a starvation scout OR parallel-issue-batch is already non-terminal for this repo. */
  scoutOrBatchInFlight: boolean;
  /**
   * UTC day key (YYYY-MM-DD) of the last successful post-recovery kick for
   * this repo, or null if never.
   */
  lastKickUtcDay: string | null;
  /** Repo full name (`owner/repo`). Empty → no kick. */
  repo: string;
  /** Floor for free slots (default {@link POST_RECOVERY_MIN_FREE_SLOTS}). */
  minFreeSlots?: number;
  /** Epoch ms — injected for deterministic tests. */
  nowMs: number;
}

/** UTC calendar day key `YYYY-MM-DD` for idempotency (one kick per repo per day). */
export function utcDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Decide whether a post-recovery scout+batch kick may fire for one repo.
 *
 * Guards (first match):
 *  1. missing repo
 *  2. free < N
 *  3. pendingQueueDepth > 0
 *  4. dispatch unhealthy (auth_expired class)
 *  5. scout or batch already active/queued
 *  6. already kicked this UTC day
 *  7. otherwise → kick
 */
export function decidePostRecoveryQueueFill(input: PostRecoveryKickInput): PostRecoveryKickDecision {
  const utcDay = utcDayKey(input.nowMs);
  const repo = (input.repo ?? '').trim();
  if (!repo) {
    return { kick: false, reason: 'no_repo', utcDay };
  }
  const minFree = input.minFreeSlots ?? POST_RECOVERY_MIN_FREE_SLOTS;
  if (!Number.isFinite(input.free) || input.free < minFree) {
    return { kick: false, reason: 'insufficient_free_slots', utcDay };
  }
  if (!Number.isFinite(input.pendingQueueDepth) || input.pendingQueueDepth > 0) {
    return { kick: false, reason: 'queue_not_empty', utcDay };
  }
  if (!input.dispatchHealthy) {
    return { kick: false, reason: 'dispatch_unhealthy', utcDay };
  }
  if (input.scoutOrBatchInFlight) {
    return { kick: false, reason: 'scout_or_batch_in_flight', utcDay };
  }
  if (input.lastKickUtcDay === utcDay) {
    return { kick: false, reason: 'already_kicked_utc_day', utcDay };
  }
  return { kick: true, utcDay };
}

/**
 * Idempotency key for a post-recovery kick launch (one per repo per UTC day).
 * Distinct from the starvation anti-thrash scout key so a deliberate recovery
 * kick does not collide with in-window starvation thrash protection.
 */
export function postRecoveryKickIdempotencyKey(repo: string, utcDay: string): string {
  const slug = repo.trim().toLowerCase().replace(/[/.]/g, '-');
  return `post-recovery-queue-fill:${slug}:${utcDay}`;
}

/** Durable state schema for per-repo post-recovery kick bookkeeping. */
export const POST_RECOVERY_KICK_STATE_SCHEMA = 1 as const;

export interface PostRecoveryKickRepoState {
  schemaVersion: typeof POST_RECOVERY_KICK_STATE_SCHEMA;
  repo: string;
  /** Last UTC day (YYYY-MM-DD) a recovery kick successfully spawned a scout. */
  lastKickUtcDay?: string;
  lastKickAt?: string;
  lastKickScoutTaskId?: string;
  updatedAt: string;
}
