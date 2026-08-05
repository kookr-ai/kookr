/**
 * Discord/operator page when provider_paused occupancy stays high (issue #2079).
 *
 * The hungSuspect TTL reclaim correctly skips provider_paused tasks (#1667
 * hold-for-resume), so long free-tier / expired-key pauses can hold
 * concurrency for hours with no page. This module is **page-only**: it never
 * terminates tasks (hard TTL reclaim is a separate sweep). It evaluates
 * occupancy after each liveness tick and:
 *
 * - fires an operational alert (key `provider:paused-occupancy`) once
 *   occupancy has stayed ≥ N without decreasing for M minutes;
 * - re-pages at most once per cooldown while occupancy remains high;
 * - emits a matching `recovered` clear when occupancy returns to 0.
 *
 * Wire via detectorBroadcast (index.ts) so the operational-alert bridge
 * spools operator signals to Discord (issue #1716).
 */

import type { ServerMessage } from '../shared/contracts/messages.js';
import { DEFAULT_PROVIDER_PAUSED_OCCUPANCY_COUNT_BOUND } from '../core/provider-paused-ttl.js';
import { OPERATIONAL_ALERT_AGENT_ID } from './operational-alert-rules.js';

/** Operational-alert / operator-signal key (issue #2079). */
export const PROVIDER_PAUSED_OCCUPANCY_ALERT_KEY = 'provider:paused-occupancy' as const;

export const PROVIDER_PAUSED_OCCUPANCY_METRIC = 'provider_paused_occupancy' as const;

/**
 * Minimum provider_paused occupancy before paging. Defaults match hung
 * residual so health findings and Discord pages agree on "≥3 stalled slots".
 */
export const DEFAULT_PROVIDER_PAUSED_OCCUPANCY_PAGE_BOUND =
  DEFAULT_PROVIDER_PAUSED_OCCUPANCY_COUNT_BOUND;

/**
 * How long occupancy must stay ≥ bound without decreasing before the first
 * page. Default 30m sits well under the hard TTL (2h) so the operator gets a
 * remote page while the hold is still recoverable.
 */
export const DEFAULT_PROVIDER_PAUSED_OCCUPANCY_STALE_MS = 30 * 60_000;

/** Re-page cooldown while occupancy remains high (default 1h). */
export const DEFAULT_PROVIDER_PAUSED_OCCUPANCY_COOLDOWN_MS = 60 * 60_000;

export interface ProviderPausedOccupancyAlerterDeps {
  /**
   * Broadcast path — prefer `detectorBroadcast` so fire/clear edges spool to
   * the operator-signal outbox (Discord). Must not throw.
   */
  broadcast: (msg: ServerMessage) => void;
  /** Live occupancy count bound. Falls back to default page bound. */
  getCountBound?: () => number;
  /** Live stale window (ms). */
  getStaleMs?: () => number;
  /** Live re-page cooldown (ms). */
  getCooldownMs?: () => number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface EvaluateProviderPausedOccupancyInput {
  /** Current provider_paused occupancy after this tick's observe pass. */
  occupancyCount: number;
  /** Oldest continuous pause age in ms (informational; in details). */
  oldestPauseAgeMs?: number | null;
  /** Tasks hard-TTL reclaimed this tick (informational). */
  reclaimedCount?: number;
}

export interface ProviderPausedOccupancyAlerterStats {
  firing: boolean;
  lastCount: number;
  occupancyHighSinceMs: number | null;
  lastAlertedAtMs: number | null;
}

/**
 * Edge-triggered occupancy page for provider_paused holds (issue #2079).
 * Holds episode state in process memory — a restart resets the wait window.
 */
export class ProviderPausedOccupancyAlerter {
  private firing = false;
  private occupancyHighSinceMs: number | null = null;
  private lastCount = 0;
  private lastAlertedAtMs: number | null = null;
  private readonly deps: ProviderPausedOccupancyAlerterDeps;

  constructor(deps: ProviderPausedOccupancyAlerterDeps) {
    this.deps = deps;
  }

