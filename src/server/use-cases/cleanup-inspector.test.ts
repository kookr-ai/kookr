import { describe, it, expect, vi, beforeEach } from 'vitest';
import { inspectCleanupCandidates } from './cleanup-inspector.js';
import { WorktreeLeaseService } from '../../core/worktree-lease-service.js';
import { RepoPolicyResolver } from '../../core/repo-policy-resolver.js';

// Mock child_process
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
const mockExecFile = vi.mocked(execFile);

// Standard worktree list with main + one feature worktree
const SINGLE_WT = [
  'worktree /repo',
  'HEAD abc123',
  'branch refs/heads/main',
  '',
  'worktree /repo-wt',
  'HEAD def456',
  'branch refs/heads/feature',
  '',
].join('\n');

// Multi-worktree list
const MULTI_WT = [
  'worktree /repo',
  'HEAD abc123',
  'branch refs/heads/main',
  '',
  'worktree /repo-wt-a',
  'HEAD aaa111',
  'branch refs/heads/feat-a',
  '',
  'worktree /repo-wt-b',
  'HEAD bbb222',
  'branch refs/heads/feat-b',
  '',
  'worktree /repo-wt-c',
  'HEAD ccc333',
  'branch refs/heads/feat-c',
  '',
].join('\n');

/**
 * Helper: argument-based git mock.
 * Callers provide a map from a distinguishing arg pattern to the response.
 * Note: gitIn(cwd, ...args) calls execFile('git', args, { cwd }, cb).
 * The cwd is in opts, not in args.
 */
function mockGitArgs(rules: Array<{ match: (args: string[], opts?: any) => boolean; stdout: string | null }>) {
  mockExecFile.mockImplementation((_cmd, args: any, opts: any, cb: any) => {
    const argsArr: string[] = Array.isArray(args) ? args : [];
    for (const rule of rules) {
      if (rule.match(argsArr, opts)) {
        if (rule.stdout === null) {
          cb(new Error('git failed'), { stdout: '' }, '');
        } else {
          cb(null, { stdout: rule.stdout }, '');
        }
        return;
      }
    }
    if (argsArr.includes('remote') && argsArr.includes('get-url') && argsArr.includes('origin')) {
      cb(null, { stdout: 'https://github.com/org/repo.git' }, '');
      return;
    }
    // Default: empty success
    cb(null, { stdout: '' }, '');
  });
}

