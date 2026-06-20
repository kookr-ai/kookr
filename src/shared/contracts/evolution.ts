export type EvolutionTrialOutcome = 'baseline' | 'promoted' | 'neutral' | 'regressed' | 'failed';

export const EVOLUTION_TRIAL_OUTCOMES: EvolutionTrialOutcome[] = [
  'baseline',
  'promoted',
  'neutral',
  'regressed',
  'failed',
];

export interface EvolutionChampionRecord {
  score: number | null;
  metrics?: Record<string, string | number | boolean | null>;
  artifactRef?: string;
  iteration?: number;
  promotedAt?: string;
  runId?: string;
}

export interface EvolutionTrialRecord {
  iteration?: number;
  outcome: EvolutionTrialOutcome;
  score?: number;
  delta?: number;
  metrics?: Record<string, string | number | boolean | null>;
  notes?: string;
  durationMs?: number;
  costUsd?: number;
  evaluatedAt?: string;
}

export interface EvolutionTrajectoryPoint {
  iteration: number;
  score: number;
  outcome: EvolutionTrialOutcome;
}

export interface EvolutionRunProjection {
  champion: EvolutionChampionRecord | null;
  bestScore: number | null;
  outcomeCounts: Record<EvolutionTrialOutcome, number>;
  trajectory: EvolutionTrajectoryPoint[];
  stopReason: string | null;
  trialCount: number;
  malformedTrialLines: number;
}
