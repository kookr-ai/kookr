import { describe, expect, it, beforeEach, vi } from 'vitest';

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

import {
  DEFAULT_GIT_MAX_BUFFER,
  DEFAULT_GIT_TIMEOUT_MS,
  gitIn,
  runGitIn,
} from './git-helpers.js';

beforeEach(() => {
  mockExecFile.mockReset();
  vi.restoreAllMocks();
});

describe('git-helpers', () => {
  it('runs git with timeout, maxBuffer, cwd, and cleaned git env', async () => {
    const originalGitDir = process.env.GIT_DIR;
    const originalGitWorkTree = process.env.GIT_WORK_TREE;
    try {
      process.env.GIT_DIR = '/leaked/git-dir';
      process.env.GIT_WORK_TREE = '/leaked/work-tree';
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
          env: expect.not.objectContaining({
            GIT_DIR: expect.any(String),
            GIT_WORK_TREE: expect.any(String),
          }),
        }),
        expect.any(Function),
      );
    } finally {
      if (originalGitDir === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = originalGitDir;
      }
      if (originalGitWorkTree === undefined) {
        delete process.env.GIT_WORK_TREE;
      } else {
        process.env.GIT_WORK_TREE = originalGitWorkTree;
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
      }),
    );
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
