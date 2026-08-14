import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  normalizeGitRemote,
  projectDisplayName,
  projectColorIndex,
  projectIdFromRepoSpecifier,
  extractRepoSpecifierFromGhCommand,
  extractShellCwd,
  projectDisplayLabel,
  getProjectId,
  projectIdFromPrUrl,
  deriveCanonicalPath,
  isSafeGithubProjectId,
  isSafeGithubSegment,
  sanitizeGithubOwnerRepo,
  projectRepoUrl,
  isSafePullRequestUrl,
  projectIdToOwnerRepo,
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

describe('projectDisplayLabel', () => {
  test('uses the repo name from a remote project ID', () => {
    expect(projectDisplayLabel({ projectId: 'github.com/kookr-ai/kookr' })).toBe('kookr');
  });

  test('uses the local name from a local project ID', () => {
    expect(projectDisplayLabel({ projectId: 'local/my-project' })).toBe('my-project');
  });

  test('falls back to cwd basename when project ID is missing', () => {
    expect(projectDisplayLabel({ cwd: '/workspace/tools/my-app' })).toBe('my-app');
  });

  test('falls back to an empty string when no identity input is available', () => {
    expect(projectDisplayLabel({})).toBe('');
  });

  test('uses canonical protected parent when only cwd is available', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'project-display-label-test-'));
    const parent = join(tempDir, 'kookr');
    const protectedWorktree = join(tempDir, 'kookr-prod');
    mkdirSync(parent);
    mkdirSync(protectedWorktree);

    try {
      expect(projectDisplayLabel({ cwd: protectedWorktree })).toBe('kookr');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
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

describe('deriveCanonicalPath', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'canonical-path-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns null when cwd does not exist', () => {
    expect(deriveCanonicalPath(join(tempDir, 'missing'))).toBeNull();
  });

  test('returns cwd verbatim when it exists and has no carve-out suffix', () => {
    const checkout = join(tempDir, 'grafana');
    mkdirSync(checkout);
    expect(deriveCanonicalPath(checkout)).toBe(checkout);
  });

  test('strips kookr-prod suffix when the parent (un-suffixed) clone exists', () => {
    const parent = join(tempDir, 'kookr');
    const worktree = join(tempDir, 'kookr-prod');
    mkdirSync(parent);
    mkdirSync(worktree);
    expect(deriveCanonicalPath(worktree)).toBe(parent);
  });

  test('returns the suffixed cwd when parent is missing (regression for v2 spec gap)', () => {
    const worktree = join(tempDir, 'kookr-prod');
    mkdirSync(worktree);
    // No `kookr` parent.
    expect(deriveCanonicalPath(worktree)).toBe(worktree);
  });

  test('does NOT strip non-kookr-prod suffixes — generic worktree heuristic dropped', () => {
    const parent = join(tempDir, 'bandwidth-surgery');
    const worktree = join(tempDir, 'bandwidth-surgery-m1-harness');
    mkdirSync(parent);
    mkdirSync(worktree);
    // Even though `bandwidth-surgery` exists, the literal kookr-prod
    // suffix rule does not apply, so cwd is returned verbatim.
    expect(deriveCanonicalPath(worktree)).toBe(worktree);
  });
});

describe('isSafeGithubProjectId', () => {
  test('accepts canonical lowercase ids', () => {
    expect(isSafeGithubProjectId('github.com/cli/cli')).toBe(true);
    expect(isSafeGithubProjectId('github.com/grafana/grafana')).toBe(true);
    expect(isSafeGithubProjectId('github.com/a/b')).toBe(true);
    expect(isSafeGithubProjectId('github.com/some-org/some.repo_name-1')).toBe(true);
  });

  test('rejects non-github prefixes', () => {
    expect(isSafeGithubProjectId('local/myrepo')).toBe(false);
    expect(isSafeGithubProjectId('gitlab.com/foo/bar')).toBe(false);
    expect(isSafeGithubProjectId('cli/cli')).toBe(false);
  });

  test('rejects path-traversal and dot-only segments', () => {
    expect(isSafeGithubProjectId('github.com/owner/..')).toBe(false);
    expect(isSafeGithubProjectId('github.com/../repo')).toBe(false);
    expect(isSafeGithubProjectId('github.com/owner/.')).toBe(false);
    expect(isSafeGithubProjectId('github.com/./repo')).toBe(false);
  });

  test('rejects leading-dot segments and .git suffix', () => {
    expect(isSafeGithubProjectId('github.com/.hidden/repo')).toBe(false);
    expect(isSafeGithubProjectId('github.com/owner/.hidden')).toBe(false);
    expect(isSafeGithubProjectId('github.com/owner/repo.git')).toBe(false);
    expect(isSafeGithubProjectId('github.com/.git/.git')).toBe(false);
  });

  test('rejects too-long names', () => {
    const owner40 = 'a'.repeat(40);
    const repo101 = 'a'.repeat(101);
    expect(isSafeGithubProjectId(`github.com/${owner40}/repo`)).toBe(false);
    expect(isSafeGithubProjectId(`github.com/owner/${repo101}`)).toBe(false);
  });

  test('rejects empty segments and wrong number of segments', () => {
    expect(isSafeGithubProjectId('github.com/')).toBe(false);
    expect(isSafeGithubProjectId('github.com//repo')).toBe(false);
    expect(isSafeGithubProjectId('github.com/owner/')).toBe(false);
    expect(isSafeGithubProjectId('github.com/owner/repo/extra')).toBe(false);
  });

  test('rejects uppercase (canonical form is lowercase)', () => {
    expect(isSafeGithubProjectId('github.com/Cli/Cli')).toBe(false);
    expect(isSafeGithubProjectId('Github.com/cli/cli')).toBe(false);
  });

  test('accepts a numeric owner (GitHub allows all-digit logins)', () => {
    expect(isSafeGithubProjectId('github.com/12345/kookr')).toBe(true);
    expect(isSafeGithubSegment('12345', 'owner')).toBe(true);
  });
});

