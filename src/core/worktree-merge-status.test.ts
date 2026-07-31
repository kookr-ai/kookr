import { describe, expect, it, beforeEach, vi } from 'vitest';

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

import { probeLocalGitPublishability } from './worktree-merge-status.js';

beforeEach(() => {
  mockExecFile.mockReset();
});

describe('probeLocalGitPublishability', () => {
  it('reports canPublish:true when git push --dry-run succeeds', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      expect(args).toEqual(['push', '--dry-run', 'origin', 'HEAD:refs/heads/feature-x']);
      cb(null, { stdout: '', stderr: '' });
    });

    await expect(probeLocalGitPublishability('/repo', 'feature-x')).resolves.toEqual({
      canPublish: true,
      reasonCode: 'dry_run_push_ok',
    });
  });

  it('reports canPublish:false / dry_run_push_failed when the dry-run push fails', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error('fatal: could not read Username for https://github.com'), { stdout: '', stderr: '' });
    });

    await expect(probeLocalGitPublishability('/repo', 'feature-x')).resolves.toEqual({
      canPublish: false,
      reasonCode: 'dry_run_push_failed',
    });
  });

  it('reports canPublish:false / dry_run_push_timed_out when the dry-run push times out', async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      const err = Object.assign(new Error('Command failed: git push timed out'), {
        code: 'ETIMEDOUT',
        killed: true,
        signal: 'SIGTERM',
      });
      cb(err, { stdout: '', stderr: '' });
    });

    await expect(probeLocalGitPublishability('/repo', 'feature-x')).resolves.toEqual({
      canPublish: false,
      reasonCode: 'dry_run_push_timed_out',
    });
  });

  it('probes against a caller-supplied remote', async () => {
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      expect(args).toEqual(['push', '--dry-run', 'upstream', 'HEAD:refs/heads/feature-x']);
      cb(null, { stdout: '', stderr: '' });
    });

    await expect(probeLocalGitPublishability('/repo', 'feature-x', 'upstream')).resolves.toEqual({
      canPublish: true,
      reasonCode: 'dry_run_push_ok',
    });
  });
});
