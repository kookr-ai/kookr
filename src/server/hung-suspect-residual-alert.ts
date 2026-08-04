/**
 * Discord/operator page when hungSuspect residual stays high after the TTL
 * reclaim window (issue #1993).
 *
 * The hungSuspect TTL reclaim (#1935) already terminates aged silent tasks on
 * the liveness tick. When residual occupancy remains high afterward (reclaim
 * could not free enough slots — human-gated exemptions, false negatives, or
 * fresh hangs), unattended operators offline on Discord get no page.
 *
 * This module is **page-only**: it never terminates extra tasks. It evaluates
 * residual count after each reclaim and:
 *
 * - fires an operational alert (key `hung:residual`) once residual has stayed
 *   ≥ N without decreasing for M minutes;
 * - re-pages at most once per cooldown while residual remains high;
 * - emits a matching `recovered` clear when hungSuspect returns to 0.
 *
 * Wire via detectorBroadcast (index.ts) so the operational-alert bridge
 * spools operator signals to Discord (issue #1716).
 */

import type { ServerMessage } from '../shared/contracts/messages.js';
import { DEFAULT_HUNG_SUSPECT_CAPACITY_COUNT_BOUND } from '../core/capacity-ledger.js';
import { OPERATIONAL_ALERT_AGENT_ID } from './operational-alert-rules.js';

/** Operational-alert / operator-signal key (issue #1993, offline recovery card). */
export const HUNG_RESIDUAL_ALERT_KEY = 'hung:residual' as const;

export const HUNG_RESIDUAL_METRIC = 'hung_suspect_residual' as const;

/**
 * Minimum residual hungSuspect count before paging. Reuses the capacity-finding
 * absolute bound (default 3) so health findings and Discord pages agree.
 */
export const DEFAULT_HUNG_RESIDUAL_COUNT_BOUND = DEFAULT_HUNG_SUSPECT_CAPACITY_COUNT_BOUND;

/**
 * How long residual must stay ≥ bound without decreasing before the first
 * page. Default 30m sits just above the hungSuspect TTL (25m) so reclaim has
 * had a full window to act before we page noise from legitimate long tools.
 */
export const DEFAULT_HUNG_RESIDUAL_STALE_MS = 30 * 60_000;

/** Re-page cooldown while residual remains high (default 1h). */
export const DEFAULT_HUNG_RESIDUAL_COOLDOWN_MS = 60 * 60_000;

export interface HungSuspectResidualAlerterDeps {
  /**
   * Broadcast path — prefer `detectorBroadcast` so fire/clear edges spool to
   * the operator-signal outbox (Discord). Must not throw.
   */
  broadcast: (msg: ServerMessage) => void;
  /** Live residual count bound. Falls back to {@link DEFAULT_HUNG_RESIDUAL_COUNT_BOUND}. */
  getCountBound?: () => number;
  /** Live stale window (ms). Falls back to {@link DEFAULT_HUNG_RESIDUAL_STALE_MS}. */
  getStaleMs?: () => number;
  /** Live re-page cooldown (ms). Falls back to {@link DEFAULT_HUNG_RESIDUAL_COOLDOWN_MS}. */
  getCooldownMs?: () => number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface EvaluateHungResidualInput {
  /** Current hungSuspect count after this tick's reclaim. */
  residualCount: number;
  /** Tasks reclaimed this tick (informational; in details only). */
  reclaimedCount?: number;
}

export interface HungSuspectResidualAlerterStats {
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
 * Edge-triggered residual page after hungSuspect TTL reclaim (issue #1993).
 * Holds episode state in process memory — a restart resets the wait window
 * (same trade-off as schedule dead-man / lesson-spool alerts).
 */
export class HungSuspectResidualAlerter {
  private firing = false;
  private residualHighSinceMs: number | null = null;
  private lastCount = 0;
  private lastAlertedAtMs: number | null = null;
  private readonly deps: HungSuspectResidualAlerterDeps;

  constructor(deps: HungSuspectResidualAlerterDeps) {
    this.deps = deps;
  }

  /**
   * Evaluate residual after reclaim. Page-only — never mutates tasks.
   * Safe to call every liveness tick.
   */
  evaluate(input: EvaluateHungResidualInput): void {
    const nowMs = this.deps.now?.() ?? Date.now();
    const bound = this.resolveCountBound();
    const residual = Math.max(0, Math.floor(input.residualCount));
    const reclaimed = Math.max(0, Math.floor(input.reclaimedCount ?? 0));

    if (residual === 0) {
      if (this.firing) {
        this.emit(buildHungResidualRecoveryAlert());
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
      buildHungResidualAlert({
        residualCount: residual,
        countBound: bound,
        staleMs,
        reclaimedCount: reclaimed,
      }),
    );
  }

  /** Observable episode state for tests / diagnostics. */
  stats(): HungSuspectResidualAlerterStats {
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
        '[hung-suspect-residual] broadcast threw (ignored):',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private resolveCountBound(): number {
    const value = this.deps.getCountBound?.();
    if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
      return Math.floor(value);
    }
    return DEFAULT_HUNG_RESIDUAL_COUNT_BOUND;
  }

  private resolveStaleMs(): number {
    const value = this.deps.getStaleMs?.();
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
    return DEFAULT_HUNG_RESIDUAL_STALE_MS;
  }

  private resolveCooldownMs(): number {
    const value = this.deps.getCooldownMs?.();
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
    return DEFAULT_HUNG_RESIDUAL_COOLDOWN_MS;
  }
}

export function buildHungResidualAlert(args: {
  residualCount: number;
  countBound: number;
  staleMs: number;
  reclaimedCount: number;
}): Extract<ServerMessage, { type: 'alert' }> {
  const staleMin = Math.round(args.staleMs / 60_000);
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary:
      `hungSuspect residual high: ${args.residualCount} task(s) still hung after TTL reclaim window`,
    details:
      `Issue #1993: hungSuspect residual stayed ≥ ${args.countBound} for ≥ ${staleMin}m `
      + `without decreasing after the hungSuspect TTL reclaim (#1935). `
      + `Current residual=${args.residualCount}; reclaimed this tick=${args.reclaimedCount}. `
      + 'Page only — no extra terminations. Free slots manually (complete/cancel dead tasks) '
      + 'or inspect exemptions (needs_input, permission_blocked, open PR, provider pause). '
      + 'Health: GET /api/health → hungSuspectCapacityFinding / capacity.byClass.hungSuspect.',
    severity: 'warning',
    operationalAlert: {
      key: HUNG_RESIDUAL_ALERT_KEY,
      metric: HUNG_RESIDUAL_METRIC,
      state: 'fired',
    },
  };
}

export function buildHungResidualRecoveryAlert(): Extract<ServerMessage, { type: 'alert' }> {
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: 'Recovered: hungSuspect residual cleared',
    details:
      'hungSuspect count returned to 0 after a residual-high episode. '
      + 'Capacity slots held by hung-suspect tasks are free again.',
    severity: 'info',
    operationalAlert: {
      key: HUNG_RESIDUAL_ALERT_KEY,
      metric: HUNG_RESIDUAL_METRIC,
      state: 'recovered',
    },
  };
}

