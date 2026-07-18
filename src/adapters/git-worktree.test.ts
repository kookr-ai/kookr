import { describe, test, expect, vi, beforeEach } from 'vitest';

// Hoist mock functions so they're available in vi.mock factories
const { mockExecFile, mockExistsSync, mockRemovalGuard, mockRemoveRegisteredWorktree } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockExistsSync: vi.fn(),
  mockRemovalGuard: vi.fn(),
  mockRemoveRegisteredWorktree: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}));

vi.mock('./worktree-safety.js', () => ({
  getWorktreeRemovalGuardReason: mockRemovalGuard,
  samePath: (left: string, right: string) => left === right,
  removeRegisteredWorktree: mockRemoveRegisteredWorktree,
}));

import {
  cleanupTaskWorktrees,
  inspectTaskWorktrees,
  inspectWorktreeCleanup,
  parsePorcelainStatus,
} from './git-worktree.js';
import { DEFAULT_GIT_MAX_BUFFER, DEFAULT_GIT_TIMEOUT_MS } from '../core/git-helpers.js';
import { TaskStore } from '../core/tasks.js';
import type { InteractionLogWriter } from '../core/interaction-log.js';
import type { InteractionEvent } from '../core/interaction-log.js';

/** Make mockExecFile resolve with given stdout. */
function mockGitSuccess(stdout: string) {
  mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, { stdout, stderr: '' });
  });
}

/**
 * Set up mockExecFile to return different results based on the git subcommand.
 * handlers is a map from a substring of the args to { stdout }, 'error', or
 * 'not-ancestor' (the expected exit 1 from merge-base --is-ancestor).
 */
function mockGitResponses(handlers: Record<string, string | 'error' | 'not-ancestor'>) {
  mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
    const argsStr = args.join(' ');
    for (const [pattern, response] of Object.entries(handlers)) {
      if (argsStr.includes(pattern)) {
        if (response === 'error' || response === 'not-ancestor') {
          const error = Object.assign(new Error('git error'), {
            code: response === 'not-ancestor' ? 1 : 128,
          });
          cb(error, { stdout: '', stderr: 'git error' });
        } else {
          cb(null, { stdout: response, stderr: '' });
        }
        return;
      }
    }
    if (args.includes('--git-common-dir')) {
      cb(null, { stdout: `${args[1]}/.git\n`, stderr: '' });
      return;
    }
    if (args.includes('rev-list') && args.includes('--left-right') && args.includes('--count')) {
      cb(null, { stdout: '0\t0', stderr: '' });
      return;
    }
    // Default: empty success
    cb(null, { stdout: '', stderr: '' });
  });
}

/** Create a fake interaction log that captures events in memory. */
function makeFakeLog(): { log: InteractionLogWriter; events: InteractionEvent[] } {
  const events: InteractionEvent[] = [];
  const log = {
    append: async (event: InteractionEvent) => { events.push(event); },
    getFilePath: () => '/fake/log',
  } as unknown as InteractionLogWriter;
  return { log, events };
}

beforeEach(() => {
  mockExecFile.mockReset();
  mockExistsSync.mockReset();
  mockRemovalGuard.mockReset();
  mockRemovalGuard.mockResolvedValue(undefined);
  mockRemoveRegisteredWorktree.mockReset();
  mockRemoveRegisteredWorktree.mockImplementation(async (worktreePath: string, options: { expectedHead?: string; expectedBranch?: string; expectedDetached?: boolean } = {}) => ({
    removed: true,
    target: {
      worktreePath,
      commonDir: worktreePath.startsWith('/other-repo/') ? '/other-repo/.git' : `${worktreePath}/.git`,
      gitDir: `${worktreePath}/.git/worktrees/kookr-test`,
      head: options.expectedHead ?? 'abc123',
      branch: options.expectedBranch,
      detached: options.expectedDetached ?? false,
      bare: false,
    },
  }));
});

