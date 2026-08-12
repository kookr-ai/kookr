/**
 * Discord/operator page when resourceWatchdog stays disabled under host
 * pressure (issue #2078).
 *
 * #2039 surfaces `pressureWhileDisabled` on `/api/health` and the status pill;
 * #1988 adds a local doctor WARN. Neither pages Discord. Unattended hosts can
 * sit with the actuator off and elevated `staleProcesses.dtach` with no remote
 * signal and no auto-investigation spawn.
 *
 * This module is **page-only**: it never enables the watchdog and never spawns
 * an investigation task. It evaluates each resource-watchdog tick and:
 *
 * - fires an operational alert (key `resource:watchdog_disabled_pressure`) once
 *   `pressureWhileDisabled` has stayed true for M minutes;
 * - re-pages at most once per cooldown while pressure remains true;
 * - emits a matching `recovered` clear when the actuator is enabled or pressure
 *   clears (dtach count drops below the soft bound).
 *
 * Wire via detectorBroadcast (index.ts) so the operational-alert bridge spools
 * operator signals to Discord (issue #1716).
 */

import type { ServerMessage } from '../shared/contracts/messages.js';
import { OPERATIONAL_ALERT_AGENT_ID } from './operational-alert-rules.js';

/** Operational-alert / operator-signal key (issue #2078). */
export const WATCHDOG_DISABLED_PRESSURE_ALERT_KEY =
  'resource:watchdog_disabled_pressure' as const;

export const WATCHDOG_DISABLED_PRESSURE_METRIC =
  'resource_watchdog_disabled_pressure' as const;

/**
 * How long pressureWhileDisabled must stay true before the first page.
 * Default 30m absorbs brief intentional disables and short-lived spikes.
 */
export const DEFAULT_WATCHDOG_DISABLED_PRESSURE_STALE_MS = 30 * 60_000;

/** Re-page cooldown while pressure remains true (default 1h). */
export const DEFAULT_WATCHDOG_DISABLED_PRESSURE_COOLDOWN_MS = 60 * 60_000;

export interface WatchdogDisabledPressureAlerterDeps {
  /**
   * Broadcast path — prefer `detectorBroadcast` so fire/clear edges spool to
   * the operator-signal outbox (Discord). Must not throw.
   */
  broadcast: (msg: ServerMessage) => void;
  /** Live stale window (ms). Falls back to {@link DEFAULT_WATCHDOG_DISABLED_PRESSURE_STALE_MS}. */
  getStaleMs?: () => number;
  /** Live re-page cooldown (ms). Falls back to {@link DEFAULT_WATCHDOG_DISABLED_PRESSURE_COOLDOWN_MS}. */
  getCooldownMs?: () => number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface EvaluateWatchdogDisabledPressureInput {
  /** Live `pressureWhileDisabled` health bit for this tick. */
  pressureWhileDisabled: boolean;
  /** Human-readable reason when pressure is true; null otherwise. */
  reason: string | null;
  /** Cached `staleProcesses.dtach.count` (informational; in details only). */
  dtachCount?: number | null;
}

export interface WatchdogDisabledPressureAlerterStats {
  /** True while an unrecovered pressure episode is open. */
  firing: boolean;
  /** When pressure first became true for this episode, or null. */
  pressureSinceMs: number | null;
  /** When the last fire/re-page was emitted, or null. */
  lastAlertedAtMs: number | null;
}

/**
 * Edge-triggered page when the resource watchdog stays off under pressure
 * (issue #2078). Holds episode state in process memory — a restart resets the
 * wait window (same trade-off as hung residual / schedule dead-man).
 */
export class WatchdogDisabledPressureAlerter {
  private firing = false;
  private pressureSinceMs: number | null = null;
  private lastAlertedAtMs: number | null = null;
  private readonly deps: WatchdogDisabledPressureAlerterDeps;

  constructor(deps: WatchdogDisabledPressureAlerterDeps) {
    this.deps = deps;
  }