  /**
   * Evaluate occupancy after the liveness tick. Page-only — never mutates tasks.
   * Safe to call every tick.
   */
  evaluate(input: EvaluateProviderPausedOccupancyInput): void {
    const nowMs = this.deps.now?.() ?? Date.now();
    const bound = this.resolveCountBound();
    const occupancy = Math.max(0, Math.floor(input.occupancyCount));
    const reclaimed = Math.max(0, Math.floor(input.reclaimedCount ?? 0));
    const oldestAge =
      typeof input.oldestPauseAgeMs === 'number' && Number.isFinite(input.oldestPauseAgeMs)
        ? Math.max(0, Math.floor(input.oldestPauseAgeMs))
        : null;

    if (occupancy === 0) {
      if (this.firing) {
        this.emit(buildProviderPausedOccupancyRecoveryAlert());
      }
      this.firing = false;
      this.occupancyHighSinceMs = null;
      this.lastCount = 0;
      return;
    }

    if (occupancy < bound) {
      this.occupancyHighSinceMs = null;
      this.lastCount = occupancy;
      return;
    }

    // occupancy ≥ bound
    if (
      this.occupancyHighSinceMs === null
      || occupancy < this.lastCount
    ) {
      this.occupancyHighSinceMs = nowMs;
    }
    this.lastCount = occupancy;

    const staleMs = this.resolveStaleMs();
    if (nowMs - this.occupancyHighSinceMs < staleMs) {
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
      buildProviderPausedOccupancyAlert({
        occupancyCount: occupancy,
        countBound: bound,
        staleMs,
        reclaimedCount: reclaimed,
        oldestPauseAgeMs: oldestAge,
      }),
    );
  }

  stats(): ProviderPausedOccupancyAlerterStats {
    return {
      firing: this.firing,
      lastCount: this.lastCount,
      occupancyHighSinceMs: this.occupancyHighSinceMs,
      lastAlertedAtMs: this.lastAlertedAtMs,
    };
  }

  private emit(alert: Extract<ServerMessage, { type: 'alert' }>): void {
    try {
      this.deps.broadcast(alert);
    } catch (err) {
      console.warn(
        '[provider-paused-occupancy] broadcast threw (ignored):',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private resolveCountBound(): number {
    const value = this.deps.getCountBound?.();
    if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
      return Math.floor(value);
    }
    return DEFAULT_PROVIDER_PAUSED_OCCUPANCY_PAGE_BOUND;
  }

  private resolveStaleMs(): number {
    const value = this.deps.getStaleMs?.();
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
    return DEFAULT_PROVIDER_PAUSED_OCCUPANCY_STALE_MS;
  }

  private resolveCooldownMs(): number {
    const value = this.deps.getCooldownMs?.();
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
    return DEFAULT_PROVIDER_PAUSED_OCCUPANCY_COOLDOWN_MS;
  }
}

export function buildProviderPausedOccupancyAlert(args: {
  occupancyCount: number;
  countBound: number;
  staleMs: number;
  reclaimedCount: number;
  oldestPauseAgeMs: number | null;
}): Extract<ServerMessage, { type: 'alert' }> {
  const staleMin = Math.round(args.staleMs / 60_000);
  const oldestMin =
    args.oldestPauseAgeMs !== null
      ? Math.round(args.oldestPauseAgeMs / 60_000)
      : null;
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary:
      `provider_paused occupancy high: ${args.occupancyCount} task(s) holding capacity on billing/quota pause`,
    details:
      `Issue #2079: provider_paused occupancy stayed ≥ ${args.countBound} for ≥ ${staleMin}m `
      + `without decreasing. Current occupancy=${args.occupancyCount}`
      + (oldestMin !== null ? `; oldest pause age≈${oldestMin}m` : '')
      + `; hard-TTL reclaimed this tick=${args.reclaimedCount}. `
      + 'Page only for the occupancy bound — hard TTL (default 2h) separately terminates '
      + 'aged pauses with needs-human disposition (open-PR fail-safe holds). '
      + 'Top up credits / re-auth providers, or free slots manually. '
      + 'Health: GET /api/health → providerPausedOccupancy.',
    severity: 'warning',
    operationalAlert: {
      key: PROVIDER_PAUSED_OCCUPANCY_ALERT_KEY,
      metric: PROVIDER_PAUSED_OCCUPANCY_METRIC,
      state: 'fired',
    },
  };
}

export function buildProviderPausedOccupancyRecoveryAlert(): Extract<ServerMessage, { type: 'alert' }> {
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: 'Recovered: provider_paused occupancy cleared',
    details:
      'provider_paused occupancy returned to 0 after a high episode. '
      + 'Capacity slots held by billing/quota pauses are free again.',
    severity: 'info',
    operationalAlert: {
      key: PROVIDER_PAUSED_OCCUPANCY_ALERT_KEY,
      metric: PROVIDER_PAUSED_OCCUPANCY_METRIC,
      state: 'recovered',
    },
  };
}
