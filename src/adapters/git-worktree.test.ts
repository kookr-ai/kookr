import { describe, test, expect, vi, beforeEach } from 'vitest';

// Hoist mock functions so they're available in vi.mock factories
const { mockExecFile, mockExistsSync, mockRm, mockRemovalGuard } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockExistsSync: vi.fn(),
  mockRm: vi.fn(),
  mockRemovalGuard: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}));

vi.mock('node:fs/promises', () => ({
  rm: mockRm,
}));

vi.mock('./worktree-safety.js', () => ({
  getWorktreeRemovalGuardReason: mockRemovalGuard,
}));

import {
  cleanupTaskWorktrees,
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
 * handlers is a map from a substring of the args to { stdout } or 'error'.
 */
function mockGitResponses(handlers: Record<string, string | 'error'>) {
  mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
    const argsStr = args.join(' ');
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
    if (args.includes('--git-common-dir')) {
      cb(null, { stdout: `${args[1]}/.git\n`, stderr: '' });
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
  mockRm.mockReset();
  mockRm.mockResolvedValue(undefined);
  mockRemovalGuard.mockReset();
  mockRemovalGuard.mockResolvedValue(undefined);
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
    });
    taskStore.completeTask(task.id);

    const { log, events } = makeFakeLog();
    setupCleanWorktree();

    await cleanupTaskWorktrees(taskStore, task.id, log);

    // Directory removed
    expect(mockRm).toHaveBeenCalledWith('/wt/feature-branch', { recursive: true, force: true });
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
      ['-C', '/wt/feature-branch', 'symbolic-ref', 'refs/remotes/origin/HEAD'],
      expect.any(Object),
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
    expect(mockRm).not.toHaveBeenCalled();

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
    expect(mockRm).not.toHaveBeenCalled();
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
    expect(mockRm).not.toHaveBeenCalled();

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

    expect(mockRm).not.toHaveBeenCalled();
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

    expect(mockRm).not.toHaveBeenCalled();
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

    expect(mockRm).not.toHaveBeenCalled();
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

    expect(mockRm).not.toHaveBeenCalled();
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

    expect(mockRm).not.toHaveBeenCalled();
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

    expect(mockRm).not.toHaveBeenCalled();
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
      ['-C', '/other-repo/wt/feature', 'symbolic-ref', 'refs/remotes/origin/HEAD'],
      expect.any(Object),
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
    const resolveCallOrder = mockExecFile.mock.invocationCallOrder.find((_, index) =>
      mockExecFile.mock.calls[index][1].includes('--git-common-dir'));
    expect(resolveCallOrder).toBeLessThan(mockRm.mock.invocationCallOrder[0]);
    const pruneCallIndex = mockExecFile.mock.calls.findIndex((call) => call[1].includes('prune'));
    expect(mockExecFile.mock.invocationCallOrder[pruneCallIndex]).toBeGreaterThan(
      mockRm.mock.invocationCallOrder[0],
    );
  });

  test('repository context resolution failure preserves the worktree', async () => {
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

    await cleanupTaskWorktrees(taskStore, task.id, log);

    expect(mockRm).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'worktree_kept',
      worktreePath: '/wt/feature',
      reason: 'repository context unavailable',
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

    expect(mockRm).not.toHaveBeenCalled();
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

  test('rm failure → worktree_cleanup_failed logged', async () => {
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
    mockRm.mockRejectedValue(new Error('EBUSY: resource busy'));

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

    expect(mockRm).not.toHaveBeenCalled();
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
      'log': 'abc1234 Add feature\ndef5678 Fix bug\n',
      'symbolic-ref': 'refs/remotes/origin/main\n',
    });

    await cleanupTaskWorktrees(taskStore, task.id, log);

    expect(mockRm).not.toHaveBeenCalled();
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

    expect(mockRm).toHaveBeenCalledTimes(2);
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
    expect(mockRm).toHaveBeenCalledTimes(1);
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
      // When symbolic-ref fails, getDefaultBranch returns 'main'
      // log with main..feature returns empty → clean
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
    expect(mockRm).toHaveBeenCalledWith('/wt/fallback', { recursive: true, force: true });
  });
});
