import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gitExecEnv } from '../core/git-helpers.js';
import { cleanupReconciledTaskWorktrees, cleanupTaskWorktrees, inspectTaskWorktrees } from './git-worktree.js';
import { TaskStore } from '../core/tasks.js';

function cleanGitEnv(): NodeJS.ProcessEnv {
  return gitExecEnv();
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    env: cleanGitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitFile(cwd: string, name: string, contents: string, message: string): string {
  writeFileSync(join(cwd, name), contents);
  git(cwd, 'add', name);
  git(cwd, 'commit', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

function refExists(cwd: string, ref: string): boolean {
  try {
    git(cwd, 'show-ref', '--verify', ref);
    return true;
  } catch {
    return false;
  }
}

interface WorktreeFixture {
  root: string;
  repo: string;
  worktree: string;
  branchHead: string;
}

function createFixture(): WorktreeFixture {
  const root = mkdtempSync(join(tmpdir(), 'kookr-worktree-verdict-'));
  const repo = join(root, 'repo');
  const worktree = join(root, 'feature-worktree');
  mkdirSync(repo);

  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'kookr-test@example.com');
  git(repo, 'config', 'user.name', 'Kookr Test');
  const baseHead = commitFile(repo, 'README.md', 'base\n', 'initial');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/example/repo.git');
  git(repo, 'update-ref', 'refs/remotes/origin/main', baseHead);
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git(repo, 'worktree', 'add', '-b', 'feature', worktree, 'main');
  const branchHead = commitFile(worktree, 'feature.txt', 'feature\n', 'feature change');

  return { root, repo, worktree, branchHead };
}

function taskFixture(fixture: WorktreeFixture) {
  const taskStore = new TaskStore();
  const task = taskStore.createTask('Inspect worktree', fixture.repo);
  taskStore.addSession(task.id, {
    tmuxSession: 'test-session',
    agentType: 'claude-code',
    cwd: fixture.worktree,
    createdAt: new Date(),
    gitIsWorktree: true,
    gitBranch: 'feature',
    gitCommit: fixture.branchHead,
  });
  taskStore.completeTask(task.id);
  return { taskStore, taskId: task.id };
}

function inspectFixture(fixture: WorktreeFixture) {
  const { taskStore, taskId } = taskFixture(fixture);
  return inspectTaskWorktrees(taskStore, taskId).then(([verdict]) => verdict);
}

describe('inspectWorktreeCleanup real git integration', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('accepts a squash-merged branch with a different commit SHA', async () => {
    const fixture = createFixture();
    roots.push(fixture.root);

    // Keep local main at the pre-feature commit while publishing a different-
    // SHA squash commit through the remote-tracking default ref.
    git(fixture.repo, 'switch', '-c', 'squash-result', 'main');
    git(fixture.repo, 'merge', '--squash', 'feature');
    git(fixture.repo, 'commit', '-m', 'squash feature');
    const squashHead = git(fixture.repo, 'rev-parse', 'HEAD');
    git(fixture.repo, 'update-ref', 'refs/remotes/origin/main', squashHead);

    const verdict = await inspectFixture(fixture);

    expect(verdict).toMatchObject({ removable: true, branch: 'feature' });
    expect(verdict.blocker).toBeUndefined();
    expect(verdict.evidence.aheadCount).toBe(1);
  }, 10_000);

  it('accepts a multi-commit branch whose aggregate change was squash-merged', async () => {
    const fixture = createFixture();
    roots.push(fixture.root);
    fixture.branchHead = commitFile(fixture.worktree, 'second-feature.txt', 'second feature\n', 'second feature change');

    git(fixture.repo, 'switch', '-c', 'squash-result', 'main');
    git(fixture.repo, 'merge', '--squash', 'feature');
    git(fixture.repo, 'commit', '-m', 'squash multi-commit feature');
    commitFile(fixture.repo, 'unrelated.txt', 'unrelated baseline change\n', 'unrelated baseline change');
    const squashHead = git(fixture.repo, 'rev-parse', 'HEAD');
    git(fixture.repo, 'update-ref', 'refs/remotes/origin/main', squashHead);

    const verdict = await inspectFixture(fixture);

    expect(verdict).toMatchObject({ removable: true, branch: 'feature' });
    expect(verdict.blocker).toBeUndefined();
    expect(verdict.evidence.aheadCount).toBe(2);
  }, 10_000);

  it('uses origin/main when the local main ref is stale', async () => {
    const fixture = createFixture();
    roots.push(fixture.root);

    git(fixture.repo, 'switch', '-c', 'merge-result', 'main');
    git(fixture.repo, 'merge', '--no-ff', 'feature', '-m', 'merge feature');
    const mergedHead = git(fixture.repo, 'rev-parse', 'HEAD');
    git(fixture.repo, 'update-ref', 'refs/remotes/origin/main', mergedHead);

    const verdict = await inspectFixture(fixture);

    expect(verdict).toMatchObject({ removable: true, branch: 'feature' });
    expect(verdict.blocker).toBeUndefined();
    expect(verdict.evidence.aheadCount).toBe(0);
  }, 10_000);

  it('continues to block a genuinely unique branch', async () => {
    const fixture = createFixture();
    roots.push(fixture.root);

    const verdict = await inspectFixture(fixture);

    expect(verdict).toMatchObject({ removable: false, blocker: 'unmerged-commits' });
    expect(verdict.evidence.aheadCount).toBe(1);
  }, 10_000);

  it('deletes a squash-equivalent branch after removing its worktree', async () => {
    const fixture = createFixture();
    roots.push(fixture.root);
    fixture.branchHead = commitFile(fixture.worktree, 'second-feature.txt', 'second feature\n', 'second feature change');

    git(fixture.repo, 'switch', '-c', 'squash-result', 'main');
    git(fixture.repo, 'merge', '--squash', 'feature');
    git(fixture.repo, 'commit', '-m', 'squash feature for cleanup');
    const squashHead = git(fixture.repo, 'rev-parse', 'HEAD');
    git(fixture.repo, 'update-ref', 'refs/remotes/origin/main', squashHead);

    const { taskStore, taskId } = taskFixture(fixture);
    await cleanupTaskWorktrees(taskStore, taskId);

    expect(existsSync(fixture.worktree)).toBe(false);
    expect(refExists(fixture.repo, 'refs/heads/feature')).toBe(false);
    expect(taskStore.getTask(taskId)?.sessions[0]?.worktreeHealth).toBe('cleaned_up');
  }, 10_000);

  it('reaps a reconcile-completed task worktree end-to-end (#1727)', async () => {
    const fixture = createFixture();
    roots.push(fixture.root);
    fixture.branchHead = commitFile(fixture.worktree, 'second-feature.txt', 'second feature\n', 'second feature change');

    git(fixture.repo, 'switch', '-c', 'squash-result', 'main');
    git(fixture.repo, 'merge', '--squash', 'feature');
    git(fixture.repo, 'commit', '-m', 'squash feature for reconcile cleanup');
    const squashHead = git(fixture.repo, 'rev-parse', 'HEAD');
    git(fixture.repo, 'update-ref', 'refs/remotes/origin/main', squashHead);

    const { taskStore, taskId } = taskFixture(fixture);
    const cleaned = await cleanupReconciledTaskWorktrees(
      taskStore,
      { tasksCompleted: [taskId], tasksTerminated: [] },
    );

    expect(cleaned).toEqual([taskId]);
    expect(existsSync(fixture.worktree)).toBe(false);
    expect(refExists(fixture.repo, 'refs/heads/feature')).toBe(false);
    expect(taskStore.getTask(taskId)?.sessions[0]?.worktreeHealth).toBe('cleaned_up');
  }, 10_000);
});
