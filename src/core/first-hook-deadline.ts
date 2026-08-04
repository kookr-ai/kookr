/**
 * Post-spawn first-hook deadline (issue #2036).
 *
 * `LaunchTimeoutError` only bounds adapter.spawn (#1528). After a successful
 * spawn, an agent that never emits SessionStart / any first hook can hold a
 * capacity slot until the multi-hour hung-task reaper. This module is the pure
 * eligibility check for a short, post-registration ack deadline: if the
 * watchdog has seen zero agent hooks since `registeredAt`, the session is
 * reclaim-eligible after `deadlineMs`.
 *
 * MCP startup grace composes with this check: when `mcp_startup_starting` was
 * observed and is still within `mcpStartupGracePeriodMs`, the miss is deferred
 * (and in practice that notification also sets `firstHookAt` via
 * {@link Watchdog.recordEvents}, so the miss path is cleared entirely).
 */

/** Default post-registration wait before treating a silent launch as a first-hook miss (3 minutes). */
export const DEFAULT_FIRST_HOOK_DEADLINE_MS = 180_000;

/** Default MCP startup grace window — matches {@link WatchdogConfig.mcpStartupGracePeriodMs}. */
export const DEFAULT_MCP_STARTUP_GRACE_MS = 120_000;

/** Evidence needed for {@link evaluateFirstHookMiss} (subset of watchdog state). */
export interface FirstHookMissEvidence {
  /** Watchdog registration time (ms since epoch). */
  registeredAt: number;
  /**
   * Timestamp of the first agent-originated hook event (ms since epoch).
   * `0` means no real hook has arrived since registration.
   */
  firstHookAt: number;
  /**
   * Timestamp of the most recent `mcp_startup_starting` notification
   * (ms since epoch). `0` = not in MCP startup.
   */
  mcpStartupAt: number;
}

export type FirstHookMissIneligibleReason =
  | 'first_hook_received'
  | 'under_deadline'
  | 'mcp_startup_grace';

export type FirstHookMissVerdict =
  | { eligible: true; waitedMs: number }
  | { eligible: false; reason: FirstHookMissIneligibleReason };

/**
 * Pure eligibility for a first-hook-miss reclaim (issue #2036).
 *
 * Eligible only when:
 * 1. no agent hook has been recorded (`firstHookAt === 0`);
 * 2. wall time since registration is past the deadline;
 * 3. the agent is not inside an active MCP-startup grace window.
 */
export function evaluateFirstHookMiss(
  evidence: FirstHookMissEvidence,
  opts: {
    now: number;
    deadlineMs?: number;
    mcpStartupGracePeriodMs?: number;
  },
): FirstHookMissVerdict {
  if (evidence.firstHookAt > 0) {
    return { eligible: false, reason: 'first_hook_received' };
  }

  const deadlineMs = opts.deadlineMs ?? DEFAULT_FIRST_HOOK_DEADLINE_MS;
  const waitedMs = opts.now - evidence.registeredAt;
  if (waitedMs < deadlineMs) {
    return { eligible: false, reason: 'under_deadline' };
  }

  const mcpGrace = opts.mcpStartupGracePeriodMs ?? DEFAULT_MCP_STARTUP_GRACE_MS;
  if (evidence.mcpStartupAt > 0 && opts.now - evidence.mcpStartupAt < mcpGrace) {
    return { eligible: false, reason: 'mcp_startup_grace' };
  }

  return { eligible: true, waitedMs };
}
