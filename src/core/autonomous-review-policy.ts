/** Shared policy for autonomous correction/review loops. */
export const DEFAULT_AUTONOMOUS_REVIEW_ITERATION_CAP = 10;
export const MIN_AUTONOMOUS_REVIEW_ITERATION_CAP = 1;
export const MAX_AUTONOMOUS_REVIEW_ITERATION_CAP = 20;

/** Reflection is periodic, but fewer iterations alone never count as success. */
export const DEFAULT_REVIEW_REFLECTION_INTERVAL_UNITS = 5;
export const MIN_REVIEW_REFLECTION_SAMPLE_SIZE = 5;

export type IterationCapSource = 'default' | 'configured';

export interface ResolvedIterationCap {
  cap: number;
  source: IterationCapSource;
}

export function resolveAutonomousReviewIterationCap(configured?: number): ResolvedIterationCap {
  if (configured === undefined) return { cap: DEFAULT_AUTONOMOUS_REVIEW_ITERATION_CAP, source: 'default' };
  if (!Number.isInteger(configured)
    || configured < MIN_AUTONOMOUS_REVIEW_ITERATION_CAP
    || configured > MAX_AUTONOMOUS_REVIEW_ITERATION_CAP) {
    throw new Error(
      `autonomous review iteration cap must be an integer between ${MIN_AUTONOMOUS_REVIEW_ITERATION_CAP} and ${MAX_AUTONOMOUS_REVIEW_ITERATION_CAP}`,
    );
  }
  return { cap: configured, source: 'configured' };
}

export function iterationBudgetExhausted(iterations: number, cap: number): boolean {
  return iterations >= cap;
}

export interface ReviewLoopObservation {
  unitId: string;
  iterations: number;
  cap: number;
  truePositives: number;
  falsePositives: number;
  defectsInEvaluationSet: number;
  defectsFound: number;
  reviewerWasFresh: boolean;
  /** Quality evidence came from a blind evaluation unavailable to the mutator. */
  blindEvaluation: boolean;
  /** Quality evidence was held out from reviewer/prompt tuning. */
  heldOutEvaluation: boolean;
  verdictBoundToCurrentHead: boolean;
  reviewWasPerformed: boolean;
  mergeAllowed: boolean;
  predictedConfidence?: number;
  outcomeCorrect?: boolean;
}

export interface ReviewQualityMetrics {
  sampleSize: number;
  meanIterations: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  freshReviewRate: number;
  blindEvaluationRate: number;
  heldOutEvaluationRate: number;
  exactHeadBindingRate: number;
  reviewCoverage: number;
  safeMergeRate: number;
  calibrationError: number | null;
}

/** Compute balanced quality metrics; iteration count is only one observation. */
export function computeReviewQualityMetrics(
  observations: readonly ReviewLoopObservation[],
): ReviewQualityMetrics {
  const sampleSize = observations.length;
  const tp = observations.reduce((sum, row) => sum + row.truePositives, 0);
  const fp = observations.reduce((sum, row) => sum + row.falsePositives, 0);
  const defects = observations.reduce((sum, row) => sum + row.defectsInEvaluationSet, 0);
  const found = observations.reduce((sum, row) => sum + row.defectsFound, 0);
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = defects === 0 ? null : Math.min(1, found / defects);
  const f1 = precision === null || recall === null || precision + recall === 0
    ? null
    : (2 * precision * recall) / (precision + recall);
  const calibrationRows = observations.filter((row) => row.predictedConfidence !== undefined && row.outcomeCorrect !== undefined);
  const calibrationError = calibrationRows.length === 0 ? null : calibrationRows.reduce(
    (sum, row) => sum + Math.abs(row.predictedConfidence! - (row.outcomeCorrect ? 1 : 0)),
    0,
  ) / calibrationRows.length;
  return {
    sampleSize,
    meanIterations: sampleSize === 0 ? 0 : observations.reduce((sum, row) => sum + row.iterations, 0) / sampleSize,
    precision,
    recall,
    f1,
    freshReviewRate: sampleSize === 0 ? 0 : observations.filter((row) => row.reviewerWasFresh).length / sampleSize,
    blindEvaluationRate: sampleSize === 0 ? 0 : observations.filter((row) => row.blindEvaluation).length / sampleSize,
    heldOutEvaluationRate: sampleSize === 0 ? 0 : observations.filter((row) => row.heldOutEvaluation).length / sampleSize,
    exactHeadBindingRate: sampleSize === 0 ? 0 : observations.filter((row) => row.verdictBoundToCurrentHead).length / sampleSize,
    reviewCoverage: sampleSize === 0 ? 0 : observations.filter((row) => row.reviewWasPerformed).length / sampleSize,
    safeMergeRate: sampleSize === 0 ? 0 : observations.filter((row) => row.mergeAllowed && row.reviewWasPerformed && row.verdictBoundToCurrentHead).length / sampleSize,
    calibrationError,
  };
}

export interface ReviewReflectionDecision {
  due: boolean;
  reason: string;
  mutationEligible: boolean;
  metrics: ReviewQualityMetrics;
}

/**
 * Trigger a bounded reflection. Mutation requires blind/held-out evidence and
 * complete review safety signals, so lower iteration count cannot reward a
 * reviewer that skipped, timed out, or weakened its gate.
 */
export function assessReviewReflection(
  observations: readonly ReviewLoopObservation[],
  completedUnits: number,
  lastReflectionUnit: number,
  intervalUnits = DEFAULT_REVIEW_REFLECTION_INTERVAL_UNITS,
): ReviewReflectionDecision {
  if (!Number.isInteger(intervalUnits) || intervalUnits < 1) throw new Error('reflection interval must be a positive integer');
  const metrics = computeReviewQualityMetrics(observations);
  const due = completedUnits - lastReflectionUnit >= intervalUnits;
  const enoughEvidence = metrics.sampleSize >= MIN_REVIEW_REFLECTION_SAMPLE_SIZE
    && metrics.reviewCoverage === 1
    && metrics.freshReviewRate === 1
    && metrics.blindEvaluationRate === 1
    && metrics.heldOutEvaluationRate === 1
    && metrics.exactHeadBindingRate === 1
    && metrics.safeMergeRate === 1
    && metrics.calibrationError !== null
    && metrics.calibrationError <= 0.2
    && metrics.f1 !== null;
  return {
    due,
    reason: due
      ? enoughEvidence
        ? 'periodic reflection due with blind-quality evidence'
        : 'periodic reflection due; collect blind-quality evidence before mutation'
      : 'reflection interval not reached',
    mutationEligible: due && enoughEvidence,
    metrics,
  };
}
