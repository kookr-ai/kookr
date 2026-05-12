import { describe, expect, it } from 'vitest';
import { buildRepoStateBatchQuery, parseRepoStateBatchResponse } from './github-fetcher.js';
import type { GitHubReference } from '../core/github-types.js';

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
});
