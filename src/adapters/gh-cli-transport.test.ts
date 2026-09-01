import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GH_MAX_ATTEMPTS,
  DEFAULT_GH_RETRY_DELAYS_MS,
  classifyGitHubRateLimit,
  ghErrorStdout,
  isTransientGhError,
  spawnGhWithStdinOnce,
  withGhRetry,
  type SpawnFn,
} from './gh-cli-transport.js';

/**
 * Golden tests for the gh CLI transport (issue #2820): retry count/delay,
 * transient-vs-terminal classification, and stderr/exit-code mapping. These
 * pin the subprocess mechanics that were extracted from github-fetcher.ts so a
 * later refactor cannot silently change timing or error boundaries.
 */

/** Records the delays passed to the injected sleep seam without waiting. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return { delays, sleep: (ms: number) => { delays.push(ms); return Promise.resolve(); } };
}

/** A transient error shaped like the ones `gh` invocations reject with. */
function transientError(message = 'network timeout'): Error {
  return Object.assign(new Error(message), { code: 'ETIMEDOUT' });
}

describe('withGhRetry — retry count and delay', () => {
  it('returns the first successful result without sleeping', async () => {
    const { sleep, delays } = recordingSleep();
    const operation = vi.fn().mockResolvedValue('ok');

    await expect(withGhRetry(['api'], operation, { sleep })).resolves.toBe('ok');

    expect(operation).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('retries transient failures up to maxAttempts, then throws the last error', async () => {
    const { sleep, delays } = recordingSleep();
    const err = transientError('persistent network failure');
    const operation = vi.fn().mockRejectedValue(err);
    const onRetry = vi.fn();

    await expect(withGhRetry(['api'], operation, { sleep, onRetry })).rejects.toBe(err);

    // 3 attempts total = the initial try + 2 retries; 2 sleeps between them.
    expect(operation).toHaveBeenCalledTimes(DEFAULT_GH_MAX_ATTEMPTS);
    expect(delays).toEqual([...DEFAULT_GH_RETRY_DELAYS_MS]);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls.map(([info]) => info.attempt)).toEqual([1, 2]);
  });

  it('recovers when a retry eventually succeeds', async () => {
    const { sleep, delays } = recordingSleep();
    const operation = vi.fn()
      .mockRejectedValueOnce(transientError())
      .mockResolvedValueOnce('recovered');

    await expect(withGhRetry(['api'], operation, { sleep })).resolves.toBe('recovered');

    expect(operation).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([DEFAULT_GH_RETRY_DELAYS_MS[0]]);
  });

  it('does not retry a terminal (non-transient) error', async () => {
    const { sleep, delays } = recordingSleep();
    const err = Object.assign(new Error('bad request'), { code: 'ERR_BAD' });
    const operation = vi.fn().mockRejectedValue(err);

    await expect(withGhRetry(['api'], operation, { sleep })).rejects.toBe(err);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('does not retry a rate-limit error', async () => {
    const { sleep, delays } = recordingSleep();
    const err = new Error('You have exceeded a secondary rate limit');
    const operation = vi.fn().mockRejectedValue(err);

    await expect(withGhRetry(['api'], operation, { sleep })).rejects.toBe(err);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it('honours a custom attempt budget and repeats the last delay when the table is exhausted', async () => {
    const { sleep, delays } = recordingSleep();
    const operation = vi.fn().mockRejectedValue(transientError());

    await expect(
      withGhRetry(['api'], operation, { sleep, maxAttempts: 5, retryDelaysMs: [10, 20] }),
    ).rejects.toBeInstanceOf(Error);

    expect(operation).toHaveBeenCalledTimes(5);
    // 4 sleeps: 10, 20, then 20 repeated for the exhausted table.
    expect(delays).toEqual([10, 20, 20, 20]);
  });
});

describe('isTransientGhError — classification matrix', () => {
  it.each([
    ['ETIMEDOUT', { code: 'ETIMEDOUT' }],
    ['ECONNRESET', { code: 'ECONNRESET' }],
    ['ECONNREFUSED', { code: 'ECONNREFUSED' }],
    ['EAI_AGAIN', { code: 'EAI_AGAIN' }],
    ['ENOTFOUND', { code: 'ENOTFOUND' }],
    ['killed SIGTERM', { killed: true, signal: 'SIGTERM' }],
    ['message: timed out', { message: 'gh api timed out after 30000ms' }],
    ['message: HTTP 502', { message: 'server responded with HTTP 502' }],
    ['stderr: connection reset', { stderr: 'error: connection reset by peer' }],
  ])('treats %s as transient', (_label, shape) => {
    expect(isTransientGhError(shape)).toBe(true);
  });

  it.each([
    ['plain terminal error', { code: 'ERR_INVALID', message: 'bad json' }],
    ['killed without SIGTERM', { killed: true, signal: 'SIGKILL' }],
    ['null', null],
    ['undefined', undefined],
  ])('treats %s as terminal', (_label, shape) => {
    expect(isTransientGhError(shape)).toBe(false);
  });

  it('never treats a rate-limit error as transient even if its text looks like a timeout', () => {
    const err = new Error('secondary rate limit; retry-after: 30');
    expect(isTransientGhError(err)).toBe(false);
  });
});

/** Minimal fake `gh` child process driving the spawnGhWithStdinOnce lifecycle. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { write: vi.fn(), end: vi.fn() };
  kill = vi.fn();
}

function fakeSpawn(child: FakeChild): { spawnFn: SpawnFn; calls: Array<{ cmd: string; args: string[] }> } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawnFn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return child as unknown as ReturnType<SpawnFn>;
  }) as unknown as SpawnFn;
  return { spawnFn, calls };
}

describe('spawnGhWithStdinOnce — stdin, exit code, and stderr mapping', () => {
  it('resolves stdout on exit code 0 and writes stdin', async () => {
    const child = new FakeChild();
    const { spawnFn, calls } = fakeSpawn(child);

    const promise = spawnGhWithStdinOnce(['api', 'graphql'], 'QUERY_BODY', 30_000, spawnFn);
    child.stdout.emit('data', Buffer.from('{"data":'));
    child.stdout.emit('data', Buffer.from('true}'));
    child.emit('close', 0);

    await expect(promise).resolves.toBe('{"data":true}');
    expect(calls).toEqual([{ cmd: 'gh', args: ['api', 'graphql'] }]);
    expect(child.stdin.write).toHaveBeenCalledWith('QUERY_BODY');
    expect(child.stdin.end).toHaveBeenCalled();
  });

  it('rejects with exit code and stderr on non-zero exit, attaching stdout/stderr', async () => {
    const child = new FakeChild();
    const { spawnFn } = fakeSpawn(child);

    const promise = spawnGhWithStdinOnce(['api'], 'body', 30_000, spawnFn);
    child.stdout.emit('data', Buffer.from('partial'));
    child.stderr.emit('data', Buffer.from('gh: not authenticated'));
    child.emit('close', 1);

    await expect(promise).rejects.toThrow('gh exited 1: gh: not authenticated');
    await promise.catch((err: Error & { stdout?: string; stderr?: string }) => {
      expect(err.stdout).toBe('partial');
      expect(err.stderr).toBe('gh: not authenticated');
    });
  });

  it('reports (no stderr) when the process fails silently', async () => {
    const child = new FakeChild();
    const { spawnFn } = fakeSpawn(child);

    const promise = spawnGhWithStdinOnce(['api'], 'body', 30_000, spawnFn);
    child.emit('close', 2);

    await expect(promise).rejects.toThrow('gh exited 2: (no stderr)');
  });

  it('rejects with the spawn error on process error', async () => {
    const child = new FakeChild();
    const { spawnFn } = fakeSpawn(child);

    const promise = spawnGhWithStdinOnce(['api'], 'body', 30_000, spawnFn);
    const spawnErr = new Error('spawn ENOENT');
    child.emit('error', spawnErr);

    await expect(promise).rejects.toBe(spawnErr);
  });

  it('SIGKILLs and rejects on timeout', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const { spawnFn } = fakeSpawn(child);

      const promise = spawnGhWithStdinOnce(['api'], 'body', 5_000, spawnFn);
      const assertion = expect(promise).rejects.toThrow('gh api timed out after 5000ms');
      vi.advanceTimersByTime(5_000);
      await assertion;
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('classifyGitHubRateLimit / ghErrorStdout — moved with the transport', () => {
  it('classifies a secondary rate-limit message and parses retry-after', () => {
    const result = classifyGitHubRateLimit('You have exceeded a secondary rate limit. retry-after: 45');
    expect(result).toMatchObject({ kind: 'rate-limited', retryAfterMs: 45_000 });
  });

  it('classifies a zero x-ratelimit-remaining header', () => {
    const result = classifyGitHubRateLimit({ headers: { 'x-ratelimit-remaining': 0 } });
    expect(result?.kind).toBe('rate-limited');
  });

  it('returns null when no rate-limit signal is present', () => {
    expect(classifyGitHubRateLimit('ordinary error')).toBeNull();
  });

  it('extracts stdout carried on a gh error, or null', () => {
    expect(ghErrorStdout({ stdout: 'payload' })).toBe('payload');
    expect(ghErrorStdout(new Error('boom'))).toBeNull();
  });
});
