export type RalphLoopStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

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
