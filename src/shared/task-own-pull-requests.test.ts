import { describe, expect, it } from 'vitest';
import { splitOwnPullRequests, type OwnPullRequestCandidate } from './task-own-pull-requests.js';

type Pr = OwnPullRequestCandidate & { n: number };

function pr(n: number, branch: string, createdAt: Date | string | undefined, detectedFrom = 'kookr-agent'): Pr {
  return { n, branch, createdAt, ref: { detectedFrom } };
}

const TASK_CREATED = '2026-11-16T12:00:00.000Z';
const nums = (list: Pr[]) => list.map((p) => p.n);

describe('splitOwnPullRequests (#4024)', () => {
  it('takes the PR on the task branch as its own, and only that one', () => {
    const prs = [pr(1, 'other', '2026-11-16T13:00:00Z'), pr(2, 'feat-x', '2026-11-16T13:00:00Z')];
    const { own, mentioned } = splitOwnPullRequests(prs, { branch: 'feat-x', createdAt: TASK_CREATED });
    expect(nums(own)).toEqual([2]);
    // A later PR on another branch is only mentioned once the branch matched.
    expect(nums(mentioned)).toEqual([1]);
  });

  it('falls back to PRs opened since the task was created when no PR is on the task branch', () => {
    // The session branch is the launch checkout's; the agent pushed from its own worktree.
    const prs = [pr(1, 'old-work', '2026-11-16T11:59:59Z'), pr(2, 'feat-y', '2026-11-16T12:00:00Z'), pr(3, 'feat-z', new Date('2026-11-16T14:00:00Z'))];
    const { own, mentioned } = splitOwnPullRequests(prs, { branch: 'launch-checkout-branch', createdAt: TASK_CREATED });
    expect(nums(own)).toEqual([2, 3]);
    expect(nums(mentioned)).toEqual([1]);
  });

  it('uses the creation time when the branch is unknown', () => {
    const prs = [pr(1, 'feat', '2026-11-16T13:00:00Z')];
    expect(nums(splitOwnPullRequests(prs, { branch: null, createdAt: TASK_CREATED }).own)).toEqual([1]);
    expect(nums(splitOwnPullRequests(prs, { branch: '  ', createdAt: TASK_CREATED }).own)).toEqual([1]);
  });

  it('never counts a PR cited in the prompt, even on the task branch', () => {
    const prs = [pr(1, 'feat-x', '2026-11-16T13:00:00Z', 'prompt')];
    const { own, mentioned } = splitOwnPullRequests(prs, { branch: 'feat-x', createdAt: TASK_CREATED });
    expect(own).toEqual([]);
    expect(nums(mentioned)).toEqual([1]);
  });

  it('counts nothing as own when an opening time or the task creation time is missing or invalid', () => {
    const prs = [pr(1, 'feat', undefined), pr(2, 'feat', 'not a date')];
    expect(splitOwnPullRequests(prs, { createdAt: TASK_CREATED }).own).toEqual([]);
    expect(splitOwnPullRequests([pr(3, 'feat', '2026-11-16T13:00:00Z')], { createdAt: undefined }).own).toEqual([]);
  });

  it('keeps the original order in both lists', () => {
    const prs = [pr(1, 'a', '2026-11-16T13:00:00Z'), pr(2, 'b', '2026-11-16T10:00:00Z'), pr(3, 'c', '2026-11-16T15:00:00Z')];
    const { own, mentioned } = splitOwnPullRequests(prs, { createdAt: TASK_CREATED });
    expect(nums(own)).toEqual([1, 3]);
    expect(nums(mentioned)).toEqual([2]);
  });
});
