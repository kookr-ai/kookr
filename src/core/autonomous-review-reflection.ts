import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { atomicWriteFile, readJsonFile } from './persistence-utils.js';
import {
  assessReviewReflection,
  type ReviewLoopObservation,
  type ReviewReflectionDecision,
} from './autonomous-review-policy.js';

const REFLECTION_STATE_VERSION = 1 as const;
const MAX_OBSERVATIONS = 500;

interface ReflectionState {
  version: typeof REFLECTION_STATE_VERSION;
  completedUnits: number;
  lastReflectionUnit: number;
  observations: ReviewLoopObservation[];
  lastDecision?: ReviewReflectionDecision;
}

function emptyState(): ReflectionState {
  return { version: REFLECTION_STATE_VERSION, completedUnits: 0, lastReflectionUnit: 0, observations: [] };
}

/** Durable observer and bounded trigger for reviewer-quality reflection. */
export class AutonomousReviewReflectionStore {
  private readonly path: string;

  constructor(kookrDir: string) {
    this.path = join(kookrDir, 'autonomous-review-reflection.json');
  }

  async record(observation: ReviewLoopObservation): Promise<ReviewReflectionDecision> {
    const state = await readJsonFile<ReflectionState>(this.path, emptyState());
    const observations = Array.isArray(state.observations) ? state.observations : [];
    const key = this.observationKey(observation);
    const alreadyRecorded = observations.some((candidate) => this.observationKey(candidate) === key);
    if (!alreadyRecorded) {
      observations.push(observation);
      if (observations.length > MAX_OBSERVATIONS) observations.splice(0, observations.length - MAX_OBSERVATIONS);
      state.completedUnits = Math.max(0, state.completedUnits ?? 0) + 1;
    }
    const decision = assessReviewReflection(observations, state.completedUnits, state.lastReflectionUnit ?? 0);
    if (decision.due) state.lastReflectionUnit = state.completedUnits;
    state.version = REFLECTION_STATE_VERSION;
    state.observations = observations;
    state.lastDecision = decision;
    await mkdir(dirname(this.path), { recursive: true });
    await atomicWriteFile(this.path, JSON.stringify(state, null, 2));
    return decision;
  }

  private observationKey(observation: ReviewLoopObservation): string {
    return [observation.unitId, observation.iterations, observation.verdictBoundToCurrentHead ? 'head' : 'stale'].join(':');
  }
}
