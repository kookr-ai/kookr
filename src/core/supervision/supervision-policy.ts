/**
 * Pure wake + watchdog policy for an attached task supervision (RFC
 * attachable-task-supervisor, P2a). `decide` reads the persisted state, a view
 * of the supervisor task, the clock and a config, and returns the actions the
 * `SupervisionService` should execute. It does no I/O and keeps no memory:
 * everything it needs lives in `state.json`, so a restarted server reaches the
 * same decision (R2).
 *
 * Shape of one decision, for an active (not yet ended) supervision:
 *  - the supervisor ended on purpose (completed or completion-ready, or
 *    cancelled/terminated by an operator) -> the mandate ends; it is never revived;
 *  - the supervisor crashed (any other termination, or no live session) -> `dead`
 *    -> a fresh episode (at most 3, at least 30 min apart), alert only when the
 *    cap is reached (R5); too soon after the last restart just waits;
 *  - a wake is due (heartbeat, deadline, or "targets finished") but the
 *    supervisor is not at an idle prompt -> count an undeliverable tick and keep
 *    retrying each tick. A busy supervisor is never restarted or cancelled: after
 *    3 ticks (or heartbeat + 15 min of silence) it is `degraded:undeliverable`; with
 *    no new hook events for 30 min it is `degraded:possibly-hung` with one alert;
 *  - the deadline wake and the "targets finished" wake are each delivered once
 *    and the NEXT tick then ends the mandate, so the end is recorded only after
 *    the recap prompt actually reached the supervisor.
 *
 * A state with no `supervisorTaskId` is never decided here: the service adopts
 * the task launched under `supervise-<id>` or ends the mandate `launch-failed`.
 *
 * Deliveries and restarts are actuation. When `config.actuationAllowed` is
 * false (kill switch, SAFE MODE, paused project, drain) nothing is delivered,
 * restarted or ended for deadline; one `wakes-disabled` alert is raised while the
 * mandate is active, and a crashed supervisor raises one alert. Intentional
 * endings are recorded regardless, since they actuate nothing.
 */

import type {
  SupervisionEndedReason,
  SupervisionHealth,
  SupervisionState,
} from './supervision-files.js';

export const MINUTE_MS = 60_000;

/**
 * Why the supervisor is no longer serving, as classified by the service from
 * the task contract: `finished` (completed, or completion-ready signalled),
 * `operator` (cancelled, or terminated by an operator/supervisor), `crashed`
 * (any other termination, or a non-terminal task with no live session).
 * Only `crashed` may be revived.
 */
export type SupervisorExit = 'finished' | 'operator' | 'crashed';

export interface SupervisorView {
  /**
   * The supervisor task is terminated for a recoverable reason a moment ago, so
   * crash recovery may still relaunch it. Nothing is decided; re-check next tick.
   */
  recovering?: boolean;
  /** Set when the supervisor is no longer serving; see {@link SupervisorExit}. */
  exit?: SupervisorExit;
  /** When the supervisor session last produced a new hook event; unknown = not treated as hung. */
  lastActivityAt?: string;
  /** The supervisor task is in a terminal status (or does not exist). */
  taskTerminal: boolean;
  /** A live agent session backs the supervisor task. */
  hasLiveSession: boolean;
  /**
   * The supervisor sits at its prompt: its last effective hook event is a
   * `stop` (including a Stop parked on background work) and it is not awaiting
   * a choice dialog.
   */
  deliverable: boolean;
  /** Every explicit target of the supervision is terminal. */
  allTargetsTerminal: boolean;
}

export interface PolicyConfig {
  heartbeatMs: number;
  /** Consecutive undeliverable ticks before `degraded:undeliverable`. */
  undeliverableTicks: number;
  /** Extra silence past `heartbeatMs` before `degraded:undeliverable`. */
  silenceGraceMs: number;
  maxRestarts: number;
  restartSpacingMs: number;
  /** A P1 file with no supervisor id yet is left alone for this long after creation (the CLI is still launching it). */
  launchGraceMs: number;
  /** A due wake undelivered while the supervisor shows no new hook events this long means possibly hung. */
  hungMs: number;
  /** False under the kill switch, SAFE MODE, a paused project or drain. */
  actuationAllowed: boolean;
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  heartbeatMs: 45 * MINUTE_MS,
  undeliverableTicks: 3,
  silenceGraceMs: 15 * MINUTE_MS,
  maxRestarts: 3,
  restartSpacingMs: 30 * MINUTE_MS,
  launchGraceMs: 5 * MINUTE_MS,
  hungMs: 30 * MINUTE_MS,
  actuationAllowed: true,
};

export type RestartCause = 'dead';

export type SupervisionAction =
  | { type: 'deliverHeartbeat' }
  | { type: 'deliverDeadline' }
  | { type: 'deliverFinal' }
  | { type: 'markEnded'; reason: SupervisionEndedReason }
  | { type: 'restartEpisode'; cause: RestartCause }
  | { type: 'alertOperator'; reason: string }
  | { type: 'markHealth'; health: SupervisionHealth; undeliverableTicks: number; undeliverableSince?: string };

export function isEnded(state: SupervisionState): boolean {
  return state.endedAt !== undefined;
}

