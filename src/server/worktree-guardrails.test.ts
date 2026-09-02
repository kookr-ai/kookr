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
  it('uses pre-authorized delivery guidance by default', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'guardrails-'));
    try {
      await initGitRepo(repoDir);

      const prompt = await applyWorktreeGuardrails('Implement it.', repoDir);

      expect(prompt).toContain('Delivery is pre-authorized for this task');
      expect(prompt).not.toContain('ask the user whether to push the branch and open a PR');
      // Investigation follow-through is autonomous when the right size is clear
      // (reflect feedback: agents must not stop after diagnosis to ask for an RFC).
      expect(prompt).toContain('execute it autonomously');
      expect(prompt).toContain('required follow-up');
      expect(prompt).not.toContain('ask which to proceed with rather than waiting to be asked');
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('uses ask-first delivery guidance when explicitly requested', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'guardrails-'));
    try {
      await initGitRepo(repoDir);

      const prompt = await applyWorktreeGuardrails('Implement it.', repoDir, 'ask-first');

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
      expect(prompt).toContain('EXPLICITLY instructs you to merge the PR');
      expect(prompt).toContain('do NOT grant merge authority on their own');
      expect(prompt).not.toContain('ask the user whether to push the branch and open a PR');
      expect(prompt).toContain('git worktree add');
      expect(prompt).toContain('Do NOT commit to main');
      // The escape hatch for a brief that did not survive delivery (#2977).
      // It lives in the preamble precisely so it reaches an agent whose prompt
      // was damaged, which makes its presence load-bearing, not decorative.
      expect(prompt).toContain('kookr-self-report');
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('carries the self-report escape hatch under every delivery policy (#2977)', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'guardrails-'));
    try {
      await initGitRepo(repoDir);
      for (const policy of ['pre-authorized', 'ask-first', 'self-advancing'] as const) {
        const prompt = await applyWorktreeGuardrails('Implement it.', repoDir, policy);
        expect(prompt).toContain('kookr-self-report');
      }
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('emits the extended self-advancing phase contract when the policy is self-advancing', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'guardrails-'));
    const prev = process.env.KOOKR_SELF_ADVANCING_DISABLED;
    delete process.env.KOOKR_SELF_ADVANCING_DISABLED;
    try {
      await initGitRepo(repoDir);

      const prompt = await applyWorktreeGuardrails('Implement it.', repoDir, 'self-advancing');

      expect(prompt).toContain('SELF-ADVANCING phase contract');
      expect(prompt).toContain('INDEPENDENT review verdict');
      expect(prompt).toContain('task-id differs');
      expect(prompt).toContain('MERGE WRAPPER ONLY');
      expect(prompt).toContain('never raw `gh pr merge`');
      expect(prompt).toContain('chain namespace');
      expect(prompt).toContain('per-chain self-merge rate cap');
      expect(prompt).toContain('spawn the next phase');
      expect(prompt).toContain('KOOKR_SELF_ADVANCING_DISABLED');
      // Not the standard preambles.
      expect(prompt).not.toContain('Delivery is pre-authorized for this task');
      expect(prompt).not.toContain('ask the user whether to push the branch and open a PR');
    } finally {
      if (prev === undefined) delete process.env.KOOKR_SELF_ADVANCING_DISABLED;
      else process.env.KOOKR_SELF_ADVANCING_DISABLED = prev;
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('degrades self-advancing to an open-PR gate when the kill switch is set', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'guardrails-'));
    const prev = process.env.KOOKR_SELF_ADVANCING_DISABLED;
    process.env.KOOKR_SELF_ADVANCING_DISABLED = '1';
    try {
      await initGitRepo(repoDir);

      const prompt = await applyWorktreeGuardrails('Implement it.', repoDir, 'self-advancing');

      expect(prompt).toContain('kill switch is set');
      expect(prompt).toContain('HALTED');
      expect(prompt).toContain('Do NOT self-merge while the kill switch is set');
      // No self-merge preamble while halted.
      expect(prompt).not.toContain('self-merge THROUGH THE MERGE WRAPPER ONLY');
    } finally {
      if (prev === undefined) delete process.env.KOOKR_SELF_ADVANCING_DISABLED;
      else process.env.KOOKR_SELF_ADVANCING_DISABLED = prev;
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('produces byte-identical pre-authorized/ask-first guidance regardless of self-advancing support', async () => {
    // Acceptance gate: adding the self-advancing branch must not change the
    // output of the two pre-existing delivery policies.
    const repoDir = await mkdtemp(join(tmpdir(), 'guardrails-'));
    try {
      await initGitRepo(repoDir);

      const preAuth = await applyWorktreeGuardrails('Implement it.', repoDir, 'pre-authorized');
      const askFirst = await applyWorktreeGuardrails('Implement it.', repoDir, 'ask-first');

      // Neither pre-existing policy leaks any self-advancing wording.
      for (const prompt of [preAuth, askFirst]) {
        expect(prompt).not.toContain('SELF-ADVANCING');
        expect(prompt).not.toContain('MERGE WRAPPER ONLY');
        expect(prompt).not.toContain('KOOKR_SELF_ADVANCING_DISABLED');
      }
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