describe('inspectCleanupCandidates', () => {
  let leaseService: WorktreeLeaseService;
  let policyResolver: RepoPolicyResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    leaseService = new WorktreeLeaseService();
    policyResolver = new RepoPolicyResolver({
      profiles: [{ projectId: 'github.com/org/repo', baselineRef: 'main' }],
    });
  });

  // --- Basic cases ---

  it('returns empty when git worktree list fails', async () => {
    mockGitArgs([
      { match: (a) => a.includes('worktree'), stdout: null },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });
    expect(result).toEqual([]);
  });

  it('returns empty when only main worktree exists', async () => {
    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n' },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });
    expect(result).toEqual([]);
  });

  it('handles a bare porcelain entry before the primary and linked worktrees', async () => {
    const worktreeList = [
      'worktree /repo.git',
      'bare',
      '',
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo-wt',
      'HEAD def456',
      'branch refs/heads/feature',
      '',
    ].join('\n');
    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: worktreeList },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
      { match: (a) => a.includes('status') && a.includes('--porcelain'), stdout: '' },
      { match: (a) => a.includes('merge-base'), stdout: '' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    expect(result[0].worktreePath).toBe('/repo-wt');
  });

  it('returns empty when worktree list output is completely empty', async () => {
    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: '' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });
    expect(result).toEqual([]);
  });

  it('surfaces project_repointed and skips baseline merge logic when origin changes', async () => {
    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: SINGLE_WT },
      { match: (a) => a.includes('-C') && a.includes('/repo') && a.includes('remote') && a.includes('origin'), stdout: 'https://github.com/other/repo.git' },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'baseline-should-not-resolve' },
      { match: (a) => a.includes('merge-base'), stdout: '' },
      { match: (a) => a.includes('status') && a.includes('--porcelain'), stdout: '' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      projectId: 'github.com/org/repo',
      currentProjectId: 'github.com/other/repo',
      worktreePath: '/repo-wt',
      branch: 'feature',
      classification: 'unknown',
      reasonCode: 'project_repointed',
      source: 'cleanup_inspector',
    });
    expect(result[0].baselineRef).toBeUndefined();
    expect(result[0].baselineSha).toBeUndefined();
    expect(result[0].recoveryGuidance).toContain('github.com/org/repo');
    expect(result[0].recoveryGuidance).toContain('github.com/other/repo');
    expect(result[0].capabilities.canSafeRemove).toBe(false);
    expect(result[0].capabilities.canRemovePathKeepBranch).toBe(false);
    expect(mockExecFile.mock.calls.some(([, args]) => Array.isArray(args) && args.includes('merge-base'))).toBe(false);
    expect(mockExecFile.mock.calls.some(([, args]) => Array.isArray(args) && args.includes('status'))).toBe(false);
    expect(mockExecFile.mock.calls.some(([, args]) => Array.isArray(args) && args.includes('rev-parse'))).toBe(false);
  });

  // --- Classification: busy ---

  it('classifies a busy worktree (active lease)', async () => {
    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: SINGLE_WT },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
    ]);

    leaseService.acquire('/repo-wt', 'task-1');

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('busy');
    expect(result[0].reasonCode).toBe('active_lease');
    expect(result[0].branch).toBe('feature');
    expect(result[0].recoveryGuidance).toContain('Wait for the task');
  });

  it('lease takes priority over dirty state', async () => {
    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: SINGLE_WT },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
      // Even though status would return dirty, we should never get there
      { match: (a) => a.includes('status'), stdout: 'M dirty-file.ts' },
    ]);

    leaseService.acquire('/repo-wt', 'task-1');

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result[0].classification).toBe('busy');
  });

  // --- Classification: detached HEAD ---

  it('classifies detached HEAD as unknown', async () => {
    const worktreeList = [
      'worktree /repo', 'HEAD abc123', 'branch refs/heads/main', '',
      'worktree /repo-wt', 'HEAD def456', 'detached', '',
    ].join('\n');

    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: worktreeList },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('unknown');
    expect(result[0].reasonCode).toBe('detached_head');
    expect(result[0].branch).toContain('detached');
  });

  // --- Classification: checked_out_elsewhere ---

  it('classifies branch checked out in another worktree', async () => {
    // Two worktrees with the same branch
    const worktreeList = [
      'worktree /repo', 'HEAD abc123', 'branch refs/heads/main', '',
      'worktree /repo-wt-1', 'HEAD def456', 'branch refs/heads/feature', '',
      'worktree /repo-wt-2', 'HEAD def456', 'branch refs/heads/feature', '',
    ].join('\n');

    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: worktreeList },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
      { match: (a) => a.includes('status'), stdout: '' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    // Both non-primary worktrees share the `feature` branch, so each sees
    // the other holding its branch — classification must be symmetric.
    const checkedOut = result.filter((c) => c.classification === 'checked_out_elsewhere');
    expect(checkedOut).toHaveLength(2);
    expect(checkedOut.every((c) => c.reasonCode === 'branch_checked_out')).toBe(true);
  });

  // --- Classification: dirty ---

  it('classifies worktree with uncommitted changes as dirty', async () => {
    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: SINGLE_WT },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
      { match: (a) => a.includes('status') && a.includes('--porcelain'), stdout: ' M src/file.ts\n?? untracked.txt' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('dirty');
    expect(result[0].reasonCode).toBe('uncommitted_changes');
    expect(result[0].recoveryGuidance).toContain('uncommitted');
  });

  it('classifies status failure for a missing worktree as stale instead of dirty', async () => {
    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: SINGLE_WT },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
      { match: (a) => a.includes('status'), stdout: null },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('stale_worktree');
    expect(result[0].reasonCode).toBe('missing_worktree_path');
    expect(result[0].recoveryGuidance).toContain('worktree prune');
  });

  it('classifies graphify-only untracked artifacts as generated-only', async () => {
    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: SINGLE_WT },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
      { match: (a) => a.includes('status') && a.includes('--porcelain'), stdout: '?? graphify-out/' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('generated_only');
    expect(result[0].reasonCode).toBe('generated_artifacts');
    expect(result[0].dirtySummary).toEqual({ modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 1 });
    expect(result[0].recoveryGuidance).toContain('generated artifact');
  });

  it('does not classify mixed generated and source changes as generated-only', async () => {
    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: SINGLE_WT },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
      { match: (a) => a.includes('status') && a.includes('--porcelain') && !a.includes('--porcelain=v1'), stdout: '?? graphify-out/\n M src/file.ts' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('dirty');
    expect(result[0].reasonCode).toBe('uncommitted_changes');
  });

  it('classifies locked worktree registry entries separately from dirty', async () => {
    const worktreeList = [
      'worktree /repo', 'HEAD abc123', 'branch refs/heads/main', '',
      'worktree /repo-wt', 'HEAD def456', 'branch refs/heads/feature', 'locked initializing', '',
    ].join('\n');

    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: worktreeList },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('stale_worktree');
    expect(result[0].reasonCode).toBe('locked_worktree');
    expect(result[0].recoveryGuidance).toContain('unlock');
  });

  // --- Classification: merged ---

  it('classifies merged branch (ancestor of baseline)', async () => {
    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: SINGLE_WT },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
      { match: (a) => a.includes('status') && a.includes('--porcelain'), stdout: '' },
      { match: (a) => a.includes('merge-base') && a.includes('--is-ancestor'), stdout: '' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('merged');
    expect(result[0].reasonCode).toBe('ancestor_of_baseline');
    expect(result[0].recoveryGuidance).toContain('Safe to remove');
  });

  // --- Classification: patch_equivalent ---

  it('classifies patch-equivalent branch (squash-merged)', async () => {
    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: SINGLE_WT },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
      { match: (a) => a.includes('status') && a.includes('--porcelain'), stdout: '' },
      { match: (a) => a.includes('merge-base') && a.includes('--is-ancestor'), stdout: null },
      { match: (a) => a.includes('--cherry-pick') && a.includes('--right-only'), stdout: '' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('patch_equivalent');
    expect(result[0].reasonCode).toBe('no_unique_patches');
    expect(result[0].recoveryGuidance).toContain('squash-merged');
  });

  // --- Classification: unique_commits ---

  it('classifies branch with unique commits', async () => {
    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: SINGLE_WT },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
      { match: (a) => a.includes('status') && a.includes('--porcelain'), stdout: '' },
      { match: (a) => a.includes('merge-base') && a.includes('--is-ancestor'), stdout: null },
      { match: (a) => a.includes('--cherry-pick') && a.includes('--right-only'), stdout: 'abc1234 Add feature\ndef5678 Fix tests' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('unique_commits');
    expect(result[0].reasonCode).toBe('has_unique_commits');
    expect(result[0].recoveryGuidance).toContain('Review before removing');
  });

  it('classifies as unique_commits when cherry-pick command itself fails', async () => {
    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: SINGLE_WT },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
      { match: (a) => a.includes('status') && a.includes('--porcelain'), stdout: '' },
      { match: (a) => a.includes('merge-base') && a.includes('--is-ancestor'), stdout: null },
      // cherry-pick log command fails entirely (null result)
      // Implementation: uniquePatches === null falls through to unique_commits
      { match: (a) => a.includes('--cherry-pick') && a.includes('--right-only'), stdout: null },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('unique_commits');
    expect(result[0].reasonCode).toBe('has_unique_commits');
  });

  // --- Classification: unknown (no baseline) ---

  it('classifies unknown for external repos without profile', async () => {
    const unknownResolver = new RepoPolicyResolver();

    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: SINGLE_WT },
      { match: (a) => a.includes('remote') && a.includes('get-url') && a.includes('origin'), stdout: 'https://github.com/unknown/repo.git' },
      { match: (a) => a.includes('symbolic-ref'), stdout: null },
      { match: (a) => a.includes('rev-parse') && a.includes('--verify'), stdout: null },
      { match: (a) => a.includes('status') && a.includes('--porcelain'), stdout: '' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/unknown/repo', {
      policyResolver: unknownResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('unknown');
    expect(result[0].reasonCode).toBe('no_baseline');
    expect(result[0].recoveryGuidance).toContain('Configure a repo profile');
  });

  it('uses origin default branch to classify unprofiled external repos', async () => {
    const unknownResolver = new RepoPolicyResolver();

    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: SINGLE_WT },
      { match: (a) => a.includes('remote') && a.includes('get-url') && a.includes('origin'), stdout: 'https://github.com/unknown/repo.git' },
      { match: (a) => a.includes('symbolic-ref'), stdout: 'refs/remotes/origin/main' },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'origin/main', stdout: 'abc123' },
      { match: (a) => a.includes('status') && a.includes('--porcelain'), stdout: '' },
      { match: (a) => a.includes('merge-base') && a.includes('--is-ancestor'), stdout: '' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/unknown/repo', {
      policyResolver: unknownResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(expect.objectContaining({
      classification: 'merged',
      reasonCode: 'ancestor_of_baseline',
      baselineRef: 'origin/main',
      baselineSha: 'abc123',
    }));
  });

  // --- Multiple candidates ---

  it('classifies multiple candidates differently', async () => {
    mockExecFile.mockImplementation((_cmd, args: any, opts: any, cb: any) => {
      const a: string[] = Array.isArray(args) ? args : [];
      const cwd: string = opts?.cwd ?? '';
      if (a.includes('worktree') && a.includes('list')) {
        cb(null, { stdout: MULTI_WT }, '');
      } else if (a.includes('remote') && a.includes('get-url') && a.includes('origin')) {
        cb(null, { stdout: 'https://github.com/org/repo.git' }, '');
      } else if (a.includes('rev-parse') && a[a.length - 1] === 'main') {
        cb(null, { stdout: 'abc123' }, '');
      } else if (a.includes('status') && a.includes('--porcelain')) {
        // Determine which worktree by the cwd option
        if (cwd.includes('repo-wt-b')) {
          cb(null, { stdout: 'M file.ts' }, ''); // dirty
        } else {
          cb(null, { stdout: '' }, ''); // clean
        }
      } else if (a.includes('merge-base') && a.includes('--is-ancestor')) {
        if (a.includes('feat-a')) {
          cb(null, { stdout: '' }, ''); // merged
        } else {
          cb(new Error('not ancestor'), { stdout: '' }, ''); // not merged
        }
      } else if (a.includes('--cherry-pick') && a.includes('--right-only')) {
        cb(null, { stdout: 'abc unique commit' }, ''); // unique commits
      } else {
        cb(null, { stdout: '' }, '');
      }
    });

    // Lease on wt-a should make it busy (overrides merged)
    leaseService.acquire('/repo-wt-a', 'task-x');

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(3);

    const byPath = new Map(result.map((r) => [r.worktreePath, r]));
    expect(byPath.get('/repo-wt-a')?.classification).toBe('busy');
    expect(byPath.get('/repo-wt-b')?.classification).toBe('dirty');
    expect(byPath.get('/repo-wt-c')?.classification).toBe('unique_commits');
  });

  // --- Bare worktree ---

  it('skips bare worktree entries', async () => {
    const worktreeList = [
      'worktree /repo', 'HEAD abc123', 'branch refs/heads/main', '',
      'worktree /repo.git', 'HEAD abc123', 'bare', '',
      'worktree /repo-wt', 'HEAD def456', 'branch refs/heads/feature', '',
    ].join('\n');

    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: worktreeList },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
      { match: (a) => a.includes('status'), stdout: '' },
      { match: (a) => a.includes('merge-base'), stdout: '' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    // Only the feature worktree, not the bare entry
    expect(result).toHaveLength(1);
    expect(result[0].branch).toBe('feature');
  });

  // --- Assessment field completeness ---

  it('populates all assessment fields correctly', async () => {
    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: SINGLE_WT },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'baseline-sha-xyz' },
      { match: (a) => a.includes('status'), stdout: '' },
      { match: (a) => a.includes('merge-base'), stdout: '' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    const c = result[0];
    expect(c.projectId).toBe('github.com/org/repo');
    expect(c.worktreePath).toBe('/repo-wt');
    expect(c.branch).toBe('feature');
    expect(c.classification).toBe('merged');
    expect(c.reasonCode).toBe('ancestor_of_baseline');
    expect(c.source).toBe('cleanup_inspector');
    expect(c.baselineRef).toBe('main');
    expect(c.baselineSha).toBe('baseline-sha-xyz');
    // Both timestamps must be valid ISO-8601 strings.
    expect(new Date(c.checkedAt).toISOString()).toBe(c.checkedAt);
    expect(new Date(c.observedAt).toISOString()).toBe(c.observedAt);
    expect(typeof c.recoveryGuidance).toBe('string');
    expect(c.recoveryGuidance.trim().length).toBeGreaterThan(0);
  });

  it('formats branch as "(detached at <sha>)" for detached HEAD worktrees', async () => {
    const worktreeList = [
      'worktree /repo', 'HEAD abc123', 'branch refs/heads/main', '',
      'worktree /repo-wt-det', 'HEAD abcdef0123456789', 'detached', '',
    ].join('\n');

    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: worktreeList },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    // Implementation: `(detached at ${wt.HEAD?.slice(0, 8) ?? 'unknown'})`
    expect(result[0].branch).toBe('(detached at abcdef01)');
  });

  it('includes baselineRef and baselineSha on a busy assessment', async () => {
    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: SINGLE_WT },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'resolved-sha' },
    ]);

    leaseService.acquire('/repo-wt', 'task-1');

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    const c = result[0];
    expect(c.classification).toBe('busy');
    // Even busy worktrees carry the baseline info from policy resolution
    expect(c.baselineRef).toBe('main');
    expect(c.baselineSha).toBe('resolved-sha');
    expect(new Date(c.checkedAt).toISOString()).toBe(c.checkedAt);
  });

  it('leaves baselineRef/baselineSha undefined when no profile exists', async () => {
    const unknownResolver = new RepoPolicyResolver();

    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: SINGLE_WT },
      { match: (a) => a.includes('remote') && a.includes('get-url') && a.includes('origin'), stdout: 'https://github.com/unknown/repo.git' },
      { match: (a) => a.includes('symbolic-ref'), stdout: null },
      { match: (a) => a.includes('rev-parse') && a.includes('--verify'), stdout: null },
      { match: (a) => a.includes('status') && a.includes('--porcelain'), stdout: '' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/unknown/repo', {
      policyResolver: unknownResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    const c = result[0];
    expect(c.baselineRef).toBeUndefined();
    expect(c.baselineSha).toBeUndefined();
    expect(c.classification).toBe('unknown');
    expect(c.reasonCode).toBe('no_baseline');
  });

  // --- List-level enrichment ---

  it('attaches commitSummary with ahead/behind on a unique-commits branch', async () => {
    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: SINGLE_WT },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
      { match: (a) => a.includes('status') && a.includes('--porcelain'), stdout: '' },
      { match: (a) => a.includes('merge-base') && a.includes('--is-ancestor'), stdout: null },
      { match: (a) => a.includes('--cherry-pick') && a.includes('--right-only'), stdout: 'abc unique' },
      // enrichment calls
      { match: (a) => a.includes('rev-list') && a.includes('--left-right'), stdout: '97\t2' },
      { match: (a) => a.includes('log') && a.includes('-1') && a.some((x) => x.startsWith('--format=')), stdout: 'sha\u001fJean\u001f2026-04-01T12:00:00Z\u001ffix: something' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('unique_commits');
    expect(result[0].commitSummary).toEqual({
      aheadCount: 2,
      behindCount: 97,
      lastCommitSha: 'sha',
      lastCommitAuthor: 'Jean',
      lastCommitAt: '2026-04-01T12:00:00Z',
      lastCommitSubject: 'fix: something',
    });
    expect(result[0].enrichmentFailed).toBeUndefined();
  });

  it('attaches dirtySummary to a dirty worktree and still runs commit enrichment', async () => {
    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: SINGLE_WT },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
      { match: (a) => a.includes('status') && a.includes('--porcelain') && !a.includes('--porcelain=v1'), stdout: ' M src/file.ts\n?? new.ts' },
      { match: (a) => a.includes('rev-list') && a.includes('--left-right'), stdout: '3\t1' },
      { match: (a) => a.includes('log') && a.includes('-1') && a.some((x) => x.startsWith('--format=')), stdout: 'sha\u001fJean\u001f2026-04-20T08:00:00Z\u001fWIP' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('dirty');
    expect(result[0].dirtySummary).toEqual({ modified: 1, added: 0, deleted: 0, renamed: 0, untracked: 1 });
    expect(result[0].commitSummary?.aheadCount).toBe(1);
    expect(result[0].commitSummary?.behindCount).toBe(3);
    expect(result[0].enrichmentFailed).toBeUndefined();
  });

  it('marks enrichmentFailed when rev-list errors for a unique-commits branch', async () => {
    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: SINGLE_WT },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
      { match: (a) => a.includes('status') && a.includes('--porcelain'), stdout: '' },
      { match: (a) => a.includes('merge-base') && a.includes('--is-ancestor'), stdout: null },
      { match: (a) => a.includes('--cherry-pick') && a.includes('--right-only'), stdout: 'abc unique' },
      // rev-list used by enrichment fails
      { match: (a) => a.includes('rev-list') && a.includes('--left-right'), stdout: null },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    expect(result[0].enrichmentFailed).toBe(true);
    expect(result[0].commitSummary).toBeUndefined();
  });

  it('detached HEAD worktree with uncommitted state surfaces dirtySummary + headShortSha', async () => {
    const worktreeList = [
      'worktree /repo', 'HEAD abc123', 'branch refs/heads/main', '',
      'worktree /repo-wt-det', 'HEAD abcdef0123456789', 'detached', '',
    ].join('\n');

    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: worktreeList },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
      { match: (a) => a.includes('status') && a.includes('--porcelain'), stdout: ' M src/wip.ts\n?? untracked.ts' },
    ]);

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('unknown');
    expect(result[0].reasonCode).toBe('detached_head');
    expect(result[0].dirtySummary).toEqual({ modified: 1, added: 0, deleted: 0, renamed: 0, untracked: 1 });
    expect(result[0].headShortSha).toBe('abcdef0');
    // no commit summary — no symbolic branch
    expect(result[0].commitSummary).toBeUndefined();
  });

  it('busy classification carries no enrichment payload', async () => {
    mockGitArgs([
      { match: (a) => a.includes('worktree') && a.includes('list'), stdout: SINGLE_WT },
      { match: (a) => a.includes('rev-parse') && a[a.length - 1] === 'main', stdout: 'abc123' },
    ]);
    leaseService.acquire('/repo-wt', 'task-1');

    const result = await inspectCleanupCandidates('/repo', 'github.com/org/repo', {
      policyResolver, leaseService,
    });

    expect(result).toHaveLength(1);
    expect(result[0].classification).toBe('busy');
    expect(result[0].commitSummary).toBeUndefined();
    expect(result[0].dirtySummary).toBeUndefined();
    expect(result[0].enrichmentFailed).toBeUndefined();
  });
});