describe('cleanupTaskWorktrees', () => {
  function setupCleanWorktree() {
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({
      'status --porcelain': '',
      'log': '',
      'symbolic-ref': 'refs/remotes/origin/main\n',
      'worktree prune': '',
      'branch -d': 'Deleted branch feature (was abc1234).\n',
    });
  }

  test('clean worktree → directory removed, branch deleted, worktree_cleaned logged', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/project');
    taskStore.addSession(task.id, {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/wt/feature-branch',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'feature',
      gitCommit: 'abc123',
      gitDir: '/wt/feature-branch/.git/worktrees/kookr-test',
    });
    taskStore.completeTask(task.id);

    const { log, events } = makeFakeLog();
    setupCleanWorktree();

    await cleanupTaskWorktrees(taskStore, task.id, log);

    // Directory removed
    expect(mockRemoveRegisteredWorktree).toHaveBeenCalledWith('/wt/feature-branch', expect.objectContaining({
      force: true,
      expectedHead: 'abc123',
      expectedBranch: 'feature',
      expectedGitDir: '/wt/feature-branch/.git/worktrees/kookr-test',
    }));
    expect(taskStore.getTask(task.id)!.sessions[0].worktreeHealth).toBe('cleaned_up');
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      expect.any(Array),
      expect.objectContaining({
        timeout: DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: DEFAULT_GIT_MAX_BUFFER,
      }),
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      expect.objectContaining({ cwd: '/wt/feature-branch' }),
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['-C', '/wt/feature-branch/.git', 'worktree', 'prune'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['-C', '/wt/feature-branch/.git', 'branch', '-d', 'feature'],
      expect.any(Object),
      expect.any(Function),
    );

    // worktree_cleaned logged
    const cleaned = events.find((e) => e.type === 'worktree_cleaned');
    expect(cleaned).toMatchObject({
      type: 'worktree_cleaned',
      taskId: task.id,
      worktreePath: '/wt/feature-branch',
      branch: 'feature',
    });
  });

  test('dirty worktree (uncommitted changes) → directory preserved, worktree_kept logged', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/project');
    taskStore.addSession(task.id, {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/wt/dirty',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'dirty-branch',
    });
    taskStore.cancelTask(task.id);

    const { log, events } = makeFakeLog();
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({
      'status --porcelain': ' M file.ts\n',
      'symbolic-ref': 'refs/remotes/origin/main\n',
    });

    await cleanupTaskWorktrees(taskStore, task.id, log);

    // Directory NOT removed
    expect(mockRemoveRegisteredWorktree).not.toHaveBeenCalled();

    // worktree_kept logged
    const kept = events.find((e) => e.type === 'worktree_kept');
    expect(kept).toMatchObject({
      type: 'worktree_kept',
      reason: 'uncommitted changes',
      worktreePath: '/wt/dirty',
    });
  });

  test('task with no worktree → no cleanup attempted', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/project');
    taskStore.addSession(task.id, {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/project',
      createdAt: new Date(),
      // gitIsWorktree not set
    });
    taskStore.completeTask(task.id);

    const { log, events } = makeFakeLog();
    await cleanupTaskWorktrees(taskStore, task.id, log);

    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockRemoveRegisteredWorktree).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  test('task reopened during cleanup → cleanup aborted, worktree_skipped logged', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/project');
    taskStore.addSession(task.id, {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/wt/reopened',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'feat',
    });
    taskStore.completeTask(task.id);

    const { log, events } = makeFakeLog();
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    // Worktree is clean, but task gets reopened before destructive step
    mockGitResponses({
      'status --porcelain': '',
      'log': '',
      'symbolic-ref': 'refs/remotes/origin/main\n',
    });

    // Reopen the task before calling cleanup (simulates race)
    taskStore.reopenTask(task.id);

    await cleanupTaskWorktrees(taskStore, task.id, log);

    // Directory NOT removed because task is open
    expect(mockRemoveRegisteredWorktree).not.toHaveBeenCalled();

    // worktree_skipped logged with reason 'task reopened'
    const skipped = events.find((e) => e.type === 'worktree_skipped');
    expect(skipped).toMatchObject({
      type: 'worktree_skipped',
      reason: 'task reopened',
    });
  });

  test('protected worktree → skipped', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/project');
    taskStore.addSession(task.id, {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/home/user/git/kookr-prod',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'main',
    });
    taskStore.completeTask(task.id);

    const { log, events } = makeFakeLog();
    // Both the worktree path and the .kookr-protected marker exist.
    mockExistsSync.mockReturnValue(true);

    await cleanupTaskWorktrees(taskStore, task.id, log);

    expect(mockRemoveRegisteredWorktree).not.toHaveBeenCalled();
    const skipped = events.find((e) => e.type === 'worktree_skipped');
    expect(skipped).toMatchObject({
      type: 'worktree_skipped',
      reason: 'protected',
    });
  });

  test('primary checkout regression: clean and unmarked path is never removed', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/repo');
    taskStore.addSession(task.id, {
      tmuxSession: 's-primary',
      agentType: 'claude-code',
      cwd: '/repo',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'main',
    });
    taskStore.completeTask(task.id);

    const { log, events } = makeFakeLog();
    mockExistsSync.mockImplementation((path: string) => !path.endsWith('.kookr-protected'));
    mockRemovalGuard.mockResolvedValue('primary-working-tree');

    await cleanupTaskWorktrees(taskStore, task.id, log);

    expect(mockRemoveRegisteredWorktree).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'worktree_skipped',
      worktreePath: '/repo',
      reason: 'primary-working-tree',
    }));
  });

  test('non-worktree path is refused before destructive cleanup', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/repo');
    taskStore.addSession(task.id, {
      tmuxSession: 's-arbitrary',
      agentType: 'claude-code',
      cwd: '/tmp/arbitrary-directory',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'feature',
    });
    taskStore.completeTask(task.id);

    const { log, events } = makeFakeLog();
    mockExistsSync.mockReturnValue(true);
    mockRemovalGuard.mockResolvedValue('not-a-linked-worktree');

    await cleanupTaskWorktrees(taskStore, task.id, log);

    expect(mockRemoveRegisteredWorktree).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ reason: 'not-a-linked-worktree' }));
  });

  test('protected branch is refused by automatic cleanup', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/repo');
    taskStore.addSession(task.id, {
      tmuxSession: 's-protected-branch',
      agentType: 'claude-code',
      cwd: '/repo-wt',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'main',
    });
    taskStore.completeTask(task.id);

    const { log, events } = makeFakeLog();
    mockExistsSync.mockReturnValue(true);
    mockRemovalGuard.mockResolvedValue('protected-branch');

    await cleanupTaskWorktrees(taskStore, task.id, log);

    expect(mockRemoveRegisteredWorktree).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ reason: 'protected-branch' }));
  });

  test('shared worktree → skipped', async () => {
    const taskStore = new TaskStore();
    const task1 = taskStore.createTask('Task 1', '/project');
    taskStore.addSession(task1.id, {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/wt/shared',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'feature',
    });
    // Second task using the same worktree, still in progress
    const task2 = taskStore.createTask('Task 2', '/project');
    taskStore.addSession(task2.id, {
      tmuxSession: 's2',
      agentType: 'claude-code',
      cwd: '/wt/shared',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'feature',
    });
    taskStore.completeTask(task1.id);

    const { log, events } = makeFakeLog();
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));

    await cleanupTaskWorktrees(taskStore, task1.id, log);

    expect(mockRemoveRegisteredWorktree).not.toHaveBeenCalled();
    const skipped = events.find((e) => e.type === 'worktree_skipped');
    expect(skipped).toMatchObject({
      type: 'worktree_skipped',
      reason: 'shared',
    });
  });

  test('worktree path does not exist → skip without guessing a repo to prune', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/project');
    taskStore.addSession(task.id, {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/wt/deleted-already',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'feature',
    });
    taskStore.completeTask(task.id);

    const { log, events } = makeFakeLog();
    mockExistsSync.mockReturnValue(false);

    await cleanupTaskWorktrees(taskStore, task.id, log);

    expect(mockRemoveRegisteredWorktree).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
    const skipped = events.find((e) => e.type === 'worktree_skipped');
    expect(skipped).toMatchObject({
      type: 'worktree_skipped',
      reason: 'not found',
    });
  });

  test('prune and branch deletion use the worktree repository after its directory is removed', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/project');
    taskStore.addSession(task.id, {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/other-repo/wt/feature',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'feature',
    });
    taskStore.completeTask(task.id);

    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({
      'status --porcelain': '',
      'symbolic-ref': 'refs/remotes/origin/master\n',
      'log master..feature': '',
      'rev-parse --path-format=absolute --git-common-dir': '/other-repo/.git\n',
      'worktree prune': '',
      'branch -d': 'Deleted branch feature.\n',
    });

    await cleanupTaskWorktrees(taskStore, task.id);

    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['symbolic-ref', 'refs/remotes/origin/HEAD'],
      expect.objectContaining({ cwd: '/other-repo/wt/feature' }),
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['-C', '/other-repo/.git', 'worktree', 'prune'],
      expect.any(Object),
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      'git',
      ['-C', '/other-repo/.git', 'branch', '-d', 'feature'],
      expect.any(Object),
      expect.any(Function),
    );
    const pruneCallIndex = mockExecFile.mock.calls.findIndex((call) => call[1].includes('prune'));
    expect(mockExecFile.mock.invocationCallOrder[pruneCallIndex]).toBeGreaterThan(
      mockRemoveRegisteredWorktree.mock.invocationCallOrder[0],
    );
  });

  test('shared removal failure preserves the worktree', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/project');
    taskStore.addSession(task.id, {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/wt/feature',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'feature',
    });
    taskStore.completeTask(task.id);

    const { log, events } = makeFakeLog();
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({
      'status --porcelain': '',
      'symbolic-ref': 'refs/remotes/origin/main\n',
      'log main..feature': '',
      'rev-parse --path-format=absolute --git-common-dir': 'error',
    });
    mockRemoveRegisteredWorktree.mockResolvedValue({
      removed: false,
      reason: 'repository-context-unavailable',
      stderr: 'repository context unavailable',
    });

    await cleanupTaskWorktrees(taskStore, task.id, log);

    expect(mockRemoveRegisteredWorktree).toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'worktree_cleanup_failed',
      worktreePath: '/wt/feature',
      error: expect.stringContaining('repository context unavailable'),
    }));
  });

  test('git timeout during cleanup → worktree kept and guard warning logged', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/project');
    taskStore.addSession(task.id, {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/wt/slow',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'feature',
    });
    taskStore.completeTask(task.id);

    const { log, events } = makeFakeLog();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (args.includes('status')) {
        const err = Object.assign(new Error('Command failed: git status timed out'), {
          code: 'ETIMEDOUT',
          killed: true,
          signal: 'SIGTERM',
        });
        cb(err, { stdout: '', stderr: '' });
        return;
      }
      cb(null, { stdout: '', stderr: '' });
    });

    await cleanupTaskWorktrees(taskStore, task.id, log);

    expect(mockRemoveRegisteredWorktree).not.toHaveBeenCalled();
    const kept = events.find((e) => e.type === 'worktree_kept');
    expect(kept).toMatchObject({
      type: 'worktree_kept',
      reason: 'git status failed',
      worktreePath: '/wt/slow',
    });
    expect(warn).toHaveBeenCalledWith(
      '[git-worktree] git subprocess guard tripped',
      expect.objectContaining({
        kind: 'timed_out',
        args: ['-C', '/wt/slow', 'status', '--porcelain'],
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: DEFAULT_GIT_MAX_BUFFER,
      }),
    );
  });

  test('Git worktree removal failure → worktree_cleanup_failed logged', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/project');
    taskStore.addSession(task.id, {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/wt/locked',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'feature',
    });
    taskStore.completeTask(task.id);

    const { log, events } = makeFakeLog();
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({
      'status --porcelain': '',
      'log': '',
      'symbolic-ref': 'refs/remotes/origin/main\n',
    });
    mockRemoveRegisteredWorktree.mockResolvedValue({
      removed: false,
      reason: 'git-remove-failed',
      stderr: 'EBUSY: resource busy',
    });

    await cleanupTaskWorktrees(taskStore, task.id, log);

    const failed = events.find((e) => e.type === 'worktree_cleanup_failed');
    expect(failed).toMatchObject({
      type: 'worktree_cleanup_failed',
      error: expect.stringContaining('EBUSY'),
      worktreePath: '/wt/locked',
    });
  });

  test('detached HEAD worktree → kept with reason', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/project');
    taskStore.addSession(task.id, {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/wt/detached',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitIsDetached: true,
    });
    taskStore.completeTask(task.id);

    const { log, events } = makeFakeLog();
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));

    await cleanupTaskWorktrees(taskStore, task.id, log);

    expect(mockRemoveRegisteredWorktree).not.toHaveBeenCalled();
    const kept = events.find((e) => e.type === 'worktree_kept');
    expect(kept).toMatchObject({
      type: 'worktree_kept',
      reason: 'detached HEAD',
    });
  });

  test('unmerged commits → kept with reason', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/project');
    taskStore.addSession(task.id, {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/wt/unmerged',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'feature',
    });
    taskStore.completeTask(task.id);

    const { log, events } = makeFakeLog();
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({
      'status --porcelain': '',
      'merge-base': 'not-ancestor',
      'log': 'abc1234 Add feature\ndef5678 Fix bug\n',
      'symbolic-ref': 'refs/remotes/origin/main\n',
      'rev-list': '0\t2',
    });

    await cleanupTaskWorktrees(taskStore, task.id, log);

    expect(mockRemoveRegisteredWorktree).not.toHaveBeenCalled();
    const kept = events.find((e) => e.type === 'worktree_kept');
    expect(kept).toMatchObject({
      type: 'worktree_kept',
      reason: 'unmerged commits',
    });
  });

  test('multiple worktree sessions → all cleaned', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/project');
    taskStore.addSession(task.id, {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/wt/a',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'feature-a',
    });
    taskStore.addSession(task.id, {
      tmuxSession: 's2',
      agentType: 'claude-code',
      cwd: '/wt/b',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'feature-b',
    });
    taskStore.completeTask(task.id);

    const { log, events } = makeFakeLog();
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({
      'status --porcelain': '',
      'log': '',
      'symbolic-ref': 'refs/remotes/origin/main\n',
      'worktree prune': '',
      'branch -d': 'Deleted.\n',
    });

    await cleanupTaskWorktrees(taskStore, task.id, log);

    expect(mockRemoveRegisteredWorktree).toHaveBeenCalledTimes(2);
    const cleaned = events.filter((e) => e.type === 'worktree_cleaned');
    expect(cleaned).toHaveLength(2);
  });

  test('duplicate worktree paths → cleaned only once', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/project');
    taskStore.addSession(task.id, {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/wt/same',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'feature',
    });
    taskStore.addSession(task.id, {
      tmuxSession: 's2',
      agentType: 'claude-code',
      cwd: '/wt/same',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'feature',
    });
    taskStore.completeTask(task.id);

    const { log, events } = makeFakeLog();
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({
      'status --porcelain': '',
      'log': '',
      'symbolic-ref': 'refs/remotes/origin/main\n',
      'worktree prune': '',
      'branch -d': 'Deleted.\n',
    });

    await cleanupTaskWorktrees(taskStore, task.id, log);

    // getWorktreePaths deduplicates
    expect(mockRemoveRegisteredWorktree).toHaveBeenCalledTimes(1);
    const cleaned = events.filter((e) => e.type === 'worktree_cleaned');
    expect(cleaned).toHaveLength(1);
  });

  test('default branch fallback when symbolic-ref fails', async () => {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/project');
    taskStore.addSession(task.id, {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/wt/fallback',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'feature',
    });
    taskStore.completeTask(task.id);

    const { log, events } = makeFakeLog();
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({
      'status --porcelain': '',
      'symbolic-ref': 'error',
      // When symbolic-ref fails, resolveDefaultBranch falls back to main.
      'rev-parse --verify main': 'main-sha',
      'log': '',
      'worktree prune': '',
      'branch -d': 'Deleted.\n',
    });

    await cleanupTaskWorktrees(taskStore, task.id, log);

    // Should still clean up (falls back to 'main' as default branch)
    const cleaned = events.find((e) => e.type === 'worktree_cleaned');
    expect(cleaned).toMatchObject({
      type: 'worktree_cleaned',
      worktreePath: '/wt/fallback',
      branch: 'feature',
    });
    expect(mockRemoveRegisteredWorktree).toHaveBeenCalledWith('/wt/fallback', expect.objectContaining({ force: true }));
  });
});

