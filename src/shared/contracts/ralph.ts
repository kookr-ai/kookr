import type { RalphIterationExitReason } from './ralph-iteration-log.js';

export type RalphLoopStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Why a terminated loop needs a human rather than an automatic relaunch.
 *
 *   - `budget_exhausted` — a cost cap was hit (`cost_cap` / `iteration_cost_cap`);
 *     relaunching would only burn more budget.
 *   - `relaunch_exhausted` — the loop was relaunched up to its configured
 *     terminal-relaunch cap without ever reaching a clean stop; something is
 *     structurally stuck and a human should look.
 */
export type RalphNeedsHumanReason = 'budget_exhausted' | 'relaunch_exhausted';

/**
 * Explicit "needs-human" escalation attached to a terminated loop (issue #1901
 * / WS2.3 of #1699). A budget-exhausted loop (`cost_cap` / `iteration_cost_cap`)
 * used to land in `status: 'completed'` and stop silently — indistinguishable
 * from a clean success. This field is the visible marker the terminal-relaunch
 * policy sets so the dashboard can surface such a loop instead of treating it as
 * done. Present only after a terminal exit the policy escalated; cleared on
 * relaunch.
 */
export interface RalphLoopNeedsHuman {
  /** Why the loop needs a human rather than an automatic relaunch. */
  reason: RalphNeedsHumanReason;
  /** The terminal exit reason that triggered the escalation. */
  exitReason: RalphIterationExitReason;
  /** Epoch ms the loop entered the needs-human state. */
  since: number;
  /** Operator-facing one-line explanation of what to check. */
  detail: string;
}

export interface RalphZeroDiffConvergenceConfig {
  consecutiveIterations: number;
}

export interface RalphStallConfig {
  consecutiveStallsPerTarget?: number;
  loopShape?: 'single-target' | 'multi-target';
  consecutiveStallsForSingleTargetTermination?: number;
  declaredTargets?: string[];
  burnedTargetDecayIterations?: number;
  iterationCostCapUsd?: number;
  consecutiveIterationCostCapHits?: number;
}

export interface BurnedOutTarget {
  target: string;
  consecutiveStallCount: number;
  totalStallCount: number;
  firstStalledAtIteration: number;
  lastStallReason: string;
  lastStallBlockers: string[];
  burned: boolean;
  permanent?: boolean;
  lastAttemptedIteration: number;
}

export interface RalphLoopState {
  prompt: string;
  iterationCap: number;
  stopPredicate?: string;
  stallPredicate?: string;
  zeroDiffConvergence?: RalphZeroDiffConvergenceConfig;
  costCapUsd?: number;
  zeroDiffStreak?: number;
  currentIteration: number;
  status: RalphLoopStatus;
  lastIterationStartedAt: number;
  lastHandledStopFingerprint?: string;
  handlingStopFingerprint?: string;
  ownerSessionId?: string;
  cumulativeIterations: number;
  stallConfig?: RalphStallConfig;
  burnedOutTargets?: BurnedOutTarget[];
  consecutiveIterationCostCapStreak?: number;
  lastCumulativeCostUsd?: number;
  verdictWarningCount?: number;
  iterationCostWarningCount?: number;
  lastVerdictWarningReason?: string;
  /**
   * Set by the terminal-relaunch policy (issue #1901) when a terminated loop
   * was escalated to a human (e.g. budget exhausted) rather than relaunched.
   * Surfaced through the task snapshot so the state is visible, not silent.
   */
  needsHuman?: RalphLoopNeedsHuman;
  /**
   * Cumulative count of automatic terminal relaunches performed by the
   * relaunch policy (issue #1901). Bounds runaway relaunch: once it reaches the
   * configured cap the loop escalates to `needsHuman` (`relaunch_exhausted`)
   * instead of re-arming again. Preserved across re-arms (not reset with
   * `currentIteration`).
   */
  terminalRelaunchCount?: number;
}

export interface RalphLoopReadModel {
  prompt: string;
  status: RalphLoopStatus;
}

/** Defaults for `RalphStallConfig`. See rfc-ralph-loop-stall-handling.md §3. */
export const DEFAULT_STALL_CONFIG: Required<Pick<RalphStallConfig,
  'consecutiveStallsPerTarget'
  | 'loopShape'
  | 'consecutiveStallsForSingleTargetTermination'
  | 'consecutiveIterationCostCapHits'
>> = {
  consecutiveStallsPerTarget: 2,
  loopShape: 'single-target',
  consecutiveStallsForSingleTargetTermination: 3,
  consecutiveIterationCostCapHits: 2,
};

/**
 * Merge operator-supplied stallConfig with defaults so callers see effective
 * values. Used by API responses and the cycler. Optional fields without
 * defaults (declaredTargets, burnedTargetDecayIterations, iterationCostCapUsd)
 * stay undefined when not supplied.
 */
export function resolveStallConfig(cfg: RalphStallConfig | undefined): RalphStallConfig & typeof DEFAULT_STALL_CONFIG {
  return {
    ...DEFAULT_STALL_CONFIG,
    ...(cfg ?? {}),
  };
}