describe('sanitizeGithubOwnerRepo', () => {
  test.each([
    {
      name: 'trims a trailing newline from repo',
      owner: 'kookr-ai',
      repo: 'kookr\n',
      expected: { owner: 'kookr-ai', repo: 'kookr' },
    },
    {
      name: 'rejects a slash inside repo',
      owner: 'kookr-ai',
      repo: 'kookr/extra',
      expected: null,
    },
    {
      name: 'accepts a numeric owner',
      owner: '12345',
      repo: 'kookr',
      expected: { owner: '12345', repo: 'kookr' },
    },
    {
      name: 'does not rewrite owner/repo stuffed into repo',
      owner: 'kookr-ai',
      repo: 'kookr-ai/kookr',
      expected: null,
    },
    {
      name: 'accepts a legal kookr-ai/kookr pair',
      owner: 'kookr-ai',
      repo: 'kookr',
      expected: { owner: 'kookr-ai', repo: 'kookr' },
    },
  ])('$name', ({ owner, repo, expected }) => {
    expect(sanitizeGithubOwnerRepo(owner, repo)).toEqual(expected);
  });
});

describe('projectRepoUrl', () => {
  test('returns the https URL for a safe id', () => {
    expect(projectRepoUrl('github.com/cli/cli')).toBe('https://github.com/cli/cli');
  });

  test('returns null for unsafe ids', () => {
    expect(projectRepoUrl('github.com/owner/..')).toBeNull();
    expect(projectRepoUrl('local/foo')).toBeNull();
  });
});

describe('isSafePullRequestUrl', () => {
  test('accepts matching PR URLs', () => {
    expect(isSafePullRequestUrl('https://github.com/cli/cli/pull/1', 'github.com/cli/cli')).toBe(true);
    expect(isSafePullRequestUrl('https://github.com/cli/cli/pull/12345', 'github.com/cli/cli')).toBe(true);
  });

  test('rejects off-repo URLs', () => {
    expect(isSafePullRequestUrl('https://github.com/other/other/pull/1', 'github.com/cli/cli')).toBe(false);
    expect(isSafePullRequestUrl('https://evil.example.com/cli/cli/pull/1', 'github.com/cli/cli')).toBe(false);
  });

  test('rejects URLs without /pull/<positive-integer>', () => {
    expect(isSafePullRequestUrl('https://github.com/cli/cli', 'github.com/cli/cli')).toBe(false);
    expect(isSafePullRequestUrl('https://github.com/cli/cli/pull/abc', 'github.com/cli/cli')).toBe(false);
    expect(isSafePullRequestUrl('https://github.com/cli/cli/pull/0', 'github.com/cli/cli')).toBe(false);
    expect(isSafePullRequestUrl('https://github.com/cli/cli/issues/1', 'github.com/cli/cli')).toBe(false);
  });

  test('rejects when projectId itself is unsafe', () => {
    expect(isSafePullRequestUrl('https://github.com/owner/repo/pull/1', 'github.com/owner/..')).toBe(false);
  });
});

describe('projectIdToOwnerRepo', () => {
  test('splits valid ids', () => {
    expect(projectIdToOwnerRepo('github.com/cli/cli')).toEqual({ owner: 'cli', repo: 'cli' });
    expect(projectIdToOwnerRepo('github.com/grafana/grafana')).toEqual({ owner: 'grafana', repo: 'grafana' });
  });

  test('returns null for unsafe ids', () => {
    expect(projectIdToOwnerRepo('local/foo')).toBeNull();
    expect(projectIdToOwnerRepo('github.com/owner/..')).toBeNull();
  });
});
