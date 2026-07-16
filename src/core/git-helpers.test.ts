import { describe, expect, it, beforeEach, vi } from 'vitest';

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

import {
  DEFAULT_GIT_MAX_ATTEMPTS,
  DEFAULT_GIT_MAX_BUFFER,
  DEFAULT_GIT_TIMEOUT_MS,
  NESTED_GIT_ENV_VARS,
  gitIn,
  runGitIn,
} from './git-helpers.js';

beforeEach(() => {
  mockExecFile.mockReset();
  vi.restoreAllMocks();
});

describe('git-helpers', () => {
  it('runs git with timeout, maxBuffer, cwd, and cleaned git env', async () => {
    const previous = new Map<string, string | undefined>();
    try {
      for (const name of NESTED_GIT_ENV_VARS) {
        previous.set(name, process.env[name]);
        process.env[name] = '/leaked/git-context';
      }
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, { stdout: 'abc123\n', stderr: '' });
      });

      await expect(gitIn('/repo', 'rev-parse', 'HEAD')).resolves.toBe('abc123');

      expect(mockExecFile).toHaveBeenCalledWith(
        'git',
        ['rev-parse', 'HEAD'],
        expect.objectContaining({
          cwd: '/repo',
          timeout: DEFAULT_GIT_TIMEOUT_MS,
          maxBuffer: DEFAULT_GIT_MAX_BUFFER,
          env: expect.any(Object),
        }),
        expect.any(Function),
      );
      const env = mockExecFile.mock.calls[0]![2].env as NodeJS.ProcessEnv;
      for (const name of NESTED_GIT_ENV_VARS) {
        expect(env[name]).toBeUndefined();
      }
    } finally {
      for (const name of NESTED_GIT_ENV_VARS) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('returns a typed timeout result and logs a distinct warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      const err = Object.assign(new Error('Command failed: git status timed out'), {
        code: 'ETIMEDOUT',
        killed: true,
        signal: 'SIGTERM',
      });
      cb(err, { stdout: '', stderr: '' });
    });

    await expect(runGitIn('/repo', ['status'], { timeoutMs: 5, maxBuffer: 128 }))
      .resolves.toEqual({ kind: 'timed_out' });
    expect(warn).toHaveBeenCalledWith(
      '[git-helpers] git subprocess guard tripped',
      expect.objectContaining({
        kind: 'timed_out',
        cwd: '/repo',
        args: ['status'],
        timeoutMs: 5,
        maxBuffer: 128,
        attempt: 1,
        maxAttempts: DEFAULT_GIT_MAX_ATTEMPTS,
      }),
    );
  });

  it('retries transient network git commands with backoff before succeeding', async () => {
    mockExecFile
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(Object.assign(new Error('The remote end hung up unexpectedly'), { code: 128 }), { stdout: '', stderr: '' });
      })
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, { stdout: 'fetched\n', stderr: '' });
      });

    await expect(runGitIn('/repo', ['fetch', 'origin', 'main'], { retryDelayMs: () => 0 }))
      .resolves.toEqual({ kind: 'ok', stdout: 'fetched' });
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it('does not retry retryable git commands for non-network failures', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error('fatal: invalid refspec'), { stdout: '', stderr: '' });
    });

    await expect(runGitIn('/repo', ['fetch', 'origin', 'not a ref'], { retryDelayMs: () => 0 }))
      .resolves.toEqual({ kind: 'failed' });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('returns the final failure after exhausting transient git retries', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error('fatal: unable to access remote: Could not resolve host: github.com'), { stdout: '', stderr: '' });
    });

    await expect(runGitIn('/repo', ['ls-remote', 'origin'], { maxAttempts: 2, retryDelayMs: () => 0 }))
      .resolves.toEqual({ kind: 'failed' });
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-network git commands that fail normally', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error('not a git repository'), { stdout: '', stderr: '' });
    });

    await expect(runGitIn('/repo', ['status'], { retryDelayMs: () => 0 }))
      .resolves.toEqual({ kind: 'failed' });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('does not retry mutating pull failures', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error('Automatic merge failed; fix conflicts and then commit the result.'), { stdout: '', stderr: '' });
    });

    await expect(runGitIn('/repo', ['pull', '--ff-only'], { retryDelayMs: () => 0 }))
      .resolves.toEqual({ kind: 'failed' });
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it('returns null from the compatibility wrapper on maxBuffer overflow', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      const err = Object.assign(new Error('stdout maxBuffer length exceeded'), {
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      });
      cb(err, { stdout: '', stderr: '' });
    });

    await expect(gitIn('/repo', 'worktree', 'list', '--porcelain')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[git-helpers] git subprocess guard tripped',
      expect.objectContaining({ kind: 'max_buffer_exceeded' }),
    );
  });
});
