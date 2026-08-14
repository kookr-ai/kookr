/**
 * Discord/operator page when fail-closed schedule pauses stay high
 * (issue #2426).
 *
 * Issue #2353 already parks a schedule after N consecutive failures and
 * lists those parks on `GET /api/health`. Nothing pages Discord, so
 * unattended operators never hear that three or more belts have stopped
 * firing. Healing then waits on someone noticing a 14KB health blob.
 *
 * This module is **page-only**: it never re-enables a schedule. It
 * evaluates the paused-by-failure list on each liveness tick and:
 *
 * - fires an operational alert (key `schedules:paused:residual`) once the
 *   paused count crosses ≥ N;
 * - re-pages at most once per cooldown while the count stays ≥ N;
 * - emits a matching `recovered` clear when the count returns to 0;
 * - lists each paused name, consecutiveFailures, and
 *   `kookr schedule enable <id>` so a Discord-only operator can heal.
 *
 * Wire via detectorBroadcast (index.ts) so the operational-alert bridge
 * spools operator signals to Discord (issue #1716).
 */

import type { ServerMessage } from '../shared/contracts/messages.js';
import { OPERATIONAL_ALERT_AGENT_ID } from './operational-alert-rules.js';

/** Operational-alert / operator-signal key (issue #2426). */
export const SCHEDULES_PAUSED_RESIDUAL_ALERT_KEY = 'schedules:paused:residual' as const;

export const SCHEDULES_PAUSED_RESIDUAL_METRIC = 'schedules_paused_residual' as const;

/**
 * Minimum fail-closed-paused count before paging. Matches the hung / FAA
 * residual bound so one-or-two parks stay operator-local (doctor / health)
 * and Discord only fires once a belt-wide stall is in play.
 */
export const DEFAULT_SCHEDULES_PAUSED_COUNT_BOUND = 3;

/** Re-page cooldown while the paused count remains ≥ bound (default 1h). */
export const DEFAULT_SCHEDULES_PAUSED_COOLDOWN_MS = 60 * 60_000;

/**
 * Cap how many paused rows the Discord body lists. Production currently
 * parks about eight schedules on a full belt stall; 16 leaves headroom
 * without blowing the page.
 */
export const SCHEDULES_PAUSED_SAMPLE_CAP = 16;

export interface PausedScheduleSample {
  id: string;
  name: string;
  consecutiveFailures: number;
}

export interface SchedulesPausedResidualAlerterDeps {
  /**
   * Broadcast path — prefer `detectorBroadcast` so fire/clear edges spool to
   * the operator-signal outbox (Discord). Must not throw.
   */
  broadcast: (msg: ServerMessage) => void;
  /** Live paused-count bound. Falls back to {@link DEFAULT_SCHEDULES_PAUSED_COUNT_BOUND}. */
  getCountBound?: () => number;
  /** Live re-page cooldown (ms). Falls back to {@link DEFAULT_SCHEDULES_PAUSED_COOLDOWN_MS}. */
  getCooldownMs?: () => number;
  /** Injectable clock (tests). */
  now?: () => number;
}

export interface EvaluateSchedulesPausedResidualInput {
  /** Current fail-closed-paused schedules (id / name / consecutiveFailures). */
  paused: ReadonlyArray<PausedScheduleSample>;
}

export interface SchedulesPausedResidualAlerterStats {
  /** True while an unrecovered residual episode is open. */
  firing: boolean;
  /** Paused count last observed. */
  lastCount: number;
  /** When the last fire/re-page was emitted, or null. */
  lastAlertedAtMs: number | null;
}

/**
 * Edge-triggered residual page for fail-closed schedule pauses (issue #2426).
 * Holds episode state in process memory — a restart resets the episode
 * (same trade-off as hung residual / FAA residual / schedule dead-man).
 */
export class SchedulesPausedResidualAlerter {
  private firing = false;
  private lastCount = 0;
  private lastAlertedAtMs: number | null = null;
  private readonly deps: SchedulesPausedResidualAlerterDeps;

  constructor(deps: SchedulesPausedResidualAlerterDeps) {
    this.deps = deps;
  }

  /**
   * Evaluate the current fail-closed-paused list. Page-only — never
   * re-enables a schedule. Safe to call every liveness tick.
   */
  evaluate(input: EvaluateSchedulesPausedResidualInput): void {
    const nowMs = this.deps.now?.() ?? Date.now();
    const bound = this.resolveCountBound();
    const paused = sanitizePaused(input.paused);
    const count = paused.length;

    if (count === 0) {
      if (this.firing) {
        this.emit(buildSchedulesPausedResidualRecoveryAlert());
      }
      this.firing = false;
      this.lastCount = 0;
      // lastAlertedAtMs is retained for diagnostics only. After clear, a new
      // episode pages on the next crossing (!firing short-circuits the
      // cooldown gate on the next fire).
      return;
    }

    if (count < bound) {
      // Below page threshold but not zero: do not fire; do not clear (clear
      // is only at 0).
      this.lastCount = count;
      return;
    }

    this.lastCount = count;

    const cooldownMs = this.resolveCooldownMs();
    const canPage =
      !this.firing
      || this.lastAlertedAtMs === null
      || nowMs - this.lastAlertedAtMs >= cooldownMs;
    if (!canPage) return;

    this.firing = true;
    this.lastAlertedAtMs = nowMs;
    this.emit(
      buildSchedulesPausedResidualAlert({
        paused,
        countBound: bound,
      }),
    );
  }

