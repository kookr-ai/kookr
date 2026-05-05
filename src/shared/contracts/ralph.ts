export type RalphLoopStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface RalphZeroDiffConvergenceConfig {
  consecutiveIterations: number;
}

export interface RalphLoopState {
  prompt: string;
  iterationCap: number;
  stopPredicate?: string;
  zeroDiffConvergence?: RalphZeroDiffConvergenceConfig;
  costCapUsd?: number;
  zeroDiffStreak?: number;
  currentIteration: number;
  status: RalphLoopStatus;
  lastIterationStartedAt: number;
  lastHandledStopFingerprint?: string;
  handlingStopFingerprint?: string;
  ownerSessionId?: string;
  ownerRuntimeSessionId?: string;
  ownerTranscriptPath?: string;
  cumulativeIterations: number;
}

export interface RalphLoopReadModel {
  prompt: string;
  status: RalphLoopStatus;
}
