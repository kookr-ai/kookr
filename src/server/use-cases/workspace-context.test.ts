import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveWorkspaceContext } from './workspace-context.js';

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

function mockGitResponses(handlers: Record<string, string | 'error'>) {
  mockExecFile.mockImplementation((_cmd: string, args: string[], opts: unknown, cb: Function) => {
    const cwd = opts && typeof opts === 'object' && 'cwd' in opts ? String((opts as { cwd?: string }).cwd ?? '') : '';
    const argsStr = `${cwd} ${args.join(' ')}`.trim();
    for (const [pattern, response] of Object.entries(handlers)) {
      if (argsStr.includes(pattern)) {
        if (response === 'error') {
          cb(new Error('git error'), { stdout: '', stderr: 'git error' });
        } else {
          cb(null, { stdout: response, stderr: '' });
        }
        return;
      }
    }
    cb(new Error(`unhandled git args: ${argsStr}`), { stdout: '', stderr: 'unhandled' });
  });
}

describe('resolveWorkspaceContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the server root for the server project', async () => {
    mockGitResponses({
      '/repo rev-parse --path-format=absolute --git-common-dir': '/repo/.git',
    });

    const context = await resolveWorkspaceContext('github.com/kookr-ai/kookr', {
      serverCwd: '/repo',
      serverProjectId: 'github.com/kookr-ai/kookr',
      taskStore: { getAllTasks: () => [] },
    });

    expect(context.repoPath).toBe('/repo');
  });

  it('maps linked worktree sessions back to the shared checkout root', async () => {
    mockGitResponses({
      '/task-worktree rev-parse --path-format=absolute --git-common-dir': '/repo/.git',
    });

    const context = await resolveWorkspaceContext('github.com/org/repo', {
      serverCwd: '/server',
      taskStore: {
        getAllTasks: () => [
          {
            cwd: '/task-worktree',
            projectId: 'github.com/org/repo',
            sessions: [{ cwd: '/task-worktree' }],
          },
        ],
      },
    });

    expect(context.repoPath).toBe('/repo');
  });

  it('throws when multiple distinct roots exist for the same project', async () => {
    mockGitResponses({
      '/repo-a rev-parse --path-format=absolute --git-common-dir': '/repo-a/.git',
      '/repo-b rev-parse --path-format=absolute --git-common-dir': '/repo-b/.git',
    });

    await expect(resolveWorkspaceContext('github.com/org/repo', {
      serverCwd: '/server',
      taskStore: {
        getAllTasks: () => [
          { cwd: '/repo-a', projectId: 'github.com/org/repo', sessions: [] },
          { cwd: '/repo-b', projectId: 'github.com/org/repo', sessions: [] },
        ],
      },
    })).rejects.toThrow('Multiple repository roots found');
  });

  it('throws when no usable repository root can be found', async () => {
    mockGitResponses({
      '/server rev-parse --path-format=absolute --git-common-dir': 'error',
      '/server rev-parse --show-toplevel': 'error',
    });

    await expect(resolveWorkspaceContext('github.com/org/repo', {
      serverCwd: '/server',
      taskStore: { getAllTasks: () => [] },
    })).rejects.toThrow('Unable to determine repository root');
  });
});
