import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRepoStateBatchQuery,
  classifyGitHubRateLimit,
  evaluatePRMergeReadiness,
  isPRGreenAndMergeable,
  parseRepoStateBatchResponse,
} from './github-fetcher.js';
import type { GitHubCheck, GitHubPRState, GitHubReference } from '../core/github-types.js';

afterEach(() => {
  vi.useRealTimers();
});

function ref(type: GitHubReference['type'], number: number): GitHubReference {
  return {
    type,
    owner: 'acme',
    repo: 'app',
    number,
    url: `https://github.com/acme/app/${type === 'pr' ? 'pull' : 'issues'}/${number}`,
    detectedAt: new Date('2026-05-12T00:00:00.000Z'),
    detectedFrom: 'agent-1',
    taskId: 'task-1',
  };
}

function taskRef(type: GitHubReference['type'], number: number, taskId: string): GitHubReference {
  return { ...ref(type, number), taskId };
}

describe('github-fetcher batching helpers', () => {
  it('builds one repository GraphQL query with aliases for all refs', () => {
    const query = buildRepoStateBatchQuery([ref('pr', 42), ref('issue', 7)]);

    expect(query).toContain('repository(owner: $owner, name: $repo)');
    expect(query).toContain('pr_42: pullRequest(number: 42)');
    expect(query).toContain('issue_7: issue(number: 7)');
    expect(query).toContain('mergeable');
    expect(query).toContain('statusCheckRollup');
    expect(query).toContain('reviewThreads(first: 50)');
  });

  it('deduplicates duplicate GitHub objects in the query but parses them for each task ref', () => {
    const task1 = taskRef('pr', 42, 'task-1');
    const task2 = taskRef('pr', 42, 'task-2');
    const query = buildRepoStateBatchQuery([task1, task2]);

    expect(query.match(/pr_42: pullRequest/g)).toHaveLength(1);

    const result = parseRepoStateBatchResponse({
      data: {
        repository: {
          pr_42: {
            title: 'Shared PR',
            state: 'OPEN',
            mergeable: null,
            isDraft: false,
            author: { login: 'alice' },
            headRefName: 'branch',
            baseRefName: 'main',
            reviewDecision: null,
            comments: { totalCount: 0 },
            reviewThreads: { nodes: [] },
            reviews: { nodes: [] },
            commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [] } } } }] },
          },
        },
      },
    }, [task1, task2]);

    expect(result.prs.map((pr) => pr.ref.taskId)).toEqual(['task-1', 'task-2']);
    expect(result.prs.map((pr) => pr.mergeable)).toEqual(['UNKNOWN', 'UNKNOWN']);
  });

  it('parses batched PR and issue state from a single repository response', () => {
    const prRef = ref('pr', 42);
    const issueRef = ref('issue', 7);
    const result = parseRepoStateBatchResponse({
      data: {
        repository: {
          pr_42: {
            title: 'Fix polling',
            state: 'OPEN',
            mergeable: 'CONFLICTING',
            isDraft: false,
            author: { login: 'alice' },
            headRefName: 'fix-polling',
            baseRefName: 'main',
            reviewDecision: 'CHANGES_REQUESTED',
            comments: { totalCount: 3 },
            reviewThreads: {
              nodes: [
                {
                  id: 'thread-1',
                  isResolved: false,
                  comments: {
                    nodes: [
                      {
                        author: { login: 'reviewer' },
                        body: 'Please update this.',
                        path: 'src/file.ts',
                        line: 12,
                        createdAt: '2026-05-12T01:00:00Z',
                      },
                    ],
                  },
                },
              ],
            },
            reviews: {
              nodes: [
                { author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED' },
              ],
            },
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: {
                        nodes: [
                          { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
                          { __typename: 'StatusContext', context: 'lint', state: 'SUCCESS' },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          },
          issue_7: {
            title: 'Original issue',
            state: 'OPEN',
            author: { login: 'bob' },
            labels: { nodes: [{ name: 'bug' }] },
            comments: { totalCount: 5 },
          },
        },
      },
    }, [prRef, issueRef]);

    expect(result.prs).toHaveLength(1);
    expect(result.prs[0]).toMatchObject({
      ref: prRef,
      title: 'Fix polling',
      status: 'open',
      mergeable: 'CONFLICTING',
      author: 'alice',
      branch: 'fix-polling',
      baseBranch: 'main',
      reviewDecision: 'changes_requested',
      totalComments: 3,
      checks: [
        { name: 'test', status: 'completed', conclusion: 'failure' },
        { name: 'lint', status: 'completed', conclusion: 'success' },
      ],
      unresolvedThreads: [
        {
          id: 'thread-1',
          author: 'reviewer',
          body: 'Please update this.',
          path: 'src/file.ts',
          line: 12,
        },
      ],
    });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      ref: issueRef,
      title: 'Original issue',
      status: 'open',
      author: 'bob',
      labels: ['bug'],
      commentCount: 5,
    });
  });

  it('classifies GraphQL RATE_LIMITED errors with a retry window', () => {
    const rateLimit = classifyGitHubRateLimit({
      errors: [
        { type: 'RATE_LIMITED', message: 'API rate limit exceeded. Retry-After: 120' },
      ],
    });

    expect(rateLimit).toEqual({
      kind: 'rate-limited',
      retryAfterMs: 120_000,
      message: 'RATE_LIMITED: API rate limit exceeded. Retry-After: 120',
    });
  });

  it('classifies secondary-rate-limit stderr from gh', () => {
    const rateLimit = classifyGitHubRateLimit(new Error('You have exceeded a secondary rate limit. Retry after 30 seconds.'));

    expect(rateLimit).toEqual({
      kind: 'rate-limited',
      retryAfterMs: 30_000,
      message: 'You have exceeded a secondary rate limit. Retry after 30 seconds.',
    });
  });

  it('uses x-ratelimit-reset for exhausted primary limits', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T00:00:00.000Z'));

    const rateLimit = classifyGitHubRateLimit({
      headers: {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Date.parse('2026-06-18T00:02:00.000Z') / 1000),
      },
    });

    expect(rateLimit).toEqual({
      kind: 'rate-limited',
      retryAfterMs: 120_000,
      message: 'x-ratelimit-remaining: 0',
    });
  });
});

