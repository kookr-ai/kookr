/**
 * Test fixture: the production delivered-PR resolver over a real
 * `GitHubStateStore` holding one merged PR, so reaper and sweep tests exercise
 * the real attribution rules (issues #3678, #3983) instead of a fake
 * `resolveMergedPr`.
 */
import { GitHubStateStore } from '../../core/github-state-store.js';
import type { GitHubReference } from '../../core/github-types.js';
import type { MergedPrAttribution } from '../../core/completion/index.js';
import type { Task } from '../../core/tasks.js';
import { createStoreDeliveredPrResolver } from '../delivered-task-completion-sweep.js';
import type { DeliveryBranches } from '../pr-delivery-tracker.js';

export interface MergedPrFixture {
  /** The task the PR reference was detected for (from its own activity). */
  task: Pick<Task, 'id' | 'createdAt'>;
  prNumber: number;
  /** Head branch of the PR. Default `feat/<task id>`. */
  branch?: string;
  /** Base branch of the PR. Default `main`. */
  baseBranch?: string;
  /** What the delivery tracker knows about the repository's branches. Default: nothing. */
  branches?: DeliveryBranches;
  /** Task ids whose own `git push` reported updating the PR's head branch. */
  pushedBy?: string[];
}

export const FIXTURE_OWNER = 'kookr-ai';
export const FIXTURE_REPO = 'kookr';

/** A resolver plus the store behind it, with one PR opened and merged after the task was created. */
export function storeResolverWithMergedPr(fx: MergedPrFixture): {
  store: GitHubStateStore;
  resolveMergedPr: (task: Task) => MergedPrAttribution | null;
} {
  const store = new GitHubStateStore();
  const createdAtMs = new Date(fx.task.createdAt).getTime();
  const url = `https://github.com/${FIXTURE_OWNER}/${FIXTURE_REPO}/pull/${fx.prNumber}`;
  const ref: GitHubReference = {
    type: 'pr',
    owner: FIXTURE_OWNER,
    repo: FIXTURE_REPO,
    number: fx.prNumber,
    url,
    detectedAt: new Date(createdAtMs + 60_000),
    detectedFrom: `kookr-${fx.task.id}`,
    taskId: fx.task.id,
  };
  store.addReference(ref);
  const branch = fx.branch ?? `feat/${fx.task.id}`;
  store.updatePRState({
    ref,
    title: 'fixture PR',
    status: 'merged',
    mergeable: 'MERGEABLE',
    author: 'someone',
    branch,
    baseBranch: fx.baseBranch ?? 'main',
    reviewDecision: 'approved',
    reviewers: [],
    unresolvedThreads: [],
    totalComments: 0,
    checks: [],
    createdAt: new Date(createdAtMs + 60_000),
    mergedAt: new Date(createdAtMs + 120_000),
    lastFetchedAt: new Date(createdAtMs + 180_000),
  });
  for (const taskId of fx.pushedBy ?? []) {
    store.recordAuthorship(taskId, {
      pushedBranches: [{ owner: FIXTURE_OWNER, repo: FIXTURE_REPO, branch }],
      createdPrs: [],
    });
  }
  return { store, resolveMergedPr: createStoreDeliveredPrResolver(store, () => fx.branches) };
}
