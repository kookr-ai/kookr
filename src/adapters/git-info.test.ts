import { describe, test, expect } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getGitInfo, isGitBranchCommand } from './git-info.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `git-info-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('getGitInfo', () => {
  test('returns null for non-git directory', async () => {
    const dir = makeTempDir();
    try {
      const result = await getGitInfo(dir);
      expect(result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('returns null for non-existent directory', async () => {
    const result = await getGitInfo('/tmp/does-not-exist-' + randomUUID());
    expect(result).toBeNull();
  });

  test('reads branch from normal git repo', async () => {
    const dir = makeTempDir();
    const gitDir = join(dir, '.git');
    mkdirSync(gitDir);
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    // Create the ref file for commit resolution
    mkdirSync(join(gitDir, 'refs', 'heads'), { recursive: true });
    writeFileSync(join(gitDir, 'refs', 'heads', 'main'), 'abc1234567890abcdef1234567890abcdef123456\n');

    try {
      const result = await getGitInfo(dir);
      expect(result).not.toBeNull();
      expect(result!.branch).toBe('main');
      expect(result!.commit).toBe('abc1234');
      expect(result!.isWorktree).toBe(false);
      expect(result!.isDetached).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('reads namespaced branch (e.g., fix/auth)', async () => {
    const dir = makeTempDir();
    const gitDir = join(dir, '.git');
    mkdirSync(gitDir);
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/fix/auth-bug\n');
    mkdirSync(join(gitDir, 'refs', 'heads', 'fix'), { recursive: true });
    writeFileSync(join(gitDir, 'refs', 'heads', 'fix', 'auth-bug'), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');

    try {
      const result = await getGitInfo(dir);
      expect(result).not.toBeNull();
      expect(result!.branch).toBe('fix/auth-bug');
      expect(result!.commit).toBe('deadbee');
      expect(result!.isDetached).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('detects detached HEAD', async () => {
    const dir = makeTempDir();
    const gitDir = join(dir, '.git');
    mkdirSync(gitDir);
    writeFileSync(join(gitDir, 'HEAD'), 'abc1234567890abcdef1234567890abcdef123456\n');

    try {
      const result = await getGitInfo(dir);
      expect(result).not.toBeNull();
      expect(result!.branch).toBeNull();
      expect(result!.commit).toBe('abc1234');
      expect(result!.isDetached).toBe(true);
      expect(result!.isWorktree).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('detects git worktree', async () => {
    // Simulate a worktree: .git is a file pointing to a gitdir
    const mainDir = makeTempDir();
    const worktreeDir = makeTempDir();

    // Create the main repo's .git structure
    const mainGitDir = join(mainDir, '.git');
    mkdirSync(mainGitDir);
    mkdirSync(join(mainGitDir, 'worktrees', 'my-worktree'), { recursive: true });
    mkdirSync(join(mainGitDir, 'refs', 'heads'), { recursive: true });
    writeFileSync(join(mainGitDir, 'refs', 'heads', 'feature-branch'), 'cafebabecafebabecafebabecafebabecafebabe\n');

    // Write HEAD in the worktree gitdir
    writeFileSync(join(mainGitDir, 'worktrees', 'my-worktree', 'HEAD'), 'ref: refs/heads/feature-branch\n');

    // .git file in the worktree directory
    writeFileSync(join(worktreeDir, '.git'), `gitdir: ${join(mainGitDir, 'worktrees', 'my-worktree')}\n`);

    try {
      const result = await getGitInfo(worktreeDir);
      expect(result).not.toBeNull();
      expect(result!.branch).toBe('feature-branch');
      expect(result!.commit).toBe('cafebab');
      expect(result!.isWorktree).toBe(true);
      expect(result!.isDetached).toBe(false);
    } finally {
      rmSync(mainDir, { recursive: true });
      rmSync(worktreeDir, { recursive: true });
    }
  });

  test('handles branch with no ref file (packed refs)', async () => {
    const dir = makeTempDir();
    const gitDir = join(dir, '.git');
    mkdirSync(gitDir);
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    // Don't create refs/heads/main — simulate packed refs

    try {
      const result = await getGitInfo(dir);
      expect(result).not.toBeNull();
      expect(result!.branch).toBe('main');
      expect(result!.commit).toBeNull(); // Can't resolve without ref file
      expect(result!.isDetached).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('isGitBranchCommand', () => {
  test('detects git checkout', () => {
    expect(isGitBranchCommand({ command: 'git checkout feature-branch' })).toBe(true);
  });

  test('detects git switch', () => {
    expect(isGitBranchCommand({ command: 'git switch -c new-branch' })).toBe(true);
  });

  test('detects git worktree', () => {
    expect(isGitBranchCommand({ command: 'git worktree add ../my-worktree' })).toBe(true);
  });

  test('ignores non-git commands', () => {
    expect(isGitBranchCommand({ command: 'ls -la' })).toBe(false);
  });

  test('ignores git commands that dont change branch', () => {
    expect(isGitBranchCommand({ command: 'git status' })).toBe(false);
    expect(isGitBranchCommand({ command: 'git log' })).toBe(false);
    expect(isGitBranchCommand({ command: 'git add .' })).toBe(false);
  });

  test('returns false for null/undefined input', () => {
    expect(isGitBranchCommand(null)).toBe(false);
    expect(isGitBranchCommand(undefined)).toBe(false);
    expect(isGitBranchCommand('string')).toBe(false);
  });
});
