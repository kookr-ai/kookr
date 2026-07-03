import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { applyWorktreeGuardrails } from './worktree-guardrails.js';

function git(cwd: string, ...args: string[]) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  execFileSync('git', args, { cwd, stdio: 'pipe', env });
}

async function initGitRepo(dir: string) {
  await mkdir(dir, { recursive: true });
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test User');
  await writeFile(join(dir, 'README.md'), '# test\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-m', 'init');
  git(dir, 'branch', '-M', 'main');
}

describe('applyWorktreeGuardrails', () => {
  it('uses ask-first delivery guidance by default', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'guardrails-'));
    try {
      await initGitRepo(repoDir);

      const prompt = await applyWorktreeGuardrails('Implement it.', repoDir);

      expect(prompt).toContain('ask the user whether to push the branch and open a PR');
      expect(prompt).not.toContain('Delivery is pre-authorized for this task');
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('uses pre-authorized delivery guidance with the escape hatch', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'guardrails-'));
    try {
      await initGitRepo(repoDir);

      const prompt = await applyWorktreeGuardrails('Implement it.', repoDir, 'pre-authorized');

      expect(prompt).toContain(
        'Delivery is pre-authorized for this task: when your work is committed and verified, finish the full delivery cycle without asking again — commit, push the branch, open or update the PR, and report the PR URL.',
      );
      expect(prompt).toContain('If you show a diff or plan and the user approves it, treat that as approval to continue through the full delivery cycle.');
      expect(prompt).toContain('The PR is the review gate.');
      expect(prompt).not.toContain('ask the user whether to push the branch and open a PR');
      expect(prompt).toContain('git worktree add');
      expect(prompt).toContain('Do NOT commit to main');
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('uses a freshly fetched remote default branch as the worktree base when available', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'guardrails-'));
    const remoteDir = await mkdtemp(join(tmpdir(), 'guardrails-origin-'));
    try {
      await initGitRepo(repoDir);
      git(remoteDir, 'init', '--bare');
      git(repoDir, 'checkout', '-b', 'trunk');
      git(repoDir, 'remote', 'add', 'origin', remoteDir);
      git(repoDir, 'push', '-u', 'origin', 'trunk');
      git(repoDir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');

      const prompt = await applyWorktreeGuardrails('Implement it.', repoDir);

      expect(prompt).toContain("Refresh the remote base first: `git fetch origin 'trunk'`.");
      expect(prompt).toContain(`git worktree add ../${basename(repoDir)}-<short-name> -b <feature-branch> 'origin/trunk'`);
      expect(prompt).not.toContain('-b <feature-branch> HEAD');
    } finally {
      await rm(repoDir, { recursive: true, force: true });
      await rm(remoteDir, { recursive: true, force: true });
    }
  });

  it('quotes remote branch names in shell snippets', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'guardrails-'));
    const remoteDir = await mkdtemp(join(tmpdir(), 'guardrails-origin-'));
    try {
      await initGitRepo(repoDir);
      git(remoteDir, 'init', '--bare');
      git(repoDir, 'checkout', '-b', 'main;touch/tmp/kookr-pwn');
      git(repoDir, 'remote', 'add', 'origin', remoteDir);
      git(repoDir, 'push', '-u', 'origin', 'main;touch/tmp/kookr-pwn');
      git(repoDir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main;touch/tmp/kookr-pwn');

      const prompt = await applyWorktreeGuardrails('Implement it.', repoDir);

      expect(prompt).toContain("git fetch origin 'main;touch/tmp/kookr-pwn'");
      expect(prompt).toContain("'origin/main;touch/tmp/kookr-pwn'");
      expect(prompt).not.toContain('git fetch origin main;touch/tmp/kookr-pwn');
    } finally {
      await rm(repoDir, { recursive: true, force: true });
      await rm(remoteDir, { recursive: true, force: true });
    }
  });

  it('does not double-guard pre-authorized prompts', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'guardrails-'));
    try {
      await initGitRepo(repoDir);

      const first = await applyWorktreeGuardrails('Implement it.', repoDir, 'pre-authorized');
      const second = await applyWorktreeGuardrails(first, repoDir);

      expect(second).toBe(first);
      expect(second.match(/Delivery is pre-authorized for this task/g)).toHaveLength(1);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
