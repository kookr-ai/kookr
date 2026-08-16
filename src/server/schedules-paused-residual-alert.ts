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
 * One idempotent, provenance-filtered command that re-enables every
 * cascade-origin held schedule (issue #2531). Embedded verbatim in every page
 * so a Discord-only operator can copy-paste one line instead of running
 * `kookr schedule enable <id>` N times. See `bin/kookr-schedule.js`.
 */
export const CASCADE_BATCH_REENABLE_COMMAND = 'kookr schedule enable --held-by cascade' as const;

/**
 * Age-based escalation ladder (issue #2531). The residual page is edge-
 * triggered on the paused count crossing the bound (#2426); this ladder
 * re-raises that page with rising urgency the longer the *same* episode stays
 * unrecovered, so a dropped, fire-and-forget escalation cannot sit ignored for
 * 24h+ (the motivating window). Each step is `{ afterMs, severity, urgency }`:
 * once the open episode's age reaches `afterMs`, the next page uses that step's
 * severity/urgency. Steps are ascending by `afterMs`; step 0 (`afterMs: 0`)
 * reproduces the original warning-severity page byte-for-byte.
 *
 * `AnomalySeverity` has only `info | warning | critical`, so severity tops out
 * at `critical`; the `urgency` label carries the finer gradation into the page
 * copy. Escalation stops when the episode recovers (paused count → 0) — which,
 * in practice, is exactly what running {@link CASCADE_BATCH_REENABLE_COMMAND}
 * causes — so recovery *is* the ack signal and no separate ack channel is
 * introduced.
 */
export interface SchedulesPausedEscalationStep {
  /** Open-episode age (ms) at or beyond which this step's page applies. */
  afterMs: number;
  severity: 'warning' | 'critical';
  /** Fine-grained urgency label surfaced in the page copy. */
  urgency: string;
}

export const DEFAULT_SCHEDULES_PAUSED_ESCALATION_LADDER: readonly SchedulesPausedEscalationStep[] = [
  { afterMs: 0, severity: 'warning', urgency: 'ELEVATED' },
  { afterMs: 6 * 60 * 60_000, severity: 'critical', urgency: 'HIGH' },
  { afterMs: 12 * 60 * 60_000, severity: 'critical', urgency: 'SEVERE' },
];

/**
 * Resolve the ladder step for an open episode of `ageMs`. Returns the index of
 * the highest step whose `afterMs ≤ ageMs` (always ≥ 0 — step 0 has
 * `afterMs: 0`). A negative/NaN age floors to step 0.
 */
export function resolveEscalationTier(
  ageMs: number,
  ladder: readonly SchedulesPausedEscalationStep[] = DEFAULT_SCHEDULES_PAUSED_ESCALATION_LADDER,
): number {
  let tier = 0;
  for (let i = 1; i < ladder.length; i++) {
    if (Number.isFinite(ageMs) && ageMs >= ladder[i].afterMs) tier = i;
    else break;
  }
  return tier;
}

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
  /**
   * Age-based escalation ladder (issue #2531). Falls back to
   * {@link DEFAULT_SCHEDULES_PAUSED_ESCALATION_LADDER}. Injectable so tests can
   * exercise the ladder on a compressed clock.
   */
  getEscalationLadder?: () => readonly SchedulesPausedEscalationStep[];
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
  /** When the current open episode began (first fire), or null. */
  episodeStartedAtMs: number | null;
  /** Highest escalation-ladder step paged in the current episode (issue #2531). */
  escalationTier: number;
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
  /** First-fire timestamp of the current open episode (issue #2531). */
  private episodeStartedAtMs: number | null = null;
  /** Highest ladder step paged in the current episode (issue #2531). */
  private escalationTier = 0;
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
      // Recovery is the ack (issue #2531): running the batch re-enable drops
      // the count to 0, ending the episode and stopping escalation. Reset the
      // episode clock/tier so the next crossing starts a fresh ladder.
      this.episodeStartedAtMs = null;
      this.escalationTier = 0;
      // lastAlertedAtMs is retained for diagnostics only. After clear, a new
      // episode pages on the next crossing (!firing short-circuits the
      // cooldown gate on the next fire).
      return;
    }

    if (count < bound) {
      // Below page threshold but not zero: do not fire; do not clear (clear
      // is only at 0). The episode clock is intentionally NOT reset here — a
      // partial recovery (e.g. 5→2 paused) leaves the episode open, so if the
      // count later re-crosses the bound the escalation resumes from the
      // original first-fire age rather than restarting cold. Escalation urgency
      // tracks how long the situation has stayed unresolved, and a partial
      // remediation that never reached 0 is still unresolved. Only a true
      // recovery (count === 0) ends the episode and resets the ladder.
      this.lastCount = count;
      return;
    }

    this.lastCount = count;

    // New episode: stamp the episode clock so age-based escalation measures
    // from the first fire, not from process start.
    if (!this.firing || this.episodeStartedAtMs === null) {
      this.episodeStartedAtMs = nowMs;
      this.escalationTier = 0;
    }

    const ladder = this.resolveLadder();
    const ageMs = nowMs - this.episodeStartedAtMs;
    const tier = resolveEscalationTier(ageMs, ladder);

    const cooldownMs = this.resolveCooldownMs();
    const cooldownElapsed =
      this.lastAlertedAtMs === null || nowMs - this.lastAlertedAtMs >= cooldownMs;
    // Page when: (a) opening the episode, (b) the episode aged into a higher
    // ladder step (escalation edge — bypasses the cooldown so a severity bump
    // is never swallowed), or (c) the same-tier re-page cooldown elapsed.
    const escalated = tier > this.escalationTier;
    const canPage = !this.firing || escalated || cooldownElapsed;
    if (!canPage) return;

    this.firing = true;
    this.escalationTier = Math.max(this.escalationTier, tier);
    this.lastAlertedAtMs = nowMs;
    this.emit(
      buildSchedulesPausedResidualAlert({
        paused,
        countBound: bound,
        tier,
        ageMs,
        ladder,
      }),
    );
  }

  /** Observable episode state for tests / diagnostics. */
  stats(): SchedulesPausedResidualAlerterStats {
    return {
      firing: this.firing,
      lastCount: this.lastCount,
      lastAlertedAtMs: this.lastAlertedAtMs,
      episodeStartedAtMs: this.episodeStartedAtMs,
      escalationTier: this.escalationTier,
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

  private resolveLadder(): readonly SchedulesPausedEscalationStep[] {
    const value = this.deps.getEscalationLadder?.();
    if (Array.isArray(value) && value.length > 0) return value;
    return DEFAULT_SCHEDULES_PAUSED_ESCALATION_LADDER;
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

/**
 * Render a coarse "Nh"/"Nm" age string for the page copy. Sub-minute ages
 * (the very first fire) render as `0m` rather than an empty string.
 */
export function formatEpisodeAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return '0m';
  const totalMinutes = Math.floor(ageMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

export function buildSchedulesPausedResidualAlert(args: {
  paused: ReadonlyArray<PausedScheduleSample>;
  countBound: number;
  /** Escalation-ladder step index for this page (issue #2531). Defaults to 0. */
  tier?: number;
  /** Open-episode age (ms) at page time (issue #2531). Defaults to 0. */
  ageMs?: number;
  /** Ladder in effect; defaults to {@link DEFAULT_SCHEDULES_PAUSED_ESCALATION_LADDER}. */
  ladder?: readonly SchedulesPausedEscalationStep[];
}): Extract<ServerMessage, { type: 'alert' }> {
  const count = args.paused.length;
  const list = formatPausedScheduleLines(args.paused);
  const ladder = args.ladder ?? DEFAULT_SCHEDULES_PAUSED_ESCALATION_LADDER;
  const tierIndex = Math.min(Math.max(args.tier ?? 0, 0), ladder.length - 1);
  const step = ladder[tierIndex];
  const ageMs = args.ageMs ?? 0;
  // Escalated pages (tier > 0) prefix the urgency + episode age so an operator
  // (and Discord) can see the page is a re-raise, not a fresh one.
  const escalated = tierIndex > 0;
  const summary = escalated
    ? `[${step.urgency}] schedules fail-closed paused ${formatEpisodeAge(ageMs)}+: `
      + `${count} schedule(s) still parked after consecutive failures`
    : `schedules fail-closed paused: ${count} schedule(s) parked after consecutive failures`;
  const ageLine = escalated
    ? `This episode has been unrecovered for ~${formatEpisodeAge(ageMs)} `
      + `(urgency ${step.urgency}); it will keep re-raising until cleared.\n`
    : '';
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary,
    details:
      `Issue #2426: ${count} schedule(s) are fail-closed paused `
      + `(stopReason=consecutive_failures), crossing the page bound of ${args.countBound}. `
      + 'Page only — no schedule is re-enabled by this alert.\n'
      + ageLine
      + 'Recover ALL cascade-origin holds in one idempotent command '
      + '(issue #2531 — #2517 makes cascade re-enable safe: false failure '
      + 'increments cannot recur, so genuine operator holds are left untouched):\n'
      + `    ${CASCADE_BATCH_REENABLE_COMMAND}\n`
      + 'Or re-enable one at a time with `kookr schedule enable <id>`:\n'
      + list,
    severity: step.severity,
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
