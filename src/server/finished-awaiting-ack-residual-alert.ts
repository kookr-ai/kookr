/**
 * Discord/operator page when finishedAwaitingAck residual stays high after
 * the TTL reclaim window (issue #2077).
 *
 * The finishedAwaitingAck TTL reclaim (#1884) and meta auto-complete (#2070)
 * already force-complete aged completion_ready tasks on the liveness tick.
 * When residual occupancy remains high afterward (open-PR fail-safe holds,
 * unfetched PR refs, non-allowlisted implementers, fresh completion_ready
 * signals), unattended operators offline on Discord get no page — only
 * `/api/health` capacity.byClass.finishedAwaitingAck shows the waste.
 *
 * This module is **page-only**: it never terminates or force-completes tasks.
 * It evaluates residual count after each reclaim and:
 *
 * - fires an operational alert (key `faa:residual`) once residual has stayed
 *   ≥ N without decreasing for M minutes;
 * - re-pages at most once per cooldown while residual remains high;
 * - emits a matching `recovered` clear when finishedAwaitingAck returns to 0.
 *
 * Wire via detectorBroadcast (index.ts) so the operational-alert bridge
 * spools operator signals to Discord (issue #1716).
 */

import type { ServerMessage } from '../shared/contracts/messages.js';
import { OPERATIONAL_ALERT_AGENT_ID } from './operational-alert-rules.js';

/** Operational-alert / operator-signal key (issue #2077, offline recovery card). */
export const FAA_RESIDUAL_ALERT_KEY = 'faa:residual' as const;

export const FAA_RESIDUAL_METRIC = 'finished_awaiting_ack_residual' as const;

/**
 * Minimum residual finishedAwaitingAck count before paging. Issue #2077
 * suggests bound ≥ 3 so legitimate PR-hold fail-safes do not false-page.
 */
export const DEFAULT_FAA_RESIDUAL_COUNT_BOUND = 3;

/**
 * How long residual must stay ≥ bound without decreasing before the first
 * page. Default 30m sits above the FAA TTL (15m) and meta auto-complete TTL
 * (12m) so reclaim has had a full window to act before we page noise from
 * legitimate PR-hold fail-safes.
 */
export const DEFAULT_FAA_RESIDUAL_STALE_MS = 30 * 60_000;

/** Re-page cooldown while residual remains high (default 1h). */
export const DEFAULT_FAA_RESIDUAL_COOLDOWN_MS = 60 * 60_000;

export interface FinishedAwaitingAckResidualAlerterDeps {
  /**
   * Broadcast path — prefer `detectorBroadcast` so fire/clear edges spool to
   * the operator-signal outbox (Discord). Must not throw.
   */
  broadcast: (msg: ServerMessage) => void;
  /** Live residual count bound. Falls back to {@link DEFAULT_FAA_RESIDUAL_COUNT_BOUND}. */
  getCountBound?: () => number;
  /** Live stale window (ms). Falls back to {@link DEFAULT_FAA_RESIDUAL_STALE_MS}. */
  getStaleMs?: () => number;
  /** Live re-page cooldown (ms). Falls back to {@link DEFAULT_FAA_RESIDUAL_COOLDOWN_MS}. */
  getCooldownMs?: () => number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface EvaluateFaaResidualInput {
  /** Current finishedAwaitingAck count after this tick's reclaim. */
  residualCount: number;
  /** Tasks reclaimed / auto-completed this tick (informational; in details only). */
  reclaimedCount?: number;
  /**
   * Age of the oldest residual finishedAwaitingAck task (ms), when known —
   * surfaces in the page body so Discord shows how chronic the hold is.
   */
  oldestAgeMs?: number | null;
}

export interface FinishedAwaitingAckResidualAlerterStats {
  /** True while an unrecovered residual episode is open. */
  firing: boolean;
  /** Residual count last observed. */
  lastCount: number;
  /** When residual first hit the bound without a later decrease, or null. */
  residualHighSinceMs: number | null;
  /** When the last fire/re-page was emitted, or null. */
  lastAlertedAtMs: number | null;
}

/**
 * Edge-triggered residual page after finishedAwaitingAck TTL reclaim
 * (issue #2077). Holds episode state in process memory — a restart resets
 * the wait window (same trade-off as hung residual / schedule dead-man).
 */
export class FinishedAwaitingAckResidualAlerter {
  private firing = false;
  private residualHighSinceMs: number | null = null;
  private lastCount = 0;
  private lastAlertedAtMs: number | null = null;
  private readonly deps: FinishedAwaitingAckResidualAlerterDeps;

  constructor(deps: FinishedAwaitingAckResidualAlerterDeps) {
    this.deps = deps;
  }

