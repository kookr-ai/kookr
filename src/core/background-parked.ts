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

/** Trailing characters that can close a question without being part of it: whitespace, markdown emphasis, quotes, brackets. */
const TRAILING_CLOSER = /[\s*_"'”’)\]]/u;

/**
 * True when an assistant message ends in a question — `?` (or the full-width
 * `？`) as the last character once trailing whitespace, markdown emphasis,
 * quotes and closing brackets are stripped. Deliberately the same crude
 * signal the production measurement used (issue #3569): of 976 silent parked
 * turns only 8 ended in `?`, and 6 of those were ended by an operator prompt,
 * so the tail alone is a high-precision "waiting on a human" signal.
 */
export function endsWithOperatorQuestion(message: string | undefined): boolean {
  if (!message) return false;
  // Scan back from the end instead of an unanchored `[…]+$` regex: that form
  // retries from every position in a long closer run (quadratic), and
  // `lastMessage` is uncapped and re-evaluated on every snapshot.
  let i = message.length - 1;
  while (i >= 0 && TRAILING_CLOSER.test(message[i])) i--;
  return i >= 0 && (message[i] === '?' || message[i] === '？');
}

/** The last `max` characters of a message (where a question tail lives), ellipsised when cut. */
export function messageTail(message: string, max = 100): string {
  return message.length > max ? `…${message.slice(-max)}` : message;
}

/** A `stop` event as read by {@link isSilentBackgroundPark}. */
export interface ParkedStop extends BackgroundParkCounts {
  lastMessage?: string;
}

/**
 * True when a parked Stop should suppress attention signals (`needs_input`,
 * `stale_agent`): the agent is parked on its own background work AND did not
 * end its turn asking the operator something. A question-park — typically an
 * agent kept parked by a long-lived heartbeat/watch shell that just asked
 * "Shall I go ahead?" — is genuinely waiting on a human, so it still flags
 * `needs_input` (issue #3569).
 *
 * Attention-only: turn state (`turn-state.ts`) and clean-finish detection keep
 * using {@link isBackgroundParked}, because the background work IS still
 * running and a question-park is not a clean end of turn. The event path
 * (`anomaly-detector.ts#detectNeedsInput`) and the watchdog park
 * (`watchdog.ts`) both call this so they cannot drift.
 */
export function isSilentBackgroundPark(stop: ParkedStop): boolean {
  return isBackgroundParked(stop) && !endsWithOperatorQuestion(stop.lastMessage);
}
