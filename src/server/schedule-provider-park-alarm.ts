import type { Schedule, ScheduleExecutionLedgerEntry } from '../core/schedule.js';
import type { ServerMessage } from '../shared/contracts/messages.js';
import { OPERATIONAL_ALERT_AGENT_ID } from './operational-alert-rules.js';

/**
 * Per-schedule bounded provider-park-age alarm (issue #3034). Motivated by the
 * #1894 recurrence merge-review: a scheduled fire refused for no live provider
 * headroom is recorded as a non-incrementing `skipped_provider_paused` park so
 * it does NOT count toward the #2353 fail-closed auto-pause (correct — a
 * quota-empty tick must not daemon-hold the schedule). But
 * `skipped_provider_paused` is also in the dead-man switch's
 * `DELIBERATE_SUPPRESSION_OUTCOMES`, so the fleet-wide starvation detector stays
 * silent for it too, and every park row counts as a heartbeat for the
 * per-schedule liveness alarm (#2694) — so a schedule that quota-parks re-fires
 * every tick, indefinitely, with no backoff, no auto-pause, and no alert.
 *
 * That is correct as long as the quota/provider poll is never wrong-and-stuck.
 * A false-positive exhaustion reading — a latched binding-window cache, a
 * stale/past `resetsAt` still treated as binding, an adapter reporting 97%
 * forever — parks the schedule silently and permanently. Before #1894 the same
 * false-positive produced a loud `dispatch_failed` daemon-hold after 3 ticks;
 * after it, the failure mode is quiet. This alarm restores an observability
 * signal for that quiet case without reintroducing the daemon-hold: it is the
 * schedule-side analogue of the task-level #2079 provider-paused occupancy page.
 *
 * What it does: when an enabled schedule has recorded `skipped_provider_paused`
 * CONTINUOUSLY (a trailing run of at least {@link PROVIDER_PARK_MIN_RUN} rows,
 * with no successful fire and no other outcome in between) for longer than a
 * bounded age, it emits ONE operator alert. It does NOT auto-pause / daemon-hold
 * the schedule — the #1894 guarantee holds; the park stays non-incrementing and
 * the schedule keeps evaluating. Only the alarm changes.
 *
 * Evaluated from the schedule runner's existing 60s tick (no new interval),
 * right after the dead-man switch and liveness alarm so this tick's fires are
 * already in the ledger.
 *
 * Park-age rule (per enabled schedule):
 *
 *   run       = the maximal trailing run of `skipped_provider_paused` rows
 *               (broken by ANY other outcome — a successful fire, a drain, a
 *               dispatch failure — since "continuously parked" means no other
 *               outcome in between)
 *   parkAge   = now − run[0].evaluatedAt   (age of the OLDEST row in the run —
 *               how long the schedule has been continuously parked)
 *   parked    = run.length ≥ PROVIDER_PARK_MIN_RUN AND parkAge > threshold
 *
 * Requiring at least two rows is what makes "a single park raises no alert"
 * hold even for an old lone park (a schedule that parked once and then stopped
 * ticking is the liveness alarm's job, not this one). A park cleared by a later
 * successful fire breaks the run, so it never alerts and clears an open episode.
 *
 * Alert semantics: edge-triggered PER SCHEDULE — one `alert` ServerMessage
 * (severity `warning`, agentId `system`, operationalAlert key
 * `schedule:provider-park:<id>`) when a schedule crosses the bounded park age,
 * and a matching severity-`info` recovery alert when the park clears (a
 * successful fire or any non-park outcome, or the schedule being
 * disabled/deleted). Alert-only by design — no auto-pause, no self-heal —
 * matching the dead-man and liveness alarms' deliberate scope.
 */

/**
 * A trailing park run shorter than this is never "continuously parked-on-
 * provider": a single park (issue #3034 acceptance criterion) — or a lone old
 * park on a schedule that then stopped ticking, which the #2694 liveness alarm
 * already covers — must raise nothing here regardless of age.
 */
export const PROVIDER_PARK_MIN_RUN = 2;

/**
 * Default bounded park age (ms) before the first alert. 6h mirrors the #2694
 * stale-schedule floor: long enough that a normal same-day quota park that the
 * #1896 reset scheduler auto-resumes at its `resetsAt` will usually clear before
 * tripping, short enough to catch a stuck park within the day. Configurable via
 * the `providerParkAlarmMinutes` setting; a value <= 0 disables the alarm.
 */
export const DEFAULT_PROVIDER_PARK_ALARM_MS = 6 * 60 * 60_000;

/** The `skipped_provider_paused` outcome this alarm keys on (issue #1895). */
const PROVIDER_PARK_OUTCOME = 'skipped_provider_paused' as const;