function ms(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

/** When the next heartbeat is due, derived for a P1 file that has none yet. */
export function nextHeartbeatMs(state: SupervisionState, config: PolicyConfig): number {
  return ms(state.nextHeartbeatAt) ?? (ms(state.createdAt) ?? 0) + config.heartbeatMs;
}

export function decide(
  state: SupervisionState,
  supervisor: SupervisorView,
  now: Date,
  config: PolicyConfig = DEFAULT_POLICY_CONFIG,
): SupervisionAction[] {
  if (isEnded(state)) return [];
  if (state.supervisorTaskId === null) return [];
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const currentHealth: SupervisionHealth = state.health ?? 'healthy';
  const currentTicks = state.undeliverableTicks ?? 0;

  // Intentional endings are final and never revived, gate or not.
  if (supervisor.exit === 'finished') return [{ type: 'markEnded', reason: 'supervisor-finished' }];
  if (supervisor.exit === 'operator') return [{ type: 'markEnded', reason: 'operator' }];
  if (supervisor.recovering) return [];
  const crashed = supervisor.exit === 'crashed';

  const alertOnce = (reason: string): SupervisionAction[] =>
    state.lastAlertReason === reason ? [] : [{ type: 'alertOperator', reason }];
  const healthAction = (
    health: SupervisionHealth,
    ticks: number,
    since: string | undefined,
  ): SupervisionAction[] =>
    health === currentHealth && ticks === currentTicks && since === state.undeliverableSince
      ? []
      : [{ type: 'markHealth', health, undeliverableTicks: ticks, ...(since ? { undeliverableSince: since } : {}) }];

  if (!config.actuationAllowed) {
    if (crashed) return [...healthAction('dead', 0, undefined), ...alertOnce('supervisor-dead-wakes-disabled')];
    // Nothing will wake the supervisor: tell the operator once (the playbook falls back to a self-armed timer).
    return alertOnce('wakes-disabled');
  }

  /** Crash-like end: a fresh episode if the budget allows. Too soon waits quietly; the cap alerts once. */
  const recover = (): SupervisionAction[] => {
    const lastRestart = ms(state.lastRestartAt);
    const capped = (state.restartCount ?? 0) >= config.maxRestarts;
    const tooSoon = lastRestart !== undefined && nowMs - lastRestart < config.restartSpacingMs;
    const out = healthAction('dead', 0, undefined);
    if (capped) return [...out, ...alertOnce('restart-limit-reached')];
    if (tooSoon) return out;
    return [...out, { type: 'restartEpisode', cause: 'dead' }];
  };

  const deadlinePassed = nowMs >= (ms(state.deadlineAt) ?? Number.POSITIVE_INFINITY);

  if (crashed) {
    // Nobody to recap to: close the mandate rather than launch a supervisor for it.
    if (deadlinePassed) return [{ type: 'markEnded', reason: 'deadline' }];
    if (supervisor.allTargetsTerminal) return [{ type: 'markEnded', reason: 'targets-terminal' }];
    return recover();
  }

  type Wake = 'heartbeat' | 'deadline' | 'final';
  let wake: Wake | undefined;
  if (deadlinePassed) {
    if (state.deadlineWakeDeliveredAt || state.deadlineWakeAttemptedAt) return [{ type: 'markEnded', reason: 'deadline' }];
    wake = 'deadline';
  } else if (supervisor.allTargetsTerminal) {
    if (state.finalWakeDeliveredAt) return [{ type: 'markEnded', reason: 'targets-terminal' }];
    wake = 'final';
  } else if (nowMs >= nextHeartbeatMs(state, config)) {
    wake = 'heartbeat';
  }

  if (wake === undefined) {
    // A supervisor that was dead and is alive again (a fresh episode) is healthy.
    return currentHealth === 'dead' ? healthAction('healthy', 0, undefined) : [];
  }

  if (supervisor.deliverable) {
    const type = wake === 'heartbeat' ? 'deliverHeartbeat' : wake === 'deadline' ? 'deliverDeadline' : 'deliverFinal';
    return [{ type }];
  }

  // Alive but not at an idle prompt: keep retrying every tick; never restart or cancel it.
  const ticks = currentTicks + 1;
  const since = state.undeliverableSince ?? nowIso;
  const activityMs = ms(supervisor.lastActivityAt);
  const hung = activityMs !== undefined && nowMs - activityMs > config.hungMs;
  const reference = Math.max(ms(state.lastDeliveredAt) ?? 0, ms(state.lastRestartAt) ?? 0, ms(state.createdAt) ?? 0);
  const silent = nowMs - reference > config.heartbeatMs + config.silenceGraceMs;
  const closing = wake === 'heartbeat'
    ? []
    : ([{ type: 'markEnded', reason: wake === 'deadline' ? 'deadline' : 'targets-terminal' }] as SupervisionAction[]);
  if (hung) {
    return [
      ...healthAction('degraded:possibly-hung', ticks, since),
      ...alertOnce('supervisor-possibly-hung'),
      ...closing,
    ];
  }
  if (ticks >= config.undeliverableTicks || silent) return healthAction('degraded:undeliverable', ticks, since);
  return healthAction(currentHealth, ticks, since);
}

/** Next scheduled wake for status output; undefined once ended. */
export function nextWake(
  state: SupervisionState,
  config: PolicyConfig = DEFAULT_POLICY_CONFIG,
): { kind: 'heartbeat' | 'deadline'; at: string } | undefined {
  if (isEnded(state)) return undefined;
  const deadline = ms(state.deadlineAt);
  const heartbeat = nextHeartbeatMs(state, config);
  if (deadline !== undefined && (state.deadlineWakeDeliveredAt === undefined) && deadline <= heartbeat) {
    return { kind: 'deadline', at: state.deadlineAt };
  }
  return { kind: 'heartbeat', at: new Date(heartbeat).toISOString() };
}
