import { describe, test, expect } from 'vitest';
import type {
  GitHubPRState,
  GitHubIssueState,
  GitHubReference,
} from './github-types.js';
import { diffPRState, diffIssueState } from './github-state-differ.js';

function makeRef(number = 42): GitHubReference {
  return {
    type: 'pr',
    owner: 'kookr-ai',
    repo: 'kookr',
    number,
    url: `https://github.com/kookr-ai/kookr/pull/${number}`,
    detectedAt: new Date(),
    detectedFrom: 'agent-1',
    taskId: 'task-1',
  };
}

function makeBasePR(overrides: Partial<GitHubPRState> = {}): GitHubPRState {
  return {
    ref: makeRef(),
    title: 'Test PR',
    status: 'open',
    author: 'jeanibarz',
    branch: 'feat-test',
    baseBranch: 'main',
    reviewDecision: null,
    reviewers: [],
    unresolvedThreads: [],
    totalComments: 0,
    checks: [],
    lastFetchedAt: new Date(),
    ...overrides,
  };
}

describe('diffPRState', () => {
  test('first fetch with no issues returns empty changes', () => {
    const current = makeBasePR();
    const changes = diffPRState(null, current);
    expect(changes).toHaveLength(0);
  });

  test('first fetch with CI failure reports it', () => {
    const current = makeBasePR({
      checks: [{ name: 'CI', status: 'completed', conclusion: 'failure' }],
    });
    const changes = diffPRState(null, current);
    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe('ci_failed');
  });

  test('first fetch with changes_requested reports it', () => {
    const current = makeBasePR({
      reviewDecision: 'changes_requested',
      reviewers: [{ login: 'reviewer', state: 'changes_requested' }],
    });
    const changes = diffPRState(null, current);
    expect(changes.some((c) => c.type === 'review_requested_changes')).toBe(true);
  });

  test('first fetch with unresolved threads reports them', () => {
    const current = makeBasePR({
      unresolvedThreads: [{
        id: 't1', isResolved: false, author: 'reviewer',
        body: 'Please fix this', path: 'src/foo.ts', line: 10, createdAt: '2026-03-25',
      }],
    });
    const changes = diffPRState(null, current);
    expect(changes.some((c) => c.type === 'new_unresolved_thread')).toBe(true);
  });

  test('detects PR merged', () => {
    const prev = makeBasePR({ status: 'open' });
    const current = makeBasePR({ status: 'merged' });
    const changes = diffPRState(prev, current);
    expect(changes.some((c) => c.type === 'pr_merged')).toBe(true);
  });

  test('detects PR closed', () => {
    const prev = makeBasePR({ status: 'open' });
    const current = makeBasePR({ status: 'closed' });
    const changes = diffPRState(prev, current);
    expect(changes.some((c) => c.type === 'pr_closed')).toBe(true);
  });

  test('detects new CI failure', () => {
    const prev = makeBasePR({
      checks: [{ name: 'CI', status: 'completed', conclusion: 'success' }],
    });
    const current = makeBasePR({
      checks: [
        { name: 'CI', status: 'completed', conclusion: 'success' },
        { name: 'Lint', status: 'completed', conclusion: 'failure' },
      ],
    });
    const changes = diffPRState(prev, current);
    const ciFailed = changes.find((c) => c.type === 'ci_failed');
    expect(ciFailed).toBeDefined();
    if (ciFailed?.type === 'ci_failed') {
      expect(ciFailed.check.name).toBe('Lint');
    }
  });

  test('detects CI passing after failure', () => {
    const prev = makeBasePR({
      checks: [{ name: 'CI', status: 'completed', conclusion: 'failure' }],
    });
    const current = makeBasePR({
      checks: [{ name: 'CI', status: 'completed', conclusion: 'success' }],
    });
    const changes = diffPRState(prev, current);
    expect(changes.some((c) => c.type === 'ci_passed')).toBe(true);
  });

  test('detects review decision change to changes_requested', () => {
    const prev = makeBasePR({ reviewDecision: null });
    const current = makeBasePR({
      reviewDecision: 'changes_requested',
      reviewers: [{ login: 'reviewer', state: 'changes_requested' }],
    });
    const changes = diffPRState(prev, current);
    expect(changes.some((c) => c.type === 'review_requested_changes')).toBe(true);
  });

  test('detects review approval', () => {
    const prev = makeBasePR({ reviewDecision: 'review_required' });
    const current = makeBasePR({
      reviewDecision: 'approved',
      reviewers: [{ login: 'reviewer', state: 'approved' }],
    });
    const changes = diffPRState(prev, current);
    expect(changes.some((c) => c.type === 'review_approved')).toBe(true);
  });

  test('detects new unresolved threads', () => {
    const prev = makeBasePR({ unresolvedThreads: [] });
    const current = makeBasePR({
      unresolvedThreads: [{
        id: 't1', isResolved: false, author: 'reviewer',
        body: 'Fix this', createdAt: '2026-03-25',
      }],
    });
    const changes = diffPRState(prev, current);
    expect(changes.some((c) => c.type === 'new_unresolved_thread')).toBe(true);
  });

  test('does not re-report existing threads', () => {
    const thread = {
      id: 't1', isResolved: false, author: 'reviewer',
      body: 'Fix this', createdAt: '2026-03-25',
    };
    const prev = makeBasePR({ unresolvedThreads: [thread] });
    const current = makeBasePR({ unresolvedThreads: [thread] });
    const changes = diffPRState(prev, current);
    expect(changes.filter((c) => c.type === 'new_unresolved_thread')).toHaveLength(0);
  });

  test('detects new comments by count increase', () => {
    const prev = makeBasePR({ totalComments: 2 });
    const current = makeBasePR({ totalComments: 4 });
    const changes = diffPRState(prev, current);
    expect(changes.some((c) => c.type === 'new_comment')).toBe(true);
  });

  test('no changes when state is identical', () => {
    const state = makeBasePR();
    const changes = diffPRState(state, { ...state });
    expect(changes).toHaveLength(0);
  });
});

describe('diffIssueState', () => {
  const ref: GitHubReference = {
    type: 'issue', owner: 'kookr-ai', repo: 'kookr', number: 16,
    url: 'https://github.com/kookr-ai/kookr/issues/16',
    detectedAt: new Date(), detectedFrom: 'agent-1', taskId: 'task-1',
  };

  function makeIssue(overrides: Partial<GitHubIssueState> = {}): GitHubIssueState {
    return {
      ref, title: 'Test Issue', status: 'open', author: 'jeanibarz',
      labels: [], commentCount: 0, lastFetchedAt: new Date(),
      ...overrides,
    };
  }

  test('first fetch returns no changes', () => {
    const changes = diffIssueState(null, makeIssue());
    expect(changes).toHaveLength(0);
  });

  test('detects new comments', () => {
    const prev = makeIssue({ commentCount: 1 });
    const current = makeIssue({ commentCount: 3 });
    const changes = diffIssueState(prev, current);
    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe('new_comment');
  });

  test('no changes when comment count unchanged', () => {
    const state = makeIssue({ commentCount: 5 });
    const changes = diffIssueState(state, { ...state });
    expect(changes).toHaveLength(0);
  });
});