export interface ParkedScheduleInfo {
  id: string;
  name: string;
  /** How long the schedule has been continuously parked-on-provider (ms). */
  parkAgeMs: number;
  /** Number of consecutive trailing `skipped_provider_paused` rows. */
  runLength: number;
  /** The bounded park-age threshold applied (ms). */
  thresholdMs: number;
  /** reasonCode of the newest park row (informational; typically `provider_paused`). */
  reasonCode?: string;
  /** Message of the newest park row (informational). */
  message?: string;
}

export interface ScheduleProviderParkAlarmDeps {
  broadcast: (msg: ServerMessage) => void;
  /**
   * Optional durable sink for the fire/clear transition (issue #1709 WS0.3),
   * recorded BEFORE the broadcast so a park episode that opens and clears while
   * no dashboard client is connected still leaves an on-disk trace. Mirrors the
   * dead-man and liveness alarms' `recordTransition`.
   */
  recordTransition?: (alert: Extract<ServerMessage, { type: 'alert' }>) => void;
  /**
   * Live getter for the bounded park age (ms). Falls back to
   * {@link DEFAULT_PROVIDER_PARK_ALARM_MS}. A value <= 0 disables the alarm.
   */
  getMaxProviderParkMs?: () => number;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export class ScheduleProviderParkAlarm {
  /**
   * Schedules currently in a parked (firing) episode, keyed by id → name, for
   * edge-triggering and so the recovery alert can name the schedule that
   * recovered (the id alone lives in `operationalAlert.key`).
   */
  private readonly firing = new Map<string, string>();
  private readonly deps: ScheduleProviderParkAlarmDeps;

  constructor(deps: ScheduleProviderParkAlarmDeps) {
    this.deps = deps;
  }

  /**
   * Evaluate one tick. Emits at most one fired alert per schedule per park
   * episode, and one recovery alert when the park clears (a non-park outcome,
   * or the schedule leaving the enabled set). Never auto-pauses.
   */
  check(schedules: Schedule[]): void {
    const maxMs = this.resolveMaxMs();
    if (maxMs <= 0) {
      // Disabled: close every open episode with a recovery so the durable trace
      // never dangles on a `fired` with no matching `recovered`. Then start
      // clean for any future re-enable.
      for (const [id, name] of this.firing) {
        this.emit(buildProviderParkRecoveryAlert(id, name));
      }
      this.firing.clear();
      return;
    }

    const nowMs = (this.deps.now?.() ?? new Date()).getTime();
    const parked = evaluateScheduleProviderParks(schedules, nowMs, maxMs);
    const parkedById = new Map(parked.map((info) => [info.id, info]));

    for (const info of parked) {
      if (!this.firing.has(info.id)) {
        this.firing.set(info.id, info.name);
        this.emit(buildProviderParkAlert(info));
      }
    }

    // Recover any schedule that was firing but is no longer parked-too-long —
    // including one that has been disabled or deleted (absent from parkedById).
    for (const [id, name] of [...this.firing]) {
      if (!parkedById.has(id)) {
        this.firing.delete(id);
        this.emit(buildProviderParkRecoveryAlert(id, name));
      }
    }
  }

  /**
   * Point-in-time view of the schedules currently flagged as parked-too-long,
   * for surfacing on a status/health snapshot. Empty when nothing is parked.
   */
  stats(): { parkedCount: number; parkedSchedules: Array<{ id: string; name: string }> } {
    const parkedSchedules = [...this.firing].map(([id, name]) => ({ id, name }));
    return { parkedCount: parkedSchedules.length, parkedSchedules };
  }

  /**
   * Record the transition to the durable sink (if configured) BEFORE
   * broadcasting, so the on-disk trace survives even if no dashboard client is
   * connected. The recorder is fire-and-forget: a throw from it must never
   * suppress the WS broadcast.
   */
  private emit(alert: Extract<ServerMessage, { type: 'alert' }>): void {
    try {
      this.deps.recordTransition?.(alert);
    } catch (err) {
      console.warn(
        '[schedule-provider-park] recordTransition threw (ignored):',
        err instanceof Error ? err.message : String(err),
      );
    }
    this.deps.broadcast(alert);
  }

  private resolveMaxMs(): number {
    const value = this.deps.getMaxProviderParkMs?.();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return DEFAULT_PROVIDER_PARK_ALARM_MS;
  }
}

/**
 * Pure park-age evaluator — exported for direct unit testing. Returns the
 * enabled schedules whose trailing `skipped_provider_paused` run is at least
 * {@link PROVIDER_PARK_MIN_RUN} rows AND has been open longer than `maxMs`.
 * Callers key on `id`.
 */
export function evaluateScheduleProviderParks(
  schedules: Schedule[],
  nowMs: number,
  maxMs: number = DEFAULT_PROVIDER_PARK_ALARM_MS,
): ParkedScheduleInfo[] {
  const parked: ParkedScheduleInfo[] = [];
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;

    const run = trailingProviderParkRun(schedule.executionLedger);
    if (run.length < PROVIDER_PARK_MIN_RUN) continue;

    // Age from the OLDEST park in the run whose timestamp parses. Normally
    // that is run[0], but a single garbage `evaluatedAt` on the oldest row
    // (the store only checks truthiness, not date validity) must not suppress
    // the alarm for the whole schedule when newer park rows carry valid
    // timestamps — falling through to the next parseable row underestimates
    // the age (conservative: it never over-fires).
    let oldestMs: number | undefined;
    for (const parkRow of run) {
      const ms = Date.parse(parkRow.evaluatedAt);
      if (Number.isFinite(ms)) {
        oldestMs = ms;
        break;
      }
    }
    if (oldestMs === undefined) continue;

    const parkAgeMs = nowMs - oldestMs;
    if (parkAgeMs <= maxMs) continue;

    const newest = run[run.length - 1];
    parked.push({
      id: schedule.id,
      name: schedule.name,
      parkAgeMs,
      runLength: run.length,
      thresholdMs: maxMs,
      ...(newest.reasonCode ? { reasonCode: newest.reasonCode } : {}),
      ...(newest.message ? { message: newest.message } : {}),
    });
  }
  return parked;
}

