import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import type { GitHubReference } from '../core/github-types.js';

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  execFilePromisified: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => {
  const execFile = childProcessMocks.execFile as typeof childProcessMocks.execFile & {
    [promisify.custom]?: typeof childProcessMocks.execFilePromisified;
  };
  execFile[promisify.custom] = childProcessMocks.execFilePromisified;
  return {
    execFile,
    spawn: childProcessMocks.spawn,
  };
});

const {
  fetchBatchRepoHealth,
  fetchStates,
  resetFetchStateFailureThrottleForTests,
} = await import('./github-fetcher.js');

afterEach(() => {
  vi.useRealTimers();
  resetFetchStateFailureThrottleForTests();
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

function mockGhSpawn(stdout: string): void {
  childProcessMocks.spawn.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write: vi.fn(),
      end: vi.fn(() => {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from(stdout));
          child.emit('close', 0);
        });
      }),
    };
    child.kill = vi.fn();
    return child;
  });
}

function mockGhSpawnFailure(stdout: string, stderr: string): void {
  childProcessMocks.spawn.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write: vi.fn(),
      end: vi.fn(() => {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from(stdout));
          child.stderr.emit('data', Buffer.from(stderr));
          child.emit('close', 1);
        });
      }),
    };
    child.kill = vi.fn();
    return child;
  });
}

function mockGhSpawnOnce(result: { stdout?: string; stderr?: string; code: number }): void {
  childProcessMocks.spawn.mockImplementationOnce(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      write: vi.fn(),
      end: vi.fn(() => {
        queueMicrotask(() => {
          if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
          if (result.stderr) child.stderr.emit('data', Buffer.from(result.stderr));
          child.emit('close', result.code);
        });
      }),
    };
    child.kill = vi.fn();
    return child;
  });
}

function includeResponse(headers: string, body: unknown): string {
  return `${headers.trim()}\n\n${JSON.stringify(body)}`;
}

