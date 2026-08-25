import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { AutonomousReviewReflectionStore } from './autonomous-review-reflection.js';

const observation = (unitId: string) => ({
  unitId,
  iterations: 1,
  cap: 10,
  truePositives: 1,
  falsePositives: 0,
  defectsInEvaluationSet: 1,
  defectsFound: 1,
  reviewerWasFresh: true,
  blindEvaluation: true,
  heldOutEvaluation: true,
  verdictBoundToCurrentHead: true,
  reviewWasPerformed: true,
  mergeAllowed: true,
  predictedConfidence: 1,
  outcomeCorrect: true,
});

describe('AutonomousReviewReflectionStore', () => {
  test('persists observations, deduplicates sweeps, and triggers at five units', async () => {
    const root = await mkdtemp(join(tmpdir(), 'review-reflection-'));
    const store = new AutonomousReviewReflectionStore(root);
    let decision;
    for (let index = 0; index < 5; index++) decision = await store.record(observation(`unit-${index}`));
    expect(decision?.due).toBe(true);
    expect(decision?.mutationEligible).toBe(true);
    const repeated = await store.record(observation('unit-4'));
    expect(repeated.metrics.sampleSize).toBe(5);
  });
});
