/**
 * Shared predicate: is a Stop event the agent *parking itself* on its own
 * still-running background work, rather than a genuine end-of-turn?
 *
 * The Claude Code Stop hook reports `background_tasks` / `session_crons`; a
 * non-zero count means the agent ended its turn only to wait on a
 * `run_in_background` shell or a scheduled wakeup that will re-invoke it — it
 * is NOT idle and NOT waiting on the operator.
 *
 * This lived inline in `turn-state.ts` (which got it right) while
 * `anomaly-detector.ts` was blind to it and minted a spurious `needs_input`
 * on every Stop — the root cause of "Kookr pinged me while an agent was just
 * sleeping for 20 minutes". Extracting one predicate keeps the two decision
 * sites from drifting again (RFC: rfc-telegram-attention-notifications, R3).
 */

/** The subset of a `stop` event this predicate reads. */
export interface BackgroundParkCounts {
  activeBackgroundTaskCount?: number;
  activeSessionCronCount?: number;
}

/**
 * True when the agent ended its turn parked on its own background work
 * (a `run_in_background` shell or a session cron). Absent counts read as 0,
 * matching `turn-state.ts`'s long-standing behavior.
 */
export function isBackgroundParked(stop: BackgroundParkCounts): boolean {
  return (stop.activeBackgroundTaskCount ?? 0) > 0 || (stop.activeSessionCronCount ?? 0) > 0;
}