describe('github-fetcher rate-limit handoff', () => {
  beforeEach(() => {
    childProcessMocks.execFile.mockReset();
    childProcessMocks.execFilePromisified.mockReset();
    childProcessMocks.spawn.mockReset();
  });

  it('returns a batched state rateLimit when GraphQL reports RATE_LIMITED', async () => {
    childProcessMocks.execFilePromisified.mockResolvedValue({
      stdout: JSON.stringify({
        errors: [
          { type: 'RATE_LIMITED', message: 'API rate limit exceeded. Retry-After: 90' },
        ],
      }),
      stderr: '',
    });

    const result = await fetchStates([ref('issue', 7)]);

    expect(result).toEqual({
      prs: [],
      issues: [],
      rateLimit: {
        kind: 'rate-limited',
        retryAfterMs: 90_000,
        message: 'RATE_LIMITED: API rate limit exceeded. Retry-After: 90',
      },
    });
  });

  it('retries transient gh exec failures before returning batched state', async () => {
    vi.useFakeTimers();
    childProcessMocks.execFilePromisified
      .mockRejectedValueOnce(new Error('HTTP 500: Internal Server Error'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: {
              issue_7: {
                title: 'Recovered issue',
                state: 'OPEN',
                author: { login: 'alice' },
                labels: { nodes: [] },
                comments: { totalCount: 0 },
              },
            },
          },
        }),
        stderr: '',
      });

    const resultPromise = fetchStates([ref('issue', 7)]);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].title).toBe('Recovered issue');
    expect(childProcessMocks.execFilePromisified).toHaveBeenCalledTimes(2);
  });

  it('does not retry gh exec failures that are rate limits', async () => {
    const err = Object.assign(new Error('You have exceeded a secondary rate limit. Retry-After: 45'), {
      stderr: 'You have exceeded a secondary rate limit. Retry-After: 45',
    });
    childProcessMocks.execFilePromisified.mockRejectedValue(err);

    const result = await fetchStates([ref('issue', 7)]);

    expect(result.rateLimit).toEqual({
      kind: 'rate-limited',
      retryAfterMs: 45_000,
      message: 'You have exceeded a secondary rate limit. Retry-After: 45',
    });
    expect(childProcessMocks.execFilePromisified).toHaveBeenCalledTimes(1);
  });

  it('stops batched state fetching after the first rate-limited repo group', async () => {
    childProcessMocks.execFilePromisified
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          errors: [
            { type: 'RATE_LIMITED', message: 'API rate limit exceeded. Retry-After: 30' },
          ],
        }),
        stderr: '',
      })
      .mockRejectedValueOnce(new Error('should not fetch another repo while rate-limited'));

    const otherRepo = { ...ref('issue', 8), owner: 'octo', repo: 'widgets' };
    const result = await fetchStates([ref('issue', 7), otherRepo]);

    expect(result.rateLimit).toEqual({
      kind: 'rate-limited',
      retryAfterMs: 30_000,
      message: 'RATE_LIMITED: API rate limit exceeded. Retry-After: 30',
    });
    expect(childProcessMocks.execFilePromisified).toHaveBeenCalledTimes(1);
  });

  it('classifies rejected gh stderr as a batched state rateLimit', async () => {
    const err = Object.assign(new Error('gh exited 1'), {
      stderr: 'You have exceeded a secondary rate limit. Retry-After: 45',
    });
    childProcessMocks.execFilePromisified.mockRejectedValue(err);

    const result = await fetchStates([ref('issue', 7)]);

    expect(result.rateLimit).toEqual({
      kind: 'rate-limited',
      retryAfterMs: 45_000,
      message: 'You have exceeded a secondary rate limit. Retry-After: 45',
    });
  });

  it('uses included stdout headers when state GraphQL exits non-zero', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T00:00:00.000Z'));
    const err = Object.assign(new Error('gh exited 1: GraphQL: API rate limit exceeded'), {
      stdout: includeResponse(`
HTTP/2.0 200 OK
x-ratelimit-remaining: 0
x-ratelimit-reset: ${Date.parse('2026-06-18T00:05:00.000Z') / 1000}
`, {
        errors: [
          { type: 'RATE_LIMITED', message: 'API rate limit exceeded' },
        ],
      }),
      stderr: 'gh: API rate limit exceeded',
    });
    childProcessMocks.execFilePromisified.mockRejectedValue(err);

    const result = await fetchStates([ref('issue', 7)]);

    expect(result.rateLimit).toEqual({
      kind: 'rate-limited',
      retryAfterMs: 300_000,
      message: 'gh exited 1: GraphQL: API rate limit exceeded',
    });
  });

  it('uses included state response headers for primary-rate-limit reset time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T00:00:00.000Z'));
    childProcessMocks.execFilePromisified.mockResolvedValue({
      stdout: includeResponse(`
HTTP/2.0 200 OK
x-ratelimit-remaining: 0
x-ratelimit-reset: ${Date.parse('2026-06-18T00:03:00.000Z') / 1000}
`, { data: { repository: null } }),
      stderr: '',
    });

    const result = await fetchStates([ref('issue', 7)]);

    expect(result.rateLimit).toEqual({
      kind: 'rate-limited',
      retryAfterMs: 180_000,
      message: 'x-ratelimit-remaining: 0',
    });
    expect(childProcessMocks.execFilePromisified).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['graphql', '--include']),
      expect.any(Object),
    );
  });

  it('applies successful state data before backing off on exhausted primary limit headers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T00:00:00.000Z'));
    childProcessMocks.execFilePromisified.mockResolvedValue({
      stdout: includeResponse(`
HTTP/2.0 200 OK
x-ratelimit-remaining: 0
x-ratelimit-reset: ${Date.parse('2026-06-18T00:07:00.000Z') / 1000}
`, {
        data: {
          repository: {
            issue_7: {
              title: 'Last successful issue',
              state: 'OPEN',
              author: { login: 'alice' },
              labels: { nodes: [] },
              comments: { totalCount: 0 },
            },
          },
        },
      }),
      stderr: '',
    });

    const result = await fetchStates([ref('issue', 7)]);

    expect(result.issues).toMatchObject([
      { title: 'Last successful issue', status: 'open', author: 'alice' },
    ]);
    expect(result.rateLimit).toEqual({
      kind: 'rate-limited',
      retryAfterMs: 420_000,
      message: 'x-ratelimit-remaining: 0',
    });
  });

  it('rethrows when every repo group fails a non-rate-limit error (issue #1940)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    childProcessMocks.execFilePromisified.mockRejectedValue(
      new Error('Could not resolve to a Repository with the name acme/app'),
    );

    const otherRepo = { ...ref('issue', 8), owner: 'octo', repo: 'widgets' };
    await expect(fetchStates([ref('issue', 7), otherRepo])).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AggregateError);
      const aggregate = err as AggregateError;
      expect(aggregate.message).toMatch(/all 2 repo group/);
      expect(aggregate.errors).toHaveLength(2);
      return true;
    });

    expect(errorSpy).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });

  it('returns partial results when some repo groups succeed (issue #1940)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const successBody = {
      data: {
        repository: {
          issue_7: {
            title: 'Partial success',
            state: 'OPEN',
            author: { login: 'alice' },
            labels: { nodes: [] },
            comments: { totalCount: 0 },
          },
        },
      },
    };
    childProcessMocks.execFilePromisified
      .mockResolvedValueOnce({ stdout: JSON.stringify(successBody), stderr: '' })
      .mockRejectedValueOnce(new Error('Could not resolve to a Repository with the name octo/widgets'));

    const otherRepo = { ...ref('issue', 8), owner: 'octo', repo: 'widgets' };
    const result = await fetchStates([ref('issue', 7), otherRepo]);

    expect(result.issues).toMatchObject([{ title: 'Partial success', status: 'open' }]);
    expect(result.prs).toEqual([]);
    expect(result.rateLimit).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('throttles repeated per-repo failure logs with a running count (issue #1940)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    childProcessMocks.execFilePromisified.mockRejectedValue(
      new Error('Could not resolve to a Repository with the name acme/app'),
    );

    for (let i = 0; i < 10; i++) {
      await expect(fetchStates([ref('issue', 7)])).rejects.toBeInstanceOf(AggregateError);
    }

    // Logged on 1st and 10th consecutive failure only.
    expect(errorSpy).toHaveBeenCalledTimes(2);
    expect(errorSpy.mock.calls[0]![0]).toBe(
      'Failed to fetch GitHub state batch for acme/app:',
    );
    expect(errorSpy.mock.calls[1]![0]).toBe(
      'Failed to fetch GitHub state batch for acme/app (x10):',
    );
    errorSpy.mockRestore();
  });

  it('returns a repo-health rateLimit from GraphQL errors', async () => {
    mockGhSpawn(JSON.stringify({
      errors: [
        { type: 'RATE_LIMITED', message: 'API rate limit exceeded. Retry-After: 75' },
      ],
    }));

    const result = await fetchBatchRepoHealth([
      { projectId: 'github.com/acme/app', owner: 'acme', repo: 'app' },
    ], 'alice');

    expect(result).toEqual({
      kind: 'rate-limited',
      retryAfterMs: 75_000,
      message: 'RATE_LIMITED: API rate limit exceeded. Retry-After: 75',
    });
  });

  it('retries transient gh spawn failures before returning repo health', async () => {
    vi.useFakeTimers();
    mockGhSpawnOnce({ code: 1, stderr: 'HTTP 500: Internal Server Error' });
    mockGhSpawnOnce({
      code: 0,
      stdout: JSON.stringify({
        data: {
          r0: {
            nameWithOwner: 'acme/app',
            openIssues: { totalCount: 4 },
            openPRs: { totalCount: 1 },
          },
          s0: { nodes: [] },
        },
      }),
    });

    const resultPromise = fetchBatchRepoHealth([
      { projectId: 'github.com/acme/app', owner: 'acme', repo: 'app' },
    ], 'alice');
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await resultPromise;

    expect(result && result instanceof Map ? result.get('github.com/acme/app') : null).toMatchObject({
      openIssues: 4,
      openPullRequests: 1,
    });
    expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2);
  });

  it('uses included repo-health response headers for primary-rate-limit reset time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T00:00:00.000Z'));
    mockGhSpawn(includeResponse(`
HTTP/2.0 200 OK
x-ratelimit-remaining: 0
x-ratelimit-reset: ${Date.parse('2026-06-18T00:04:00.000Z') / 1000}
`, { data: null }));

    const result = await fetchBatchRepoHealth([
      { projectId: 'github.com/acme/app', owner: 'acme', repo: 'app' },
    ], 'alice');

    expect(result).toEqual({
      kind: 'rate-limited',
      retryAfterMs: 240_000,
      message: 'x-ratelimit-remaining: 0',
    });
    expect(childProcessMocks.spawn).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['graphql', '--include']),
      expect.any(Object),
    );
  });

  it('applies successful repo-health data before backing off on exhausted primary limit headers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T00:00:00.000Z'));
    mockGhSpawn(includeResponse(`
HTTP/2.0 200 OK
x-ratelimit-remaining: 0
x-ratelimit-reset: ${Date.parse('2026-06-18T00:08:00.000Z') / 1000}
`, {
      data: {
        r0: {
          nameWithOwner: 'acme/app',
          openIssues: { totalCount: 3 },
          openPRs: { totalCount: 2 },
        },
        s0: { nodes: [] },
      },
    }));

    const result = await fetchBatchRepoHealth([
      { projectId: 'github.com/acme/app', owner: 'acme', repo: 'app' },
    ], 'alice');

    expect(result).toMatchObject({
      rateLimit: {
        kind: 'rate-limited',
        retryAfterMs: 480_000,
        message: 'x-ratelimit-remaining: 0',
      },
    });
    expect(result && 'repoHealth' in result ? result.repoHealth.get('github.com/acme/app') : null).toMatchObject({
      openIssues: 3,
      openPullRequests: 2,
    });
  });

  it('uses included stdout headers when repo-health GraphQL exits non-zero', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-18T00:00:00.000Z'));
    mockGhSpawnFailure(includeResponse(`
HTTP/2.0 200 OK
x-ratelimit-remaining: 0
x-ratelimit-reset: ${Date.parse('2026-06-18T00:06:00.000Z') / 1000}
`, {
      errors: [
        { type: 'RATE_LIMITED', message: 'API rate limit exceeded' },
      ],
    }), 'gh: API rate limit exceeded');

    const result = await fetchBatchRepoHealth([
      { projectId: 'github.com/acme/app', owner: 'acme', repo: 'app' },
    ], 'alice');

    expect(result).toEqual({
      kind: 'rate-limited',
      retryAfterMs: 360_000,
      message: 'gh exited 1: gh: API rate limit exceeded',
    });
  });
});
