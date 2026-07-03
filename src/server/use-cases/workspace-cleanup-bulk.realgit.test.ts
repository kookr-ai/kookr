import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { WorkspaceAttemptRepository } from '../../core/workspace-attempt-repository.js';
import { RepoPolicyResolver } from '../../core/repo-policy-resolver.js';
import { WorktreeLeaseService } from '../../core/worktree-lease-service.js';
import { bulkRemoveProbablySafeCandidates } from './workspace-cleanup-service.js';
import { getCleanupCandidateDetail } from './workspace-cleanup-detail-query.js';

// Real-git integration proof of RFC PR 3's flagship claim: a keep-branch bulk
// reclaim removes the working directory (reclaiming disk, including gitignored
// content) while the branch AND its local-only commits stay reachable.
//
// CRITICAL: every `git` invocation strips the nested-git env vars. Git sets
// GIT_DIR/GIT_INDEX_FILE/... while running hooks, and those OVERRIDE `-C`, so a
// suite that spawns git without clearing them corrupts the real repo when it
// runs inside the pre-push hook. See worktree-footprint.test.ts.
const NESTED_GIT_ENV_VARS = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES', 'GIT_COMMON_DIR',
  'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX', 'GIT_WORK_TREE',
];

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of NESTED_GIT_ENV_VARS) delete env[name];
  return env;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', env: cleanGitEnv() })
    .toString()
    .trim();
}

describe('bulkRemoveProbablySafeCandidates — real git (RFC PR 3)', () => {
  let repo: string;
  let worktree: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'kookr-bulk-repo-'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@example.com');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'README.md'), 'root\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'initial');

    // A linked worktree on a branch with a local-only commit + a gitignored,
    // uncommitted file holding real content (the disk we want reclaimed).
    worktree = join(repo, '..', `kookr-bulk-wt-${basename(repo)}`);
    git(repo, 'worktree', 'add', '-b', 'feature/keep', worktree);
    writeFileSync(join(worktree, 'feature.txt'), 'unique work\n');
    writeFileSync(join(worktree, '.gitignore'), 'local.env\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-m', 'local-only feature commit');
    // Uncommitted, gitignored — does NOT make the worktree dirty, but IS on disk.
    writeFileSync(join(worktree, 'local.env'), 'SECRET=keep-me-out-of-git\n');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it('reclaims the path (gitignored content included) and keeps the branch + commits', async () => {
    const projectId = `local/${basename(repo)}`;
    const attemptRepository = new WorkspaceAttemptRepository();
    const policyResolver = new RepoPolicyResolver({ profiles: [{ projectId, baselineRef: 'main' }] });
    const leaseService = new WorktreeLeaseService();

    // Sanity: the branch commit exists and the gitignored file is on disk.
    const branchSha = git(repo, 'rev-parse', 'refs/heads/feature/keep');
    expect(existsSync(join(worktree, 'local.env'))).toBe(true);

    // Capture the report-time fingerprint the way PR 2 does.
    const detail = await getCleanupCandidateDetail(
      { policyResolver, leaseService },
      { projectId, repoPath: repo, worktreePath: worktree },
    );
    expect(detail.classification).toBe('unique_commits');

    const result = await bulkRemoveProbablySafeCandidates(
      { attemptRepository, policyResolver, leaseService },
      {
        runId: 'bulk-real',
        resolveRepoPath: async () => repo,
        rows: [{
          projectId,
          worktreePath: worktree,
          branch: 'feature/keep',
          fingerprint: detail.fingerprint,
        }],
      },
    );

    // The row was reclaimed, keep-branch.
    expect(result.rows[0]!.status).toBe('done');
    expect(result.rows[0]!.branchRemoved).toBe(false);
    expect(result.rows[0]!.disposition).toBe('path_removed_branch_retained');

    // Disk reclaimed: the working directory (and its gitignored file) is gone.
    expect(existsSync(worktree)).toBe(false);

    // Branch + commits still reachable in the repo.
    expect(git(repo, 'rev-parse', 'refs/heads/feature/keep')).toBe(branchSha);
    // The unique commit object is still present.
    expect(() => git(repo, 'cat-file', '-e', branchSha)).not.toThrow();
  });
});
