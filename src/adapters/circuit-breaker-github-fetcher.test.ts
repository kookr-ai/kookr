import { afterEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreakerGitHubFetcher } from './circuit-breaker-github-fetcher.js';
import { CircuitBreaker } from '../core/circuit-breaker.js';
import type {
  GitHubFetchBatchResult,
  GitHubFetcher,
  GitHubIssueState,
  GitHubPRState,
  GitHubReference,
} from '../core/github-types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function makeRef(type: GitHubReference['type'], number: number): GitHubReference {
  return {
    type,
    owner: 'kookr-ai',
    repo: 'kookr',
    number,
    url: `https://github.com/kookr-ai/kookr/${type === 'pr' ? 'pull' : 'issues'}/${number}`,
    detectedAt: new Date('2026-07-02T00:00:00.000Z'),
    detectedFrom: 'agent-1',
    taskId: 'task-1',
  };
}

function makePRState(ref: GitHubReference): GitHubPRState {
  return {
    ref,
    title: `PR ${ref.number}`,
    status: 'open',
    mergeable: 'MERGEABLE',
    author: 'alice',
    branch: `branch-${ref.number}`,
    baseBranch: 'main',
    reviewDecision: null,
    reviewers: [],
    unresolvedThreads: [],
    totalComments: 0,
    checks: [],
    lastFetchedAt: new Date('2026-07-02T00:00:00.000Z'),
  };
}

function makeIssueState(ref: GitHubReference): GitHubIssueState {
  return {
    ref,
    title: `Issue ${ref.number}`,
    status: 'open',
    author: 'bob',
    labels: [],
    commentCount: 0,
    lastFetchedAt: new Date('2026-07-02T00:00:00.000Z'),
  };
}

function makeInner(overrides: Partial<GitHubFetcher> = {}): GitHubFetcher {
  return {
    isAvailable: vi.fn(async () => true),
    inferOwnerRepo: vi.fn(async () => ({ owner: 'kookr-ai', repo: 'kookr' })),
    fetchPRState: vi.fn(async (ref: GitHubReference) => makePRState(ref)),
    fetchIssueState: vi.fn(async (ref: GitHubReference) => makeIssueState(ref)),
    fetchStates: vi.fn(async (refs: GitHubReference[]) => ({
      prs: refs.filter((ref) => ref.type === 'pr').map(makePRState),
      issues: refs.filter((ref) => ref.type === 'issue').map(makeIssueState),
    })),
    ...overrides,
  };
}

function makeBreaker(): CircuitBreaker {
  return new CircuitBreaker({
    name: 'github-test',
    failureThreshold: 1,
    resetTimeoutMs: 60_000,
  });
}

function openBreaker(breaker: CircuitBreaker): void {
  breaker.recordFailure();
  expect(breaker.getState()).toBe('open');
}