  /** Observable episode state for tests / diagnostics. */
  stats(): SchedulesPausedResidualAlerterStats {
    return {
      firing: this.firing,
      lastCount: this.lastCount,
      lastAlertedAtMs: this.lastAlertedAtMs,
    };
  }

  private emit(alert: Extract<ServerMessage, { type: 'alert' }>): void {
    try {
      this.deps.broadcast(alert);
    } catch (err) {
      console.warn(
        '[schedules-paused-residual] broadcast threw (ignored):',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private resolveCountBound(): number {
    const value = this.deps.getCountBound?.();
    if (typeof value === 'number' && Number.isFinite(value) && value >= 1) {
      return Math.floor(value);
    }
    return DEFAULT_SCHEDULES_PAUSED_COUNT_BOUND;
  }

  private resolveCooldownMs(): number {
    const value = this.deps.getCooldownMs?.();
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
    return DEFAULT_SCHEDULES_PAUSED_COOLDOWN_MS;
  }
}

/**
 * Drop empty ids (cannot form `kookr schedule enable <id>`) and coerce a
 * missing/non-finite failure count to 0 so a still-paused row stays listed
 * rather than disappearing from the page.
 */
function sanitizePaused(
  paused: ReadonlyArray<PausedScheduleSample>,
): PausedScheduleSample[] {
  const out: PausedScheduleSample[] = [];
  for (const row of paused) {
    if (!row || typeof row.id !== 'string' || row.id.length === 0) continue;
    const name = typeof row.name === 'string' && row.name.length > 0 ? row.name : row.id;
    const consecutiveFailures =
      typeof row.consecutiveFailures === 'number'
      && Number.isFinite(row.consecutiveFailures)
      && row.consecutiveFailures > 0
        ? Math.floor(row.consecutiveFailures)
        : 0;
    out.push({ id: row.id, name, consecutiveFailures });
  }
  return out;
}

/** Format the Discord body list of paused schedules (issue #2426). */
export function formatPausedScheduleLines(
  paused: ReadonlyArray<PausedScheduleSample>,
  sampleCap: number = SCHEDULES_PAUSED_SAMPLE_CAP,
): string {
  const shown = paused.slice(0, sampleCap);
  const extra = paused.length - shown.length;
  const lines = shown.map(
    (row) =>
      `- ${row.name} (${row.id}): consecutiveFailures=${row.consecutiveFailures}`
      + ` — kookr schedule enable ${row.id}`,
  );
  if (extra > 0) {
    lines.push(`- (+${extra} more not listed)`);
  }
  return lines.join('\n');
}

export function buildSchedulesPausedResidualAlert(args: {
  paused: ReadonlyArray<PausedScheduleSample>;
  countBound: number;
}): Extract<ServerMessage, { type: 'alert' }> {
  const count = args.paused.length;
  const list = formatPausedScheduleLines(args.paused);
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary:
      `schedules fail-closed paused: ${count} schedule(s) parked after consecutive failures`,
    details:
      `Issue #2426: ${count} schedule(s) are fail-closed paused `
      + `(stopReason=consecutive_failures), crossing the page bound of ${args.countBound}. `
      + 'Page only — no schedule is re-enabled by this alert. '
      + 'Diagnose the loop, then re-enable with `kookr schedule enable <id>`.\n'
      + list,
    severity: 'warning',
    operationalAlert: {
      key: SCHEDULES_PAUSED_RESIDUAL_ALERT_KEY,
      metric: SCHEDULES_PAUSED_RESIDUAL_METRIC,
      state: 'fired',
    },
  };
}

export function buildSchedulesPausedResidualRecoveryAlert(): Extract<ServerMessage, { type: 'alert' }> {
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: 'Recovered: fail-closed schedule pauses cleared',
    details:
      'Fail-closed paused count returned to 0 after a residual-high episode. '
      + 'No schedule was auto-resumed by this alert.',
    severity: 'info',
    operationalAlert: {
      key: SCHEDULES_PAUSED_RESIDUAL_ALERT_KEY,
      metric: SCHEDULES_PAUSED_RESIDUAL_METRIC,
      state: 'recovered',
    },
  };
}