describe('parsePorcelainStatus', () => {
  test('counts each category from real porcelain output', () => {
    const output = [
      ' M src/a.ts',
      'A  src/b.ts',
      ' D src/c.ts',
      'R  old.ts -> new.ts',
      '?? untracked.ts',
    ].join('\n');
    expect(parsePorcelainStatus(output)).toEqual({
      modified: 1, added: 1, deleted: 1, renamed: 1, untracked: 1,
    });
  });

  test('counts a path once when index and worktree both changed', () => {
    // "MM" is one file modified in both, not two modifications.
    expect(parsePorcelainStatus('MM src/a.ts')).toEqual({
      modified: 1, added: 0, deleted: 0, renamed: 0, untracked: 0,
    });
  });

  test('an added-then-modified path counts as added, not double-counted', () => {
    expect(parsePorcelainStatus('AM src/a.ts')).toEqual({
      modified: 0, added: 1, deleted: 0, renamed: 0, untracked: 0,
    });
  });

  test('a clean tree is all zeroes', () => {
    expect(parsePorcelainStatus('')).toEqual({
      modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0,
    });
  });

  test('unknown status codes fall back to modified rather than being dropped', () => {
    // Undercounting would let a dirty tree read as clean in the UI.
    expect(parsePorcelainStatus('T  src/typechange.ts').modified).toBe(1);
  });
});

