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

const { fetchBatchRepoHealth, fetchStates } = await import('./github-fetcher.js');

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
