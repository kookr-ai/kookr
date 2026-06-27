import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
        'Delivery is pre-authorized for this task: when your work is committed and verified, push the branch and open the PR without asking — the PR is the review gate. If the work does not actually satisfy the task, do NOT open a PR; stop and report what\'s wrong instead.',
      );
      expect(prompt).not.toContain('ask the user whether to push the branch and open a PR');
      expect(prompt).toContain('git worktree add');
      expect(prompt).toContain('Do NOT commit to main');
    } finally {
      await rm(repoDir, { recursive: true, force: true });
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
