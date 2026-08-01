/**
 * RelaunchArbiter — single lease-gated admission gate for issue relaunches
 * (issue #1711 / WS0.5 of #1699).
 *
 * Five actuators can each relaunch work on the same GitHub issue (schedule
 * fire, crash recovery, Ralph terminal relaunch, manual re-dispatch, catch-up).
 * The launch {@link IdempotencyLedger} only dedups within 24h and keys on a
 * fresh branch suffix, so a multi-day pause produces duplicate PRs on restart.
 *
 * This module is the single mutual-exclusion + cooldown layer keyed by issue
 * claim identity (`repo` + `number`):
 *
 *   - At most one live holder per issue at a time.
 *   - After a holder dies or explicitly releases, a backoff window blocks
 *     every other actuator from re-acquiring (no thundering-herd relaunch).
 *   - Dead holders are reclaimed inline on the next `tryAcquire` (orphan
 *     reclaim), and the reclaim itself starts the backoff — so no lifecycle
 *     wiring is required for the cooldown to fire after a completed task.
 *
 * Fully synchronous: no await between check and set (same R4 discipline as
 * {@link IssueClaimRegistry}). In-memory only — a process restart clears
 * holds and cooldowns, which errs toward accepting work; the durable
 * issue-claim registry (when wired) still covers cross-restart live ownership.
 *
 * {@link launchTask} consults this as a hard admission gate for `claimIssue`
 * launches when the arbiter is injected: no claimIssue launch proceeds
 * without a held relaunch lease.
 */

import { claimKeyString, type ClaimKey } from '../core/issue-claim-types.js';

/** Default post-release / post-orphan-reclaim backoff (15 minutes). */
export const DEFAULT_RELAUNCH_BACKOFF_MS = 15 * 60 * 1000;

export interface RelaunchLease {
  key: ClaimKey;
  holderId: string;
  acquiredAt: string;
}

export interface RelaunchArbiterOptions {
  /** Cooldown after release or orphan reclaim. Default {@link DEFAULT_RELAUNCH_BACKOFF_MS}. */
  backoffMs?: number;
  /** Injectable clock (ms since epoch). */
  now?: () => number;
  /**
   * Optional liveness probe for the current holder. When provided and returns
   * `false`, the hold is treated as orphaned: cleared and a backoff window
   * starts. When omitted, every non-released hold is treated as live.
   */
  isHolderLive?: (holderId: string) => boolean;
}

export type RelaunchAcquireResult =
  | { ok: true; lease: RelaunchLease; reentrant: boolean }
  | { ok: false; reason: 'held'; lease: RelaunchLease }
  | { ok: false; reason: 'backoff'; retryAfterMs: number; cooldownUntil: string };

export type RelaunchEvaluateResult =
  | { admit: true }
  | { admit: false; reason: 'held'; lease: RelaunchLease }
  | { admit: false; reason: 'backoff'; retryAfterMs: number; cooldownUntil: string };

interface HolderRecord {
  holderId: string;
  acquiredAtMs: number;
}

/**
 * Single-process arbiter for issue-keyed relaunch admission.
 *
 * @see issue #1711
 */
export class RelaunchArbiter {
  private readonly holders = new Map<string, HolderRecord>();
  /** key → epoch ms until which acquires are denied. */
  private readonly cooldowns = new Map<string, number>();
  private readonly backoffMs: number;
  private readonly now: () => number;
  private readonly isHolderLive: ((holderId: string) => boolean) | undefined;

  constructor(opts: RelaunchArbiterOptions = {}) {
    this.backoffMs = opts.backoffMs ?? DEFAULT_RELAUNCH_BACKOFF_MS;
    this.now = opts.now ?? (() => Date.now());
    this.isHolderLive = opts.isHolderLive;
  }

