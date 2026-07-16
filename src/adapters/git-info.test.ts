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
      expect(result!.worktreeRoot).toBe(dir);
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
      expect(result!.worktreeRoot).toBe(worktreeDir);
      expect(result!.gitDir).toBe(join(mainGitDir, 'worktrees', 'my-worktree'));
    } finally {
      rmSync(mainDir, { recursive: true });
      rmSync(worktreeDir, { recursive: true });
    }
  });

  test('handles branch with no ref file or packed ref', async () => {
    const dir = makeTempDir();
    const gitDir = join(dir, '.git');
    mkdirSync(gitDir);
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    // Don't create refs/heads/main or packed-refs — commit cannot resolve.

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

  test('resolves commit from packed refs when no loose ref exists', async () => {
    const dir = makeTempDir();
    const gitDir = join(dir, '.git');
    mkdirSync(gitDir);
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(
      join(gitDir, 'packed-refs'),
      '# pack-refs with: peeled fully-peeled sorted\nfedcba9876543210fedcba9876543210fedcba98 refs/heads/main\n',
    );

    try {
      const result = await getGitInfo(dir);
      expect(result).toMatchObject({
        branch: 'main',
        commit: 'fedcba9',
        isWorktree: false,
        isDetached: false,
        worktreeRoot: dir,
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test('reads worktree branch from a nested file path', async () => {
    const mainDir = makeTempDir();
    const worktreeDir = makeTempDir();
    const mainGitDir = join(mainDir, '.git');
    const linkedGitDir = join(mainGitDir, 'worktrees', 'nested-worktree');
    const nestedFile = join(worktreeDir, 'src', 'core', 'file.ts');

    mkdirSync(linkedGitDir, { recursive: true });
    mkdirSync(join(mainGitDir, 'refs', 'heads', 'fix'), { recursive: true });
    mkdirSync(join(worktreeDir, 'src', 'core'), { recursive: true });
    writeFileSync(join(mainGitDir, 'refs', 'heads', 'fix', 'worktree-branch'), '1234567890abcdef1234567890abcdef12345678\n');
    writeFileSync(join(linkedGitDir, 'HEAD'), 'ref: refs/heads/fix/worktree-branch\n');
    writeFileSync(join(worktreeDir, '.git'), `gitdir: ${linkedGitDir}\n`);
    writeFileSync(nestedFile, 'export const value = 1;\n');

    try {
      const result = await getGitInfo(nestedFile);
      expect(result).toMatchObject({
        branch: 'fix/worktree-branch',
        commit: '1234567',
        isWorktree: true,
        isDetached: false,
        worktreeRoot: worktreeDir,
      });
    } finally {
      rmSync(mainDir, { recursive: true });
      rmSync(worktreeDir, { recursive: true });
    }
  });

  test('uses worktree registry entry before filesystem fallback', async () => {
    const result = await getGitInfo('/missing-from-disk', {
      byPath: () => ({
        path: '/missing-from-disk',
        branch: 'feature/live',
        head: 'abcdef1234567890abcdef1234567890abcdef12',
        isDetached: false,
        isPrunable: false,
        isBare: false,
        isMain: false,
      }),
    });

    expect(result).toEqual({
      branch: 'feature/live',
      commit: 'abcdef1',
      isWorktree: true,
      isDetached: false,
      worktreeRoot: '/missing-from-disk',
    });
  });

  test('does not report a bare registry entry as a worktree', async () => {
    const result = await getGitInfo('/bare-repo', {
      byPath: () => ({
        path: '/bare-repo',
        branch: null,
        head: '',
        isDetached: false,
        isPrunable: false,
        isBare: true,
        isMain: false,
      }),
    });

    expect(result).toEqual({
      branch: null,
      commit: '',
      isWorktree: false,
      isDetached: false,
      worktreeRoot: '/bare-repo',
    });
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
