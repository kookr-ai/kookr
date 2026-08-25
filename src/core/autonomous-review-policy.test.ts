import { describe, expect, test } from 'vitest';
import {
  DEFAULT_AUTONOMOUS_REVIEW_ITERATION_CAP,
  assessReviewReflection,
  computeReviewQualityMetrics,
  iterationBudgetExhausted,
  resolveAutonomousReviewIterationCap,
} from './autonomous-review-policy.js';

const observation = (overrides: Partial<Parameters<typeof computeReviewQualityMetrics>[0][number]> = {}) => ({
  unitId: 'unit-1',
  iterations: 2,
  cap: DEFAULT_AUTONOMOUS_REVIEW_ITERATION_CAP,
  truePositives: 1,
  falsePositives: 0,
  defectsInEvaluationSet: 1,
  defectsFound: 1,
  reviewerWasFresh: true,
  verdictBoundToCurrentHead: true,
  reviewWasPerformed: true,
    mergeAllowed: true,
    predictedConfidence: 1,
    outcomeCorrect: true,
  ...overrides,
});

describe('autonomous review policy', () => {
  test('defaults to ten and allows a deliberate explicit override', () => {
    expect(resolveAutonomousReviewIterationCap()).toEqual({ cap: 10, source: 'default' });
    expect(resolveAutonomousReviewIterationCap(3)).toEqual({ cap: 3, source: 'configured' });
  });

  test('budget exhaustion is inclusive and cannot be bypassed by a timeout', () => {
    expect(iterationBudgetExhausted(9, 10)).toBe(false);
    expect(iterationBudgetExhausted(10, 10)).toBe(true);
    expect(iterationBudgetExhausted(11, 10)).toBe(true);
  });

  test('reflection reports balanced metrics, not iteration count alone', () => {
    const metrics = computeReviewQualityMetrics([
      observation({ iterations: 1 }),
      observation({ iterations: 3, falsePositives: 1 }),
    ]);
    expect(metrics.meanIterations).toBe(2);
    expect(metrics.precision).toBeCloseTo(2 / 3);
    expect(metrics.recall).toBe(1);
    expect(metrics.f1).not.toBeNull();
  });

  test('periodic reflection requires blind complete quality evidence before mutation', () => {
    const blocked = assessReviewReflection(
      [observation({ iterations: 1, reviewWasPerformed: false })],
      5,
      0,
    );
    expect(blocked.due).toBe(true);
    expect(blocked.mutationEligible).toBe(false);
    expect(blocked.reason).toMatch(/blind-quality evidence/);

    const enough = Array.from({ length: 5 }, (_, index) => observation({ unitId: `unit-${index}` }));
    expect(assessReviewReflection(enough, 5, 0).mutationEligible).toBe(true);
    expect(assessReviewReflection(enough, 4, 0).due).toBe(false);
  });

  test('timeout, missing review, stale head, and unsafe merge cannot earn safe-merge credit', () => {
    const metrics = computeReviewQualityMetrics([
      observation({ reviewWasPerformed: false, verdictBoundToCurrentHead: false, mergeAllowed: true }),
    ]);
    expect(metrics.safeMergeRate).toBe(0);
    expect(metrics.reviewCoverage).toBe(0);
    expect(metrics.exactHeadBindingRate).toBe(0);
  });
});