  /**
   * Pure (aside from orphan-reclaim side effects on dead holders) admission
   * check. Used by launch-service as a pre-createTask gate so a denied launch
   * leaves no task record.
   *
   * Orphan reclaim of a dead holder mutates state (clears the hold and starts
   * backoff) so a subsequent `tryAcquire` and this evaluate agree — both deny
   * with `backoff` until the window elapses.
   */
  evaluate(key: ClaimKey): RelaunchEvaluateResult {
    const k = claimKeyString(key);
    this.reclaimIfDead(k, key);
    const held = this.holders.get(k);
    if (held) {
      return {
        admit: false,
        reason: 'held',
        lease: this.toLease(key, held),
      };
    }
    const cooldown = this.liveCooldown(k);
    if (cooldown !== undefined) {
      return {
        admit: false,
        reason: 'backoff',
        retryAfterMs: cooldown.retryAfterMs,
        cooldownUntil: cooldown.cooldownUntil,
      };
    }
    return { admit: true };
  }

  /**
   * Acquire the relaunch lease for `key` under `holderId`. Fully synchronous
   * CAS: check + set with no await. Re-entrant for the same holder.
   */
  tryAcquire(key: ClaimKey, holderId: string): RelaunchAcquireResult {
    const k = claimKeyString(key);
    this.reclaimIfDead(k, key);

    const existing = this.holders.get(k);
    if (existing) {
      if (existing.holderId === holderId) {
        return { ok: true, lease: this.toLease(key, existing), reentrant: true };
      }
      return { ok: false, reason: 'held', lease: this.toLease(key, existing) };
    }

    const cooldown = this.liveCooldown(k);
    if (cooldown !== undefined) {
      return {
        ok: false,
        reason: 'backoff',
        retryAfterMs: cooldown.retryAfterMs,
        cooldownUntil: cooldown.cooldownUntil,
      };
    }

    const acquiredAtMs = this.now();
    const record: HolderRecord = { holderId, acquiredAtMs };
    this.holders.set(k, record);
    this.cooldowns.delete(k);
    return { ok: true, lease: this.toLease(key, record), reentrant: false };
  }

  /**
   * Release the lease held by `holderId` and start the backoff window.
   * Returns false when the key is free or held by someone else (no-op).
   */
  release(key: ClaimKey, holderId: string): boolean {
    const k = claimKeyString(key);
    const existing = this.holders.get(k);
    if (!existing || existing.holderId !== holderId) return false;
    this.holders.delete(k);
    this.startCooldown(k);
    return true;
  }

  /** True when a live (non-reclaimed) hold exists for `key`. */
  isHeld(key: ClaimKey): boolean {
    const k = claimKeyString(key);
    this.reclaimIfDead(k, key);
    return this.holders.has(k);
  }

  /** Current lease, or null when free / in cooldown only. */
  getLease(key: ClaimKey): RelaunchLease | null {
    const k = claimKeyString(key);
    this.reclaimIfDead(k, key);
    const held = this.holders.get(k);
    return held ? this.toLease(key, held) : null;
  }

  private reclaimIfDead(k: string, key: ClaimKey): void {
    const existing = this.holders.get(k);
    if (!existing) return;
    if (this.isHolderLive === undefined) return;
    if (this.isHolderLive(existing.holderId)) return;
    // Orphan reclaim: dead holder drops the lease and starts backoff so two
    // actuators cannot immediately race a completed issue into duplicate PRs.
    this.holders.delete(k);
    this.startCooldown(k);
    void key; // key kept for call-site clarity; map key is already `k`
  }

  private startCooldown(k: string): void {
    if (this.backoffMs <= 0) {
      this.cooldowns.delete(k);
      return;
    }
    this.cooldowns.set(k, this.now() + this.backoffMs);
  }

  private liveCooldown(
    k: string,
  ): { retryAfterMs: number; cooldownUntil: string } | undefined {
    const until = this.cooldowns.get(k);
    if (until === undefined) return undefined;
    const now = this.now();
    if (now >= until) {
      this.cooldowns.delete(k);
      return undefined;
    }
    return {
      retryAfterMs: until - now,
      cooldownUntil: new Date(until).toISOString(),
    };
  }

  private toLease(key: ClaimKey, record: HolderRecord): RelaunchLease {
    return {
      key: { repo: key.repo, number: key.number },
      holderId: record.holderId,
      acquiredAt: new Date(record.acquiredAtMs).toISOString(),
    };
  }
}
