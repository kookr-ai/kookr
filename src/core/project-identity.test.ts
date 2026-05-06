import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  normalizeGitRemote,
  projectDisplayName,
  projectColorIndex,
  projectIdFromRepoSpecifier,
  extractRepoSpecifierFromGhCommand,
  extractShellCwd,
  getProjectId,
  projectIdFromPrUrl,
} from './project-identity.js';

function runGit(args: string[]): string {
  const env = { ...process.env };
  delete env.GIT_COMMON_DIR;
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_PREFIX;
  delete env.GIT_WORK_TREE;

  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env }).trim();
}

describe('normalizeGitRemote', () => {
  test('HTTPS URL with .git suffix', () => {
    expect(normalizeGitRemote('https://github.com/grafana/grafana.git'))
      .toBe('github.com/grafana/grafana');
  });

  test('HTTPS URL without .git suffix', () => {
    expect(normalizeGitRemote('https://github.com/grafana/grafana'))
      .toBe('github.com/grafana/grafana');
  });

  test('SSH URL with colon syntax', () => {
    expect(normalizeGitRemote('git@github.com:grafana/grafana.git'))
      .toBe('github.com/grafana/grafana');
  });

  test('SSH URL without .git suffix', () => {
    expect(normalizeGitRemote('git@github.com:owner/repo'))
      .toBe('github.com/owner/repo');
  });

  test('git:// protocol', () => {
    expect(normalizeGitRemote('git://github.com/owner/repo.git'))
      .toBe('github.com/owner/repo');
  });

  test('ssh:// protocol', () => {
    expect(normalizeGitRemote('ssh://git@github.com/owner/repo.git'))
      .toBe('github.com/owner/repo');
  });

  test('trailing slash stripped', () => {
    expect(normalizeGitRemote('https://github.com/owner/repo/'))
      .toBe('github.com/owner/repo');
  });

  test('case-insensitive normalization', () => {
    expect(normalizeGitRemote('https://GitHub.com/Owner/Repo.git'))
      .toBe('github.com/owner/repo');
  });

  test('whitespace trimmed', () => {
    expect(normalizeGitRemote('  https://github.com/a/b.git  '))
      .toBe('github.com/a/b');
  });

  test('GitLab SSH URL', () => {
    expect(normalizeGitRemote('git@gitlab.com:org/project.git'))
      .toBe('gitlab.com/org/project');
  });

  test('Codeberg HTTPS URL', () => {
    expect(normalizeGitRemote('https://codeberg.org/user/repo'))
      .toBe('codeberg.org/user/repo');
  });
});

describe('projectDisplayName', () => {
  test('host/owner/repo returns owner/repo', () => {
    expect(projectDisplayName('github.com/grafana/grafana')).toBe('grafana/grafana');
  });

  test('local/dirname returns dirname', () => {
    expect(projectDisplayName('local/my-project')).toBe('my-project');
  });

  test('deep path returns everything after host', () => {
    expect(projectDisplayName('github.com/org/sub/repo')).toBe('org/sub/repo');
  });
});

describe('projectIdFromRepoSpecifier', () => {
  test('converts owner/repo to github project ID', () => {
    expect(projectIdFromRepoSpecifier('rust-lang/rust')).toBe('github.com/rust-lang/rust');
  });

  test('normalizes full remote URLs', () => {
    expect(projectIdFromRepoSpecifier('git@github.com:Rust-Lang/Rust.git'))
      .toBe('github.com/rust-lang/rust');
  });

  test('returns null for invalid specifiers', () => {
    expect(projectIdFromRepoSpecifier('not-a-repo')).toBeNull();
  });
});

describe('extractRepoSpecifierFromGhCommand', () => {
  test('extracts -R owner/repo', () => {
    expect(extractRepoSpecifierFromGhCommand('gh pr create -R rust-lang/rust --title test'))
      .toBe('rust-lang/rust');
  });

  test('extracts quoted --repo value', () => {
    expect(extractRepoSpecifierFromGhCommand('gh pr create --repo "Grafana/Grafana"'))
      .toBe('Grafana/Grafana');
  });

  test('extracts equals syntax', () => {
    expect(extractRepoSpecifierFromGhCommand('gh pr create --repo=owner/repo'))
      .toBe('owner/repo');
  });
});

describe('extractShellCwd', () => {
  test('extracts command-level cwd from multiline command', () => {
    expect(extractShellCwd('cd /workspace/rust\ngh pr create --title test'))
      .toBe('/workspace/rust');
  });

  test('extracts quoted cwd', () => {
    expect(extractShellCwd('cd "/tmp/my repo" && gh pr create')).toBe('/tmp/my repo');
  });

  test('returns null when command does not cd', () => {
    expect(extractShellCwd('gh pr create --title test')).toBeNull();
  });
});

describe('projectIdFromPrUrl', () => {
  test('derives project ID from GitHub pull request URL', () => {
    expect(projectIdFromPrUrl('https://github.com/rust-lang/rust/pull/153926'))
      .toBe('github.com/rust-lang/rust');
  });

  test('returns null for non-PR URLs', () => {
    expect(projectIdFromPrUrl('https://github.com/rust-lang/rust/issues/1')).toBeNull();
  });
});

describe('getProjectId', () => {
  test('ignores inherited git env when inspecting a nested repo', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'project-identity-test-'));
    const repoDir = join(tempDir, 'rust-worktree');

    runGit(['init', repoDir]);
    runGit(['-C', repoDir, 'remote', 'add', 'origin', 'https://github.com/rust-lang/rust.git']);

    const previousGitDir = process.env.GIT_DIR;
    const previousGitWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = runGit(['rev-parse', '--absolute-git-dir']);
    process.env.GIT_WORK_TREE = process.cwd();

    try {
      await expect(getProjectId(repoDir)).resolves.toBe('github.com/rust-lang/rust');
    } finally {
      if (previousGitDir === undefined) {
        delete process.env.GIT_DIR;
      } else {
        process.env.GIT_DIR = previousGitDir;
      }

      if (previousGitWorkTree === undefined) {
        delete process.env.GIT_WORK_TREE;
      } else {
        process.env.GIT_WORK_TREE = previousGitWorkTree;
      }

      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('projectColorIndex', () => {
  test('returns a number 0-7', () => {
    const idx = projectColorIndex('github.com/grafana/grafana');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(8);
  });

  test('same input always returns same color', () => {
    const a = projectColorIndex('github.com/test/repo');
    const b = projectColorIndex('github.com/test/repo');
    expect(a).toBe(b);
  });

  test('different inputs produce different colors (probabilistic)', () => {
    const colors = new Set<number>();
    for (let i = 0; i < 20; i++) {
      colors.add(projectColorIndex(`github.com/org/repo-${i}`));
    }
    // With 20 inputs and 8 colors, we should have at least 3 distinct colors
    expect(colors.size).toBeGreaterThanOrEqual(3);
  });
});