describe('inspectWorktreeCleanup', () => {
  function taskWithWorktree(opts: { branch?: string; detached?: boolean } = {}) {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/project');
    taskStore.addSession(task.id, {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/wt/feature-branch',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: opts.branch ?? 'feature',
      gitCommit: 'abc123',
      ...(opts.detached ? { gitIsDetached: true } : {}),
    });
    taskStore.completeTask(task.id);
    return { taskStore, taskId: task.id };
  }

  test('clean, merged worktree is removable and reports its evidence', async () => {
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({ 'status --porcelain': '', 'log': '', 'symbolic-ref': 'refs/remotes/origin/main\n' });
    const { taskStore, taskId } = taskWithWorktree();

    const verdict = await inspectWorktreeCleanup(taskStore, taskId, '/wt/feature-branch');

    expect(verdict.removable).toBe(true);
    expect(verdict.blocker).toBeUndefined();
    expect(verdict.worktreeName).toBe('feature-branch');
    expect(verdict.branch).toBe('feature');
    expect(verdict.evidence.dirty).toEqual({ modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0 });
    expect(verdict.evidence.aheadCount).toBe(0);
  });

  test('a merge-base subprocess failure never becomes patch-equivalent', async () => {
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({
      'status --porcelain': '',
      'merge-base': 'error',
      'log': '',
      'symbolic-ref': 'refs/remotes/origin/main\n',
      'rev-list': '0\t0',
    });
    const { taskStore, taskId } = taskWithWorktree();

    const verdict = await inspectWorktreeCleanup(taskStore, taskId, '/wt/feature-branch');

    expect(verdict.removable).toBe(false);
    expect(verdict.blocker).toBe('unmerged-check-failed');
    expect(verdict.evidence.aheadCount).toBe(0);
  });

  test('dirty worktree is blocked AND still reports the ahead-count', async () => {
    // The pre-refactor isClean returned on the first failure, so the ahead-count
    // was never gathered. The drawer shows both, so both must be probed.
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({
      'status --porcelain': ' M src/a.ts\n?? new.ts\n',
      'merge-base': 'not-ancestor',
      'log': 'abc123 commit one\ndef456 commit two\n',
      'symbolic-ref': 'refs/remotes/origin/main\n',
      'rev-list': '0\t2',
    });
    const { taskStore, taskId } = taskWithWorktree();

    const verdict = await inspectWorktreeCleanup(taskStore, taskId, '/wt/feature-branch');

    expect(verdict.removable).toBe(false);
    expect(verdict.blocker).toBe('uncommitted-changes');
    expect(verdict.evidence.dirty).toMatchObject({ modified: 1, untracked: 1 });
    expect(verdict.evidence.aheadCount).toBe(2);
  });

  test('clean but unmerged worktree is blocked as unmerged-commits', async () => {
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({
      'status --porcelain': '',
      'merge-base': 'not-ancestor',
      'log': 'abc123 unmerged work\n',
      'symbolic-ref': 'refs/remotes/origin/main\n',
      'rev-list': '0\t1',
    });
    const { taskStore, taskId } = taskWithWorktree();

    const verdict = await inspectWorktreeCleanup(taskStore, taskId, '/wt/feature-branch');

    expect(verdict.blocker).toBe('unmerged-commits');
    expect(verdict.evidence.aheadCount).toBe(1);
  });

  test('missing path reports not-found', async () => {
    mockExistsSync.mockReturnValue(false);
    const { taskStore, taskId } = taskWithWorktree();

    const verdict = await inspectWorktreeCleanup(taskStore, taskId, '/wt/feature-branch');

    expect(verdict.blocker).toBe('not-found');
  });

  test('identity guard wins over cleanliness and gathers no evidence', async () => {
    // A clean primary checkout must never read as removable, and the guard
    // trips before any content probe runs.
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({ 'status --porcelain': '', 'log': '', 'symbolic-ref': 'refs/remotes/origin/main\n' });
    mockRemovalGuard.mockResolvedValue('primary-working-tree');
    const { taskStore, taskId } = taskWithWorktree();

    const verdict = await inspectWorktreeCleanup(taskStore, taskId, '/wt/feature-branch');

    expect(verdict.removable).toBe(false);
    expect(verdict.blocker).toBe('primary-working-tree');
    expect(verdict.evidence.dirty).toBeUndefined();
  });

  test('detached HEAD is blocked without probing status', async () => {
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({ 'status --porcelain': '', 'log': '', 'symbolic-ref': 'refs/remotes/origin/main\n' });
    const { taskStore, taskId } = taskWithWorktree({ detached: true });

    const verdict = await inspectWorktreeCleanup(taskStore, taskId, '/wt/feature-branch');

    expect(verdict.blocker).toBe('detached-head');
  });

  test('worktree shared with another active task is blocked', async () => {
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({ 'status --porcelain': '', 'log': '', 'symbolic-ref': 'refs/remotes/origin/main\n' });
    const { taskStore, taskId } = taskWithWorktree();
    // A second, still-open task on the same worktree.
    const other = taskStore.createTask('Other work', '/project');
    taskStore.addSession(other.id, {
      tmuxSession: 's2',
      agentType: 'claude-code',
      cwd: '/wt/feature-branch',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'feature',
    });

    const verdict = await inspectWorktreeCleanup(taskStore, taskId, '/wt/feature-branch');

    expect(verdict.blocker).toBe('shared-with-active-task');
  });

  test('inspection does not mutate anything', async () => {
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({ 'status --porcelain': '', 'log': '', 'symbolic-ref': 'refs/remotes/origin/main\n' });
    const { taskStore, taskId } = taskWithWorktree();

    await inspectWorktreeCleanup(taskStore, taskId, '/wt/feature-branch');

    expect(mockRemoveRegisteredWorktree).not.toHaveBeenCalled();
    expect(taskStore.getTask(taskId)!.sessions[0].worktreeHealth).not.toBe('cleaned_up');
  });
});

