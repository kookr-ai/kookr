/**
 * Precision telemetry for the `waiting_on_input` stuck-flag (issue #1653).
 *
 * The flag repeatedly fired against actively-working agents during the
 * 2026-07-27/28 dogfooding night (~25% precision on that sample), each false
 * alarm disproven by a pane capture showing a live spinner / running shell in
 * the same minute. The liveness cross-check in `deriveStuckReason` now
 * suppresses those, but the fix is only trustworthy if it is *measurable*: this
 * module counts, over the process lifetime,
 *
 *  - `flags`      — how many needs_input episodes actually surfaced as
 *                   `waiting_on_input`, and
 *  - `suppressed` — how many were withheld because the agent showed
 *                   hook / pane / token activity within the liveness grace
 *                   window (the would-be false positives).
 *
 * Precision is `flags / (flags + suppressed)` — before the cross-check every
 * `suppressed` episode was a `flags` episode, so a rising `suppressed` count is
 * the fix doing its job.
 *
 * **Edge-triggered per agent.** The recording site (`attachStuckReason`) runs
 * once per task *per REST projection*, i.e. on every poll of `GET /api/tasks`.
 * Counting each projection would make the ratio a function of poll frequency and
 * how long an agent dwells flagged-vs-suppressed, not a true per-event precision.
 * So `recordWaitingOnInputOutcome` counts only a *transition* into a flagged or
 * suppressed outcome for a given agent — one tick per contiguous episode — and
 * `clearWaitingOnInputTracking` resets an agent's memory when it leaves the
 * needs_input state, so a later re-entry counts as a fresh episode.
 *
 * Process-local (reset on restart, like the pre-hydration detection-stats
 * counters were); a future PR can persist it alongside `detection-stats` if
 * cross-restart accuracy tracking is wanted.
 */
export interface StuckFlagPrecisionStats {
  /** needs_input episodes that surfaced as `waiting_on_input`. */
  flags: number;
  /**
   * needs_input episodes withheld because a liveness channel moved within the
   * grace window — the would-be false positives (issue #1653).
   */
  suppressed: number;
}

export type WaitingOnInputOutcome = 'flag' | 'suppressed';

/** Bound the per-agent dedup memory; diagnostic-only, so a rare overflow reset is harmless. */
const MAX_TRACKED_AGENTS = 1000;

const stats: StuckFlagPrecisionStats = { flags: 0, suppressed: 0 };
const lastOutcomeByAgent = new Map<string, WaitingOnInputOutcome>();

/** Snapshot of the counters plus the derived precision ratio (null until any flag/suppression). */
export function getStuckFlagPrecision(): StuckFlagPrecisionStats & { precision: number | null } {
  const total = stats.flags + stats.suppressed;
  return {
    flags: stats.flags,
    suppressed: stats.suppressed,
    precision: total === 0 ? null : stats.flags / total,
  };
}

/**
 * Record the outcome of a needs_input episode for `agentId`. Edge-triggered:
 * a repeated identical outcome (the same agent polled again while still in the
 * same state) is a no-op, so the counters track distinct episodes, not polls.
 */
export function recordWaitingOnInputOutcome(agentId: string, outcome: WaitingOnInputOutcome): void {
  if (lastOutcomeByAgent.get(agentId) === outcome) return;
  if (!lastOutcomeByAgent.has(agentId) && lastOutcomeByAgent.size >= MAX_TRACKED_AGENTS) {
    // Overflow guard: drop the dedup memory wholesale. Counters are preserved;
    // at worst the currently-tracked agents re-count one episode each.
    lastOutcomeByAgent.clear();
  }
  lastOutcomeByAgent.set(agentId, outcome);
  if (outcome === 'flag') stats.flags++;
  else stats.suppressed++;
}

/**
 * Forget an agent's last outcome so its next needs_input episode is counted
 * fresh. Called when an agent is no longer in the needs_input state (or its
 * task is no longer inProgress).
 */
export function clearWaitingOnInputTracking(agentId: string): void {
  lastOutcomeByAgent.delete(agentId);
}

/** Reset the counters and per-agent memory (tests). */
export function resetStuckFlagPrecision(): void {
  stats.flags = 0;
  stats.suppressed = 0;
  lastOutcomeByAgent.clear();
}