  /**
   * Evaluate one resource-watchdog tick. Page-only — never enables the
   * actuator or spawns tasks. Safe to call every tick.
   */
  evaluate(input: EvaluateWatchdogDisabledPressureInput): void {
    const nowMs = this.deps.now?.() ?? Date.now();

    if (!input.pressureWhileDisabled) {
      if (this.firing) {
        this.emit(buildWatchdogDisabledPressureRecoveryAlert());
      }
      this.firing = false;
      this.pressureSinceMs = null;
      // lastAlertedAtMs retained for diagnostics only. After clear, a new
      // episode must wait a full stale window before paging again (!firing
      // short-circuits the cooldown gate on the next fire).
      return;
    }

    // pressureWhileDisabled === true
    if (this.pressureSinceMs === null) {
      this.pressureSinceMs = nowMs;
    }

    const staleMs = this.resolveStaleMs();
    if (nowMs - this.pressureSinceMs < staleMs) {
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
      buildWatchdogDisabledPressureAlert({
        reason: input.reason,
        staleMs,
        dtachCount: input.dtachCount ?? null,
      }),
    );
  }

  /** Observable episode state for tests / diagnostics. */
  stats(): WatchdogDisabledPressureAlerterStats {
    return {
      firing: this.firing,
      pressureSinceMs: this.pressureSinceMs,
      lastAlertedAtMs: this.lastAlertedAtMs,
    };
  }

  private emit(alert: Extract<ServerMessage, { type: 'alert' }>): void {
    try {
      this.deps.broadcast(alert);
    } catch (err) {
      console.warn(
        '[watchdog-disabled-pressure] broadcast threw (ignored):',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private resolveStaleMs(): number {
    const value = this.deps.getStaleMs?.();
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
    return DEFAULT_WATCHDOG_DISABLED_PRESSURE_STALE_MS;
  }

  private resolveCooldownMs(): number {
    const value = this.deps.getCooldownMs?.();
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
    return DEFAULT_WATCHDOG_DISABLED_PRESSURE_COOLDOWN_MS;
  }
}

export function buildWatchdogDisabledPressureAlert(args: {
  reason: string | null;
  staleMs: number;
  dtachCount: number | null;
}): Extract<ServerMessage, { type: 'alert' }> {
  const staleMin = Math.round(args.staleMs / 60_000);
  const reasonLine = args.reason?.trim()
    ? args.reason.trim()
    : 'resourceWatchdog is disabled while host pressure remains elevated';
  const countNote =
    args.dtachCount !== null && Number.isFinite(args.dtachCount)
      ? ` staleProcesses.dtach.count=${args.dtachCount}.`
      : '';
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary:
      'resourceWatchdog master off under pressure — continuous monitoring disabled',
    details:
      `Issue #2078: pressureWhileDisabled stayed true for ≥ ${staleMin}m. `
      + `${reasonLine}.${countNote} `
      + 'Master switch remains an operator decision (set KOOKR_RESOURCE_WATCHDOG=1 '
      + 'for continuous sampling). Default auto-enable may still spawn a rate-limited '
      + 'investigation under soft-bound pressure (issue #2354; set '
      + 'KOOKR_RESOURCE_WATCHDOG_AUTO_ENABLE=0 for page-only). '
      + 'Health: GET /api/health → resourceWatchdog.pressureWhileDisabled.',
    severity: 'warning',
    operationalAlert: {
      key: WATCHDOG_DISABLED_PRESSURE_ALERT_KEY,
      metric: WATCHDOG_DISABLED_PRESSURE_METRIC,
      state: 'fired',
    },
  };
}

export function buildWatchdogDisabledPressureRecoveryAlert(): Extract<
  ServerMessage,
  { type: 'alert' }
> {
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: 'Recovered: resourceWatchdog disabled-under-pressure cleared',
    details:
      'pressureWhileDisabled returned to false (watchdog enabled or '
      + 'staleProcesses.dtach dropped below the soft bound).',
    severity: 'info',
    operationalAlert: {
      key: WATCHDOG_DISABLED_PRESSURE_ALERT_KEY,
      metric: WATCHDOG_DISABLED_PRESSURE_METRIC,
      state: 'recovered',
    },
  };
}