describe('inspectWorktreeCleanup — remaining blockers', () => {
  function storeWith(sessionOverrides: Record<string, unknown> = {}) {
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Fix bug', '/project');
    taskStore.addSession(task.id, {
      tmuxSession: 's1',
      agentType: 'claude-code',
      cwd: '/wt/feature-branch',
      createdAt: new Date(),
      gitIsWorktree: true,
      gitBranch: 'feature',
      ...sessionOverrides,
    } as never);
    taskStore.completeTask(task.id);
    return { taskStore, taskId: task.id };
  }

  test('a session with no branch is blocked without probing status', async () => {
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({ 'status --porcelain': '', 'log': '', 'symbolic-ref': 'refs/remotes/origin/main\n' });
    const { taskStore, taskId } = storeWith({ gitBranch: undefined });

    const verdict = await inspectWorktreeCleanup(taskStore, taskId, '/wt/feature-branch');

    expect(verdict.blocker).toBe('no-branch');
    expect(verdict.evidence.dirty).toBeUndefined();
  });

  test('a failing git status blocks, and still reports the ahead-count it could gather', async () => {
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({
      'status --porcelain': 'error',
      'merge-base': 'error',
      'log': 'abc123 one\n',
      'symbolic-ref': 'refs/remotes/origin/main\n',
      'rev-list': '0\t1',
    });
    const { taskStore, taskId } = storeWith();

    const verdict = await inspectWorktreeCleanup(taskStore, taskId, '/wt/feature-branch');

    expect(verdict.blocker).toBe('git-status-failed');
    expect(verdict.evidence.dirty).toBeUndefined();
    expect(verdict.evidence.aheadCount).toBe(1);
  });

  test('a failing merge check blocks conservatively, keeping the dirty evidence', async () => {
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({
      'status --porcelain': '',
      'merge-base': 'error',
      'log': 'error',
      'symbolic-ref': 'refs/remotes/origin/main\n',
      'rev-list': 'error',
    });
    const { taskStore, taskId } = storeWith();

    const verdict = await inspectWorktreeCleanup(taskStore, taskId, '/wt/feature-branch');

    expect(verdict.blocker).toBe('unmerged-check-failed');
    expect(verdict.evidence.dirty).toEqual({ modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0 });
    expect(verdict.evidence.aheadCount).toBeUndefined();
  });

  test('a protected marker blocks before any content probe', async () => {
    // Every other test in this file deliberately makes `.kookr-protected`
    // absent, so this path would otherwise never be reached.
    mockExistsSync.mockReturnValue(true);
    mockGitResponses({ 'status --porcelain': '', 'log': '', 'symbolic-ref': 'refs/remotes/origin/main\n' });
    const { taskStore, taskId } = storeWith();

    const verdict = await inspectWorktreeCleanup(taskStore, taskId, '/wt/feature-branch');

    expect(verdict.blocker).toBe('protected-marker');
    expect(verdict.evidence.dirty).toBeUndefined();
  });
});

