/**
 * Where a pull request's change is, once a repository merges through an
 * integration branch and the integration train (issue #3915, part of #3788).
 *
 * The four stages, in the operator's words:
 * - `pr-open`: the PR is open. It will be merged into the integration branch.
 * - `in-staging`: merged into the integration branch; the train has not
 *   verified it yet, so `main` does not have it.
 * - `on-main`: `main` contains the merge commit (the train verified and
 *   promoted it, or the PR was merged straight into `main`: `skippedTrain`).
 * - `reverted`: the train's full suite failed on it and the train reverted it.
 *
 * Absent (no `delivery` on the PR) when the repository has no integration
 * branch, the PR was closed unmerged, or the server cannot tell yet (for
 * example the merge commit is not fetched locally).
 */
export type PrDeliveryStage = 'pr-open' | 'in-staging' | 'on-main' | 'reverted';

export interface PrDeliveryRevert {
  /** The train's revert commit on the integration branch. */
  revertCommit: string;
  /** Automatic re-land number (1-based) of the fix task the train spawned, when known. */
  attempt?: number;
  /** The train's limit on automatic re-lands. */
  maxAttempts?: number;
  /** Idempotency key of the fix task, e.g. `train-fix-issue-3915-2-1a2b3c4d5e` (issue, attempt, culprit SHA prefix). */
  fixTaskKey?: string;
  /** True when no fix task is running: the budget is used up or the spawn failed. */
  needsHuman: boolean;
  /** Failing test lines from the train's verify log of the reverted commit (at most a few). */
  failingTests: string[];
}

export interface PrDeliveryState {
  stage: PrDeliveryStage;
  /** The integration branch the repository merges into (for example `staging`). */
  integrationBranch: string;
  /** ISO time the PR was opened, when known. */
  openedAt?: string;
  /** ISO time the PR was merged (into the integration branch, or into `main` when it skipped the train). */
  mergedAt?: string;
  /** ISO time `main` was first seen containing the change, when known. */
  onMainAt?: string;
  /** ISO time of the train's revert commit. */
  revertedAt?: string;
  /** The PR was merged straight into `main`, not through the integration branch. */
  mergedIntoMain?: boolean;
  /** Merged straight into `main` after the integration branch was configured (implies `mergedIntoMain`). */
  skippedTrain?: boolean;
  revert?: PrDeliveryRevert;
}
