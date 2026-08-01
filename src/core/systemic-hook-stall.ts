/**
 * Systemic hook-pipeline stall suppressor (issue #1464 first-slice continuation).
 *
 * When the hook pipeline stalls globally (server restart, relay backlog, a CLI
 * that stopped emitting hooks), every active agent goes hook-silent within a
 * tick or two. Minting one `hook_disconnected` finding per agent is pure noise
 * — a single infra event surfaces as N false positives. Field data showed two
 * distinct agents flagged `hook_disconnected` 17s apart, both ~200s silent;
 * the user flagged both as false positives.
 *
 * This module owns only the pure verdict-window signal and the suppress
 * decision. Callers (Monitor) own queue purge, detection-stats, and
 * finding-evidence audit side effects.
 *
 * The signal counts recent *verdicts*, not currently-queued entries. Counting
 * queued entries oscillated: the guard purged the queue, which reset the
 * count below threshold, which re-admitted the next agent's finding ~1s
 * later — an endless admit→purge limit cycle that surfaced a rotating
 * one-second finding (and dashboard chime) for every hook-silent agent.
 */

/**
 * Minimum number of distinct agents producing `hook_disconnected` verdicts
 * within {@link SYSTEMIC_HOOK_STALL_WINDOW_MS} for the monitor to treat the
 * silence as a systemic hook-pipeline stall rather than a per-agent fault.
 */
export const SYSTEMIC_HOOK_STALL_MIN_AGENTS = 2;

/**
 * How long a `hook_disconnected` verdict keeps counting toward the systemic
 * hook-stall signal. Must span several watchdog ticks (5s in production) so
 * agents whose verdicts alternate between `hook_disconnected` and
 * `stale_agent` (pane sometimes frozen) stay counted while the stall lasts.
 */
export const SYSTEMIC_HOOK_STALL_WINDOW_MS = 60_000;

/** Suppression reason tag written into detection-stats / evidence audit notes. */
export const SYSTEMIC_HOOK_STALL_REASON = 'systemic_hook_stall' as const;

/**
 * Pure tracker for the systemic hook-stall correlation signal.
 *
 * Records raw (pre-suppression) `hook_disconnected` verdict timestamps per
 * agent and answers whether a candidate finding should be suppressed as
 * systemic. No I/O, no detection-stats, no queue mutation.
 */
export class SystemicHookStallTracker {
  /**
   * Last time each agent produced a `hook_disconnected` watchdog verdict
   * (raw, pre-suppression). Entries older than
   * {@link SYSTEMIC_HOOK_STALL_WINDOW_MS} are pruned lazily on read.
   */
  private verdictAt = new Map<string, number>();

  /**
   * Record that `agentId` just produced a raw `hook_disconnected` verdict.
   * Call before applying suppression so the signal reflects what the watchdog
   * observed, not what survived other suppressors.
   */
  recordVerdict(agentId: string, now: number = Date.now()): void {
    this.verdictAt.set(agentId, now);
  }

  /**
   * Drop one agent's contribution (agent teardown). Idempotent.
   */
  clear(agentId: string): void {
    this.verdictAt.delete(agentId);
  }

  /**
   * Count distinct agents that produced a `hook_disconnected` verdict within
   * the last {@link SYSTEMIC_HOOK_STALL_WINDOW_MS}. Prunes expired entries as
   * it goes. Unaffected by queue purge, so the signal cannot oscillate.
   */
  countRecent(now: number = Date.now()): number {
    let count = 0;
    for (const [agentId, at] of this.verdictAt) {
      if (now - at > SYSTEMIC_HOOK_STALL_WINDOW_MS) {
        this.verdictAt.delete(agentId);
        continue;
      }
      count += 1;
    }
    return count;
  }

  /**
   * Whether a finding of `anomalyType` should be suppressed as a systemic
   * hook-pipeline stall right now. Only `hook_disconnected` is eligible, and
   * only when ≥ {@link SYSTEMIC_HOOK_STALL_MIN_AGENTS} agents have recent
   * raw verdicts in the window.
   */
  shouldSuppress(anomalyType: string, now: number = Date.now()): boolean {
    if (anomalyType !== 'hook_disconnected') return false;
    return this.countRecent(now) >= SYSTEMIC_HOOK_STALL_MIN_AGENTS;
  }
}