describe('inspectTaskWorktrees', () => {
  test('returns one verdict per distinct worktree the task owns', async () => {
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({ 'status --porcelain': '', 'log': '', 'symbolic-ref': 'refs/remotes/origin/main\n' });
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Two worktrees', '/project');
    for (const [tmux, cwd] of [['s1', '/wt/one'], ['s2', '/wt/two']]) {
      taskStore.addSession(task.id, {
        tmuxSession: tmux, agentType: 'claude-code', cwd, createdAt: new Date(),
        gitIsWorktree: true, gitBranch: 'feature',
      } as never);
    }
    taskStore.completeTask(task.id);

    const verdicts = await inspectTaskWorktrees(taskStore, task.id);

    expect(verdicts.map((v) => v.worktreePath)).toEqual(['/wt/one', '/wt/two']);
  });

  test('deduplicates sessions that share one worktree', async () => {
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({ 'status --porcelain': '', 'log': '', 'symbolic-ref': 'refs/remotes/origin/main\n' });
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Shared cwd', '/project');
    for (const tmux of ['s1', 's2']) {
      taskStore.addSession(task.id, {
        tmuxSession: tmux, agentType: 'claude-code', cwd: '/wt/same', createdAt: new Date(),
        gitIsWorktree: true, gitBranch: 'feature',
      } as never);
    }
    taskStore.completeTask(task.id);

    const verdicts = await inspectTaskWorktrees(taskStore, task.id);

    expect(verdicts).toHaveLength(1);
  });

  test('ignores sessions that are not worktrees', async () => {
    mockExistsSync.mockImplementation((p: string) => !p.toString().endsWith('.kookr-protected'));
    mockGitResponses({ 'status --porcelain': '', 'log': '', 'symbolic-ref': 'refs/remotes/origin/main\n' });
    const taskStore = new TaskStore();
    const task = taskStore.createTask('Plain checkout', '/project');
    taskStore.addSession(task.id, {
      tmuxSession: 's1', agentType: 'claude-code', cwd: '/plain', createdAt: new Date(),
      gitIsWorktree: false,
    } as never);
    taskStore.completeTask(task.id);

    expect(await inspectTaskWorktrees(taskStore, task.id)).toEqual([]);
  });

  test('an unknown task yields no verdicts rather than throwing', async () => {
    expect(await inspectTaskWorktrees(new TaskStore(), 'nope')).toEqual([]);
  });
});