  /**
   * Evaluate residual after reclaim. Page-only — never mutates tasks.
   * Safe to call every liveness tick.
   */
  evaluate(input: EvaluateFaaResidualInput): void {
    const nowMs = this.deps.now?.() ?? Date.now();
    const bound = this.resolveCountBound();
    const residual = Math.max(0, Math.floor(input.residualCount));
    const reclaimed = Math.max(0, Math.floor(input.reclaimedCount ?? 0));
    const oldestAgeMs =
      typeof input.oldestAgeMs === 'number' && Number.isFinite(input.oldestAgeMs)
        ? Math.max(0, Math.floor(input.oldestAgeMs))
        : null;

    if (residual === 0) {
      if (this.firing) {
        this.emit(buildFaaResidualRecoveryAlert());
      }
      this.firing = false;
      this.residualHighSinceMs = null;
      this.lastCount = 0;
      // lastAlertedAtMs is retained for diagnostics only. After clear, a new
      // episode must wait a full stale window before paging again (!firing
      // short-circuits the cooldown gate on the next fire).
      return;
    }

    if (residual < bound) {
      // Below page threshold but not zero: do not fire; do not clear (clear is
      // only at 0). Reset the high-since clock so a later climb to ≥bound must
      // wait a full stale window again.
      this.residualHighSinceMs = null;
      this.lastCount = residual;
      return;
    }

    // residual ≥ bound
    if (
      this.residualHighSinceMs === null
      || residual < this.lastCount
    ) {
      // Fresh high period, or reclaim/other action reduced residual — restart
      // the "did not reduce for M minutes" clock.
      this.residualHighSinceMs = nowMs;
    }
    this.lastCount = residual;

    const staleMs = this.resolveStaleMs();
    if (nowMs - this.residualHighSinceMs < staleMs) {
      return;
    }

    const cooldownMs = this.resolveCooldownMs();
    const canPage =
      !this.firing
      || this.lastAlertedAtMs === null
      || nowMs - this.lastAlertedAtMs >= cooldownMs;
    if (!canPage) return;

    this.firing = true;
    this.lastAlertedAtMs = nowMs;
    this.emit(
      buildFaaResidualAlert({
        residualCount: residual,
        countBound: bound,
        staleMs,
        reclaimedCount: reclaimed,
        oldestAgeMs,
      }),
    );
  }

  /** Observable episode state for tests / diagnostics. */
  stats(): FinishedAwaitingAckResidualAlerterStats {
    return {
      firing: this.firing,
      lastCount: this.lastCount,
      residualHighSinceMs: this.residualHighSinceMs,
      lastAlertedAtMs: this.lastAlertedAtMs,
    };
  }

  private emit(alert: Extract<ServerMessage, { type: 'alert' }>): void {
    try {
      this.deps.broadcast(alert);
    } catch (err) {
      console.warn(
        '[faa-residual] broadcast threw (ignored):',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private resolveCountBound(): number {
    const value = this.deps.getCountBound?.();
    if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
      return Math.floor(value);
    }
    return DEFAULT_FAA_RESIDUAL_COUNT_BOUND;
  }

  private resolveStaleMs(): number {
    const value = this.deps.getStaleMs?.();
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
    return DEFAULT_FAA_RESIDUAL_STALE_MS;
  }

  private resolveCooldownMs(): number {
    const value = this.deps.getCooldownMs?.();
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
    return DEFAULT_FAA_RESIDUAL_COOLDOWN_MS;
  }
}

export function buildFaaResidualAlert(args: {
  residualCount: number;
  countBound: number;
  staleMs: number;
  reclaimedCount: number;
  oldestAgeMs?: number | null;
}): Extract<ServerMessage, { type: 'alert' }> {
  const staleMin = Math.round(args.staleMs / 60_000);
  const oldestAgePart =
    typeof args.oldestAgeMs === 'number'
      ? ` oldestAgeMs=${args.oldestAgeMs} (~${Math.round(args.oldestAgeMs / 60_000)}m);`
      : '';
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary:
      `finishedAwaitingAck residual high: ${args.residualCount} task(s) still awaiting ack after TTL reclaim window`,
    details:
      `Issue #2077: finishedAwaitingAck residual stayed ≥ ${args.countBound} for ≥ ${staleMin}m `
      + `without decreasing after the finishedAwaitingAck TTL reclaim (#1884/#2070). `
      + `Current residual=${args.residualCount};${oldestAgePart} reclaimed this tick=${args.reclaimedCount}. `
      + 'Page only — no extra force-completes. Free slots manually (ack/complete/cancel dead FAA tasks) '
      + 'or inspect PR-hold fail-safes (open/unknown PR refs). '
      + 'Health: GET /api/health → capacity.byClass.finishedAwaitingAck / finishedAwaitingAckTtlReclaim / oldestFinishedAwaitingAckAgeMs.',
    severity: 'warning',
    operationalAlert: {
      key: FAA_RESIDUAL_ALERT_KEY,
      metric: FAA_RESIDUAL_METRIC,
      state: 'fired',
    },
  };
}

export function buildFaaResidualRecoveryAlert(): Extract<ServerMessage, { type: 'alert' }> {
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: 'Recovered: finishedAwaitingAck residual cleared',
    details:
      'finishedAwaitingAck count returned to 0 after a residual-high episode. '
      + 'Capacity slots held by completion_ready tasks are free again.',
    severity: 'info',
    operationalAlert: {
      key: FAA_RESIDUAL_ALERT_KEY,
      metric: FAA_RESIDUAL_METRIC,
      state: 'recovered',
    },
  };
}