/**
 * The maximal trailing run of `skipped_provider_paused` rows in ledger order
 * (oldest-first). Broken by ANY other outcome, since "continuously parked-on-
 * provider" means no successful fire and no other outcome in between. Empty when
 * the newest row is not a provider park.
 */
function trailingProviderParkRun(
  ledger: readonly ScheduleExecutionLedgerEntry[],
): ScheduleExecutionLedgerEntry[] {
  const run: ScheduleExecutionLedgerEntry[] = [];
  for (let i = ledger.length - 1; i >= 0; i -= 1) {
    if (ledger[i].outcome !== PROVIDER_PARK_OUTCOME) break;
    run.push(ledger[i]);
  }
  run.reverse();
  return run;
}

function buildProviderParkAlert(info: ParkedScheduleInfo): Extract<ServerMessage, { type: 'alert' }> {
  const parkedH = (info.parkAgeMs / 3_600_000).toFixed(1);
  const thresholdMin = Math.round(info.thresholdMs / 60_000);
  const reason = info.reasonCode ? ` reasonCode=${info.reasonCode}.` : '';
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Schedule "${info.name}" has been provider-parked for ${parkedH}h`,
    details:
      `Bounded provider-park alarm (issue #3034): "${info.name}" is enabled but has recorded ` +
      `\`skipped_provider_paused\` continuously for ${parkedH}h (${info.runLength} consecutive parks), ` +
      `past the ${thresholdMin}-minute bound.${reason} ` +
      'The park is non-incrementing by design (#1894), so it does NOT auto-pause the schedule and does NOT ' +
      'trip the fleet-wide dead-man switch — but a fire refused every tick for provider unavailability means ' +
      'the schedule is not running its work. A park this long can be a genuine long quota outage OR a stuck ' +
      'provider signal (a latched binding-window cache, a stale `resetsAt` still treated as binding, an adapter ' +
      'reporting exhaustion forever). Confirm the provider actually has no headroom: `kookr schedule list` / the ' +
      'schedules panel, and the provider-health / quota state. Top up credits or clear the stuck signal if the park ' +
      'is false. This alert is raised once per park episode and clears when the schedule fires (or records any ' +
      'non-park outcome). No automatic remediation is taken (alert-only by design).',
    severity: 'warning',
    operationalAlert: {
      key: `schedule:provider-park:${info.id}`,
      metric: 'schedule_provider_park',
      state: 'fired',
    },
  };
}

function buildProviderParkRecoveryAlert(
  scheduleId: string,
  name: string,
): Extract<ServerMessage, { type: 'alert' }> {
  return {
    type: 'alert',
    agentId: OPERATIONAL_ALERT_AGENT_ID,
    summary: `Recovered: schedule "${name}" is no longer provider-parked`,
    details:
      `Bounded provider-park alarm cleared for "${name}": it recorded a successful fire or another non-park ` +
      'outcome (or was disabled/removed), so it is no longer continuously parked-on-provider beyond the bounded age.',
    severity: 'info',
    operationalAlert: {
      key: `schedule:provider-park:${scheduleId}`,
      metric: 'schedule_provider_park',
      state: 'recovered',
    },
  };
}
