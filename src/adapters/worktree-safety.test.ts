import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  gitExecEnv,
  NESTED_GIT_ENV_VARS,
} from '../core/git-helpers.js';
import {
  getWorktreeRemovalGuardReason,
  inspectWorktreeRemovalTarget,
  isPrimaryWorkingTree,
  isRegisteredLinkedWorktree,
  looksLikeLinkedWorktree,
  parseRegisteredWorktreeEntries,
  removeRegisteredWorktree,
} from './worktree-safety.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    env: gitExecEnv(),
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

function gitDir(gitDirectory: string, ...args: string[]): string {
  return execFileSync('git', ['--git-dir', gitDirectory, ...args], {
    env: gitExecEnv(),
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

function initRepository(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, 'init', '--quiet');
  git(path, 'config', 'user.email', 'test@example.com');
  git(path, 'config', 'user.name', 'Test User');
  writeFileSync(join(path, 'README.md'), '# test\n');
  git(path, 'add', 'README.md');
  git(path, 'commit', '--quiet', '-m', 'initial');
  git(path, 'branch', '-M', 'main');
}

function addLinkedWorktree(repoPath: string, worktreePath: string, branch = 'feature/removal'): void {
  git(repoPath, 'worktree', 'add', '--quiet', '-b', branch, worktreePath, 'main');
}

describe('worktree removal safety', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'worktree-safety-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('identifies the primary and exact linked worktree, then removes only the linked target', async () => {
    const repo = join(root, 'repo');
    const linked = join(root, 'linked');
    initRepository(repo);
    addLinkedWorktree(repo, linked);

    expect(await isPrimaryWorkingTree(repo)).toBe(true);
    expect(await isPrimaryWorkingTree(linked)).toBe(false);
    expect(looksLikeLinkedWorktree(linked)).toBe(true);
    expect(await isRegisteredLinkedWorktree(repo, repo)).toBe(false);
    expect(await isRegisteredLinkedWorktree(linked, repo)).toBe(true);

    const inspection = await inspectWorktreeRemovalTarget(linked, { repoPath: repo });
    expect(inspection).toMatchObject({
      target: {
        worktreePath: linked,
        branch: 'feature/removal',
        detached: false,
      },
    });

    const primaryRemoval = await removeRegisteredWorktree(repo, { force: true });
    expect(primaryRemoval).toMatchObject({ removed: false, reason: 'primary-working-tree' });
    expect(existsSync(repo)).toBe(true);

    const target = inspection.target!;
    const removal = await removeRegisteredWorktree(linked, {
      repoPath: repo,
      force: true,
      expectedHead: target.head,
      expectedBranch: target.branch,
      expectedDetached: target.detached,
      expectedGitDir: target.gitDir,
    });
    expect(removal).toMatchObject({ removed: true, target });
    expect(existsSync(linked)).toBe(false);
  });

  it('handles a bare registry entry before ordinary linked-worktree entries', async () => {
    const seed = join(root, 'seed');
    const repo = join(root, 'bare-root');
    const linked = join(root, 'bare-linked');
    initRepository(seed);
    mkdirSync(repo);
    execFileSync('git', ['clone', '--quiet', '--bare', seed, join(repo, '.git')], {
      env: gitExecEnv(),
      stdio: 'pipe',
    });
    gitDir(join(repo, '.git'), 'symbolic-ref', 'HEAD', 'refs/heads/main');
    gitDir(join(repo, '.git'), 'worktree', 'add', '--quiet', '-b', 'feature/bare', linked, 'main');

    const entries = parseRegisteredWorktreeEntries(git(repo, 'worktree', 'list', '--porcelain'));
    expect(entries[0]).toMatchObject({ path: repo, bare: true });
    expect(entries.find((entry) => entry.path === linked)).toMatchObject({
      bare: false,
      branch: 'feature/bare',
    });
    expect(await isRegisteredLinkedWorktree(linked, repo)).toBe(true);

    const removal = await removeRegisteredWorktree(linked, { repoPath: repo, force: true });
    expect(removal).toMatchObject({ removed: true });
    expect(existsSync(linked)).toBe(false);
  });

  it('fails closed when the recorded identity, repository context, or branch changes', async () => {
    const repo = join(root, 'repo');
    const otherRepo = join(root, 'other-repo');
    const linked = join(root, 'linked');
    initRepository(repo);
    initRepository(otherRepo);
    addLinkedWorktree(repo, linked);

    const initialInspection = await inspectWorktreeRemovalTarget(linked, { repoPath: repo });
    const initialHead = initialInspection.target!.head;
    writeFileSync(join(linked, 'changed.txt'), 'changed after inspection\n');
    git(linked, 'add', 'changed.txt');
    git(linked, 'commit', '--quiet', '-m', 'change recorded identity');

    const staleHead = await removeRegisteredWorktree(linked, {
      repoPath: repo,
      force: true,
      expectedHead: initialHead,
    });
    expect(staleHead).toMatchObject({ removed: false, reason: 'worktree-identity-changed' });
    expect(existsSync(linked)).toBe(true);

    const detachedMismatch = await removeRegisteredWorktree(linked, {
      repoPath: repo,
      force: true,
      expectedDetached: true,
    });
    expect(detachedMismatch).toMatchObject({ removed: false, reason: 'worktree-identity-changed' });
    expect(existsSync(linked)).toBe(true);

    const gitDirMismatch = await removeRegisteredWorktree(linked, {
      repoPath: repo,
      force: true,
      expectedGitDir: join(repo, '.git', 'worktrees', 'not-the-current-worktree'),
    });
    expect(gitDirMismatch).toMatchObject({ removed: false, reason: 'worktree-identity-changed' });
    expect(existsSync(linked)).toBe(true);

    const stale = await removeRegisteredWorktree(linked, {
      repoPath: repo,
      force: true,
      expectedBranch: 'feature/changed-before-removal',
    });
    expect(stale).toMatchObject({ removed: false, reason: 'worktree-identity-changed' });
    expect(existsSync(linked)).toBe(true);

    const mismatch = await removeRegisteredWorktree(linked, { repoPath: otherRepo, force: true });
    expect(mismatch).toMatchObject({ removed: false, reason: 'repository-context-mismatch' });
    expect(existsSync(linked)).toBe(true);

    const previousProtectedBranches = process.env.KOOKR_PROTECTED_BRANCHES;
    process.env.KOOKR_PROTECTED_BRANCHES = 'feature/removal';
    try {
      await expect(getWorktreeRemovalGuardReason(linked, { repoPath: repo })).resolves.toBe('protected-branch');
      await expect(removeRegisteredWorktree(linked, { repoPath: repo, force: true })).resolves.toMatchObject({
        removed: false,
        reason: 'protected-branch',
      });
      await expect(removeRegisteredWorktree(linked, {
        repoPath: repo,
        force: true,
        confirmProtectedBranch: true,
      })).resolves.toMatchObject({ removed: true });
    } finally {
      if (previousProtectedBranches === undefined) delete process.env.KOOKR_PROTECTED_BRANCHES;
      else process.env.KOOKR_PROTECTED_BRANCHES = previousProtectedBranches;
    }
    expect(existsSync(linked)).toBe(false);
  });

  it('keeps a dirty target when Git refuses a non-forced removal', async () => {
    const repo = join(root, 'repo');
    const linked = join(root, 'linked');
    initRepository(repo);
    addLinkedWorktree(repo, linked);
    writeFileSync(join(linked, 'untracked.txt'), 'keep me\n');

    const removal = await removeRegisteredWorktree(linked, { repoPath: repo });
    expect(removal).toMatchObject({ removed: false, reason: 'git-remove-failed' });
    expect(existsSync(linked)).toBe(true);
    expect(readFileSync(join(linked, 'untracked.txt'), 'utf8')).toBe('keep me\n');

    await expect(removeRegisteredWorktree(linked, { repoPath: repo, force: true })).resolves.toMatchObject({ removed: true });
  });

  it('scrubs nested Git environment variables before resolving the target', async () => {
    const repo = join(root, 'repo');
    const linked = join(root, 'linked');
    initRepository(repo);
    addLinkedWorktree(repo, linked);

    const previous = new Map<string, string | undefined>();
    for (const name of NESTED_GIT_ENV_VARS) {
      previous.set(name, process.env[name]);
      process.env[name] = 'definitely-not-the-target';
    }
    try {
      expect(await isRegisteredLinkedWorktree(linked, repo)).toBe(true);
      await expect(removeRegisteredWorktree(linked, { repoPath: repo, force: true })).resolves.toMatchObject({ removed: true });
    } finally {
      for (const name of NESTED_GIT_ENV_VARS) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(existsSync(linked)).toBe(false);
  });
});