describe('evaluatePRMergeReadiness / isPRGreenAndMergeable (#1148)', () => {
  function check(overrides: Partial<GitHubCheck> = {}): GitHubCheck {
    return { name: 'ci', status: 'completed', conclusion: 'success', ...overrides };
  }

  function pr(overrides: Partial<GitHubPRState> = {}): GitHubPRState {
    return {
      ref: ref('pr', 42),
      title: 'Some PR',
      status: 'open',
      mergeable: 'MERGEABLE',
      author: 'alice',
      branch: 'feature-x',
      baseBranch: 'main',
      reviewDecision: 'approved',
      reviewers: [],
      unresolvedThreads: [],
      totalComments: 0,
      checks: [check()],
      lastFetchedAt: new Date('2026-07-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  it('is green and mergeable when open, MERGEABLE, and all checks completed successfully', () => {
    const readiness = evaluatePRMergeReadiness(pr());
    expect(readiness).toEqual({ mergeable: true, checksGreen: true, pendingChecks: [], failingChecks: [] });
    expect(isPRGreenAndMergeable(pr())).toBe(true);
  });

  it('is green and mergeable with no checks at all', () => {
    expect(isPRGreenAndMergeable(pr({ checks: [] }))).toBe(true);
  });

  it('is not mergeable when GitHub reports CONFLICTING', () => {
    const readiness = evaluatePRMergeReadiness(pr({ mergeable: 'CONFLICTING' }));
    expect(readiness.mergeable).toBe(false);
    expect(isPRGreenAndMergeable(pr({ mergeable: 'CONFLICTING' }))).toBe(false);
  });

  it('is not mergeable when the PR is not open (e.g. draft)', () => {
    expect(isPRGreenAndMergeable(pr({ status: 'draft' }))).toBe(false);
  });

  it('is not checksGreen while a check is still pending', () => {
    const readiness = evaluatePRMergeReadiness(pr({ checks: [check({ name: 'build', status: 'in_progress', conclusion: null })] }));
    expect(readiness.checksGreen).toBe(false);
    expect(readiness.pendingChecks).toEqual(['build']);
    expect(isPRGreenAndMergeable(pr({ checks: [check({ name: 'build', status: 'in_progress', conclusion: null })] }))).toBe(false);
  });

  it('is not checksGreen when a check failed or timed out', () => {
    const readiness = evaluatePRMergeReadiness(pr({
      checks: [check({ name: 'lint', conclusion: 'failure' }), check({ name: 'e2e', conclusion: 'timed_out' })],
    }));
    expect(readiness.checksGreen).toBe(false);
    expect(readiness.failingChecks).toEqual(['lint', 'e2e']);
  });

  it('is checksGreen when checks are neutral/skipped/cancelled but completed', () => {
    const readiness = evaluatePRMergeReadiness(pr({
      checks: [check({ conclusion: 'neutral' }), check({ conclusion: 'skipped' }), check({ conclusion: 'cancelled' })],
    }));
    expect(readiness.checksGreen).toBe(true);
  });
});