describe('CircuitBreakerGitHubFetcher', () => {
  it('passes fetch calls through a closed breaker when inner batch fetching exists', async () => {
    const prRef = makeRef('pr', 42);
    const issueRef = makeRef('issue', 7);
    const expectedBatch: GitHubFetchBatchResult = {
      prs: [makePRState(prRef)],
      issues: [makeIssueState(issueRef)],
    };
    const inner = makeInner({
      fetchPRState: vi.fn(async (ref) => {
        expect(ref).toBe(prRef);
        return makePRState(ref);
      }),
      fetchIssueState: vi.fn(async (ref) => {
        expect(ref).toBe(issueRef);
        return makeIssueState(ref);
      }),
      fetchStates: vi.fn(async (refs) => {
        expect(refs).toEqual([prRef, issueRef]);
        return expectedBatch;
      }),
    });
    const breaker = makeBreaker();
    const fetcher = new CircuitBreakerGitHubFetcher(inner, breaker);

    await expect(fetcher.fetchPRState(prRef)).resolves.toMatchObject({ ref: prRef });
    await expect(fetcher.fetchIssueState(issueRef)).resolves.toMatchObject({ ref: issueRef });
    await expect(fetcher.fetchStates([prRef, issueRef])).resolves.toBe(expectedBatch);

    expect(inner.fetchPRState).toHaveBeenCalledTimes(1);
    expect(inner.fetchIssueState).toHaveBeenCalledTimes(1);
    expect(inner.fetchStates).toHaveBeenCalledTimes(1);
    breaker.dispose();
  });

  it('returns degraded values without calling the inner fetcher when the breaker is open', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prRef = makeRef('pr', 42);
    const issueRef = makeRef('issue', 7);
    const inner = makeInner();
    const breaker = makeBreaker();
    openBreaker(breaker);
    const fetcher = new CircuitBreakerGitHubFetcher(inner, breaker);

    await expect(fetcher.fetchPRState(prRef)).resolves.toBeNull();
    await expect(fetcher.fetchIssueState(issueRef)).resolves.toBeNull();
    await expect(fetcher.fetchStates([prRef, issueRef])).resolves.toEqual({ prs: [], issues: [] });

    expect(inner.fetchPRState).not.toHaveBeenCalled();
    expect(inner.fetchIssueState).not.toHaveBeenCalled();
    expect(inner.fetchStates).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(3);
    breaker.dispose();
  });

  it('fans out fetchStates through per-ref fetches when the inner fetcher has no batch method', async () => {
    const pr1 = makeRef('pr', 1);
    const issue2 = makeRef('issue', 2);
    const pr3 = makeRef('pr', 3);
    const inner = makeInner({
      fetchStates: undefined,
      fetchPRState: vi.fn(async (ref) => {
        expect([pr1, pr3]).toContain(ref);
        return ref.number === 1 ? makePRState(ref) : null;
      }),
      fetchIssueState: vi.fn(async (ref) => {
        expect(ref).toBe(issue2);
        return makeIssueState(ref);
      }),
    });
    const breaker = makeBreaker();
    const fetcher = new CircuitBreakerGitHubFetcher(inner, breaker);

    await expect(fetcher.fetchStates([pr1, issue2, pr3])).resolves.toEqual({
      prs: [makePRState(pr1)],
      issues: [makeIssueState(issue2)],
    });

    expect(inner.fetchPRState).toHaveBeenNthCalledWith(1, pr1);
    expect(inner.fetchPRState).toHaveBeenNthCalledWith(2, pr3);
    expect(inner.fetchIssueState).toHaveBeenCalledExactlyOnceWith(issue2);
    breaker.dispose();
  });

  it('keeps partial fallback results when a per-ref failure opens the breaker mid-loop', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pr1 = makeRef('pr', 1);
    const issue2 = makeRef('issue', 2);
    const pr3 = makeRef('pr', 3);
    const inner = makeInner({
      fetchStates: undefined,
      fetchPRState: vi.fn(async (ref) => {
        expect(ref).toBe(pr1);
        return makePRState(ref);
      }),
      fetchIssueState: vi.fn(async (ref) => {
        expect(ref).toBe(issue2);
        throw new Error('upstream failed');
      }),
    });
    const breaker = makeBreaker();
    const fetcher = new CircuitBreakerGitHubFetcher(inner, breaker);

    await expect(fetcher.fetchStates([pr1, issue2, pr3])).resolves.toEqual({
      prs: [makePRState(pr1)],
      issues: [],
    });

    expect(breaker.getState()).toBe('open');
    expect(inner.fetchPRState).toHaveBeenCalledExactlyOnceWith(pr1);
    expect(inner.fetchIssueState).toHaveBeenCalledExactlyOnceWith(issue2);
    expect(warnSpy).toHaveBeenCalledExactlyOnceWith(
      '[github] Circuit breaker open — skipping PR fetch for kookr-ai/kookr#3',
    );
    breaker.dispose();
  });

  it('bypasses the breaker for availability and repository inference', async () => {
    const inner = makeInner({
      isAvailable: vi.fn(async () => false),
      inferOwnerRepo: vi.fn(async (cwd) => {
        expect(cwd).toBe('/repo');
        return { owner: 'owner', repo: 'repo' };
      }),
    });
    const breaker = makeBreaker();
    const callSpy = vi.spyOn(breaker, 'call');
    const fetcher = new CircuitBreakerGitHubFetcher(inner, breaker);

    await expect(fetcher.isAvailable()).resolves.toBe(false);
    await expect(fetcher.inferOwnerRepo('/repo')).resolves.toEqual({ owner: 'owner', repo: 'repo' });

    expect(callSpy).not.toHaveBeenCalled();
    expect(inner.isAvailable).toHaveBeenCalledOnce();
    expect(inner.inferOwnerRepo).toHaveBeenCalledExactlyOnceWith('/repo');
    breaker.dispose();
  });

  it('opens the breaker when batched fetchStates throws (issue #1940)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prRef = makeRef('pr', 42);
    const issueRef = makeRef('issue', 7);
    const batchError = new AggregateError(
      [new Error('repo a failed'), new Error('repo b failed')],
      'Failed to fetch GitHub state for all 2 repo group(s)',
    );
    const inner = makeInner({
      fetchStates: vi.fn(async () => {
        throw batchError;
      }),
    });
    const breaker = makeBreaker();
    const fetcher = new CircuitBreakerGitHubFetcher(inner, breaker);

    // Wrapper degrades to empty batch; breaker still records the failure.
    await expect(fetcher.fetchStates([prRef, issueRef])).resolves.toEqual({ prs: [], issues: [] });
    expect(breaker.getState()).toBe('open');
    expect(inner.fetchStates).toHaveBeenCalledTimes(1);

    // Subsequent call is short-circuited by the open breaker.
    await expect(fetcher.fetchStates([prRef, issueRef])).resolves.toEqual({ prs: [], issues: [] });
    expect(inner.fetchStates).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[github] Circuit breaker open — skipping batched fetch for 2 references',
    );
    breaker.dispose();
  });
});
