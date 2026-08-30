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
      '-C /repo remote get-url origin': 'git@github.com:kookr-ai/kookr.git',
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
      '-C /repo remote get-url origin': 'git@github.com:org/repo.git',
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

  it('keeps local project worktree fallback behavior without remote identity validation', async () => {
    mockGitResponses({
      '/task-worktree rev-parse --path-format=absolute --git-common-dir': '/repo/.git',
    });

    const context = await resolveWorkspaceContext('local/task-worktree', {
      serverCwd: '/server',
      taskStore: {
        getAllTasks: () => [
          {
            cwd: '/task-worktree',
            projectId: 'local/task-worktree',
            sessions: [],
          },
        ],
      },
    });

    expect(context.repoPath).toBe('/repo');
  });

  it('prefers configured localPath and ignores task cwd from a different repo', async () => {
    mockGitResponses({
      '/right-repo rev-parse --path-format=absolute --git-common-dir': '/right-repo/.git',
      '/wrong-repo rev-parse --path-format=absolute --git-common-dir': '/wrong-repo/.git',
      '-C /right-repo remote get-url origin': 'git@github.com:org/repo.git',
      '-C /wrong-repo remote get-url origin': 'git@github.com:kookr-ai/kookr.git',
    });

    const context = await resolveWorkspaceContext('github.com/org/repo', {
      serverCwd: '/server',
      projectConfigStore: {
        getConfig: () => ({ project: 'github.com/org/repo', localPath: '/right-repo' }),
      },
      taskStore: {
        getAllTasks: () => [
          {
            cwd: '/wrong-repo',
            projectId: 'github.com/org/repo',
            sessions: [{ cwd: '/wrong-repo' }],
          },
        ],
      },
    });

    expect(context.repoPath).toBe('/right-repo');
  });

  it('can restrict configured-project resolution to the inventory path', async () => {
    mockGitResponses({
      '/configured-repo rev-parse --path-format=absolute --git-common-dir': '/configured-repo/.git',
      '-C /configured-repo remote get-url origin': 'git@github.com:org/repo.git',
    });
    const getAllTasks = vi.fn(() => {
      throw new Error('task history must not be scanned');
    });

    const context = await resolveWorkspaceContext('github.com/org/repo', {
      serverCwd: '/server',
      projectConfigStore: {
        getConfig: () => ({ project: 'github.com/org/repo', localPath: '/configured-repo' }),
      },
      taskStore: { getAllTasks },
      includeTaskFallback: false,
    });

    expect(context.repoPath).toBe('/configured-repo');
    expect(getAllTasks).not.toHaveBeenCalled();
  });

  it('throws when multiple distinct roots exist for the same project', async () => {
    mockGitResponses({
      '/repo-a rev-parse --path-format=absolute --git-common-dir': '/repo-a/.git',
      '/repo-b rev-parse --path-format=absolute --git-common-dir': '/repo-b/.git',
      '-C /repo-a remote get-url origin': 'git@github.com:org/repo.git',
      '-C /repo-b remote get-url origin': 'git@github.com:org/repo.git',
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
