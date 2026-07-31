export type AgentStatus =
  | 'starting'
  | 'running'
  | 'stuck'
  | 'errored'
  | 'completed'
  | 'snoozed';

export type TaskStatus =
  | 'open'
  | 'pending'
  | 'inProgress'
  | 'completed'
  | 'terminated'
  | 'cancelled';

export function isTerminalStatus(s: TaskStatus): boolean {
  switch (s) {
    case 'completed':
    case 'terminated':
    case 'cancelled':
      return true;
    case 'open':
    case 'pending':
    case 'inProgress':
      return false;
  }
}

export function isActiveStatus(s: TaskStatus): boolean {
  return !isTerminalStatus(s);
}

/**
 * Why a task ended in `status: terminated`. Recorded on the task so an operator
 * (or the recovery path) can tell "killed by a restart, should resume" apart
 * from "hit a fatal condition, leave it dead". See issue #1664.
 *
 * - `server-restart` — the launcher died with the previous process (boot sweep).
 * - `oom`            — killed by the out-of-memory killer.
 * - `timeout`        — reaped for exceeding a silence/hang threshold.
 * - `manual`         — an operator terminated it deliberately.
 * - `supervisor`     — a supervisor/batch controller swept it.
 * - `provider_transient` — the terminal turn made zero tool calls and its final
 *                      message was a provider/transport error (`529 Overloaded`,
 *                      `API Error`, 429/5xx, rate limit). Reclassified from a
 *                      would-be `completed` so a silent no-op never masks a
 *                      failure (issue #1712). Schedule-provenance failures of
 *                      this reason are auto-retried by the completion path, so
 *                      the crash-recovery relaunch must NOT also resume them.
 * - `unknown`        — all sessions died without positive clean-finish evidence
 *                      (a likely crash whose precise cause could not be classified).
 */
export type TerminationReason =
  | 'server-restart'
  | 'oom'
  | 'timeout'
  | 'manual'
  | 'supervisor'
  | 'provider_transient'
  | 'unknown';

/**
 * Structured cause passed to `terminateTask`. `signal` is the killing OS signal
 * when known (e.g. `SIGKILL`); `detail` is a short free-text note for operators.
 */
export interface TerminationCause {
  reason: TerminationReason;
  signal?: string;
  detail?: string;
}

/**
 * Whether a termination with this reason is a candidate for automatic resume.
 * Restart / OOM / timeout are transient global events that should re-spawn the
 * dropped work; `unknown` is a likely crash and is also resumable (the existing
 * crash-recovery relaunch guard bounds retries). `manual` and `supervisor` are
 * deliberate kills and must NOT auto-resume. `provider_transient` owns its own
 * bounded schedule retry in the completion path (issue #1712), so the
 * crash-recovery relaunch must leave it alone to avoid double-recovery. See
 * issue #1664.
 */
export function isRecoverableTermination(reason: TerminationReason | undefined): boolean {
  switch (reason) {
    case 'server-restart':
    case 'oom':
    case 'timeout':
    case 'unknown':
    case undefined:
      return true;
    case 'manual':
    case 'supervisor':
    case 'provider_transient':
      return false;
  }
}

/**
 * Current turn state of a live interactive agent, derived from its event
 * window. This is deliberately separate from {@link TaskStatus}: a task can
 * stay `inProgress` (the terminal process is alive and accepts follow-ups)
 * while its agent's current turn is `completed_turn` — idle after a normal
 * `Stop`, not actively running and not hung. See issue #358.
 */
export type TurnState =
  | 'running' // actively executing the current turn (tool calls / reasoning)
  | 'waiting_for_input' // explicitly asked the user a question mid-turn
  | 'completed_turn' // emitted a normal Stop with a final answer; awaiting follow-up
  | 'blocked' // hard-blocked (permission request or API error killed the turn)
  | 'unknown'; // no events yet or indeterminate
