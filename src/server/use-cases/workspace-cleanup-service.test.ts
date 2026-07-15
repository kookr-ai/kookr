import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceAttemptRepository } from '../../core/workspace-attempt-repository.js';
import { RepoPolicyResolver } from '../../core/repo-policy-resolver.js';
import { WorktreeLeaseService } from '../../core/worktree-lease-service.js';
import {
  bulkRemoveProbablySafeCandidates,
  cleanupSafeWorkspaceCandidates,
  cleanupWorkspaceCandidate,
  type BulkRemoveProgressEvent,
} from './workspace-cleanup-service.js';
import { createCleanupFingerprint } from './workspace-cleanup-detail-query.js';
import { deriveCleanupCapabilities } from '../../core/workspace-cleanup-policy.js';

const { mockExecFile, mockRemovalGuard } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockRemovalGuard: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('./cleanup-inspector.js', () => ({
  inspectCleanupCandidates: vi.fn(),
  inspectCleanupCandidate: vi.fn(),
}));

vi.mock('../../adapters/worktree-safety.js', () => ({
  getWorktreeRemovalGuardReason: mockRemovalGuard,
  isProtectedBranch: (branch: string | undefined) => ['main', 'master', 'develop', 'dev'].includes(branch ?? ''),
}));

import { inspectCleanupCandidate, inspectCleanupCandidates } from './cleanup-inspector.js';

const mockInspectCleanupCandidates = vi.mocked(inspectCleanupCandidates);
const mockInspectCleanupCandidate = vi.mocked(inspectCleanupCandidate);

function cleanupCandidate(overrides: Partial<Awaited<ReturnType<typeof inspectCleanupCandidates>>[number]> = {}) {
  const classification = overrides.classification ?? 'merged';
  const reasonCode = overrides.reasonCode ?? 'ancestor_of_baseline';
  return {
    projectId: 'github.com/org/repo',
    worktreePath: '/repo-worktree',
    branch: 'feature/test',
    classification,
    reasonCode,
    source: 'cleanup_inspector',
    baselineRef: 'main',
    baselineSha: 'baseline123',
    checkedAt: '2026-04-04T00:00:00Z',
    observedAt: '2026-04-04T00:00:00Z',
    recoveryGuidance: 'Review cleanup state.',
    capabilities: deriveCleanupCapabilities({ classification, reasonCode }),
    ...overrides,
  };
}

function mockGitResponses(handlers: Record<string, { stdout?: string; stderr?: string; error?: boolean }>) {
  mockExecFile.mockImplementation((_cmd: string, args: string[], maybeOpts: unknown, maybeCb?: Function) => {
    const cb = typeof maybeCb === 'function'
      ? maybeCb
      : maybeOpts as Function;
    const argsStr = args.join(' ');
    for (const [pattern, response] of Object.entries(handlers)) {
      if (argsStr.includes(pattern)) {
        if (response.error) {
          cb({ stderr: response.stderr ?? 'git error' });
        } else {
          cb(null, { stdout: response.stdout ?? '', stderr: response.stderr ?? '' });
        }
        return;
      }
    }
    cb(new Error(`Unhandled git args: ${argsStr}`));
  });
}

describe('cleanupWorkspaceCandidate', () => {
  let attemptRepository: WorkspaceAttemptRepository;
  let policyResolver: RepoPolicyResolver;
  let leaseService: WorktreeLeaseService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRemovalGuard.mockResolvedValue(undefined);
    attemptRepository = new WorkspaceAttemptRepository();
    policyResolver = new RepoPolicyResolver({ profiles: [{ projectId: 'github.com/org/repo', baselineRef: 'main' }] });
    leaseService = new WorktreeLeaseService();
    mockInspectCleanupCandidate.mockImplementation(async (_repoPath, _projectId, worktreePath) => {
      const candidates = await mockInspectCleanupCandidates();
      return candidates.find((candidate) => candidate.worktreePath === worktreePath);
    });
  });

  it('rejects the primary working tree before candidate inspection', async () => {
    mockRemovalGuard.mockResolvedValue('primary-working-tree');

    await expect(cleanupWorkspaceCandidate({
      attemptRepository,
      policyResolver,
      leaseService,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
      worktreePath: '/repo',
    })).rejects.toThrow('Cleanup blocked: primary-working-tree');

    expect(mockInspectCleanupCandidate).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('rejects a non-worktree path before candidate inspection', async () => {
    mockRemovalGuard.mockResolvedValue('not-a-linked-worktree');

    await expect(cleanupWorkspaceCandidate({
      attemptRepository,
      policyResolver,
      leaseService,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
      worktreePath: '/tmp/not-a-worktree',
    })).rejects.toThrow('Cleanup blocked: not-a-linked-worktree');

    expect(mockInspectCleanupCandidate).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation for protected-branch cleanup', async () => {
    mockInspectCleanupCandidates.mockResolvedValue([cleanupCandidate({ branch: 'main' })]);

    await expect(cleanupWorkspaceCandidate({
      attemptRepository,
      policyResolver,
      leaseService,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
      worktreePath: '/repo-worktree',
      deleteBranch: false,
    })).rejects.toThrow('Cleanup blocked: protected-branch');

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('allows protected-branch cleanup only when confirmed', async () => {
    mockInspectCleanupCandidates.mockResolvedValue([cleanupCandidate({ branch: 'main' })]);
    mockGitResponses({
      'rev-parse HEAD': { stdout: 'head123' },
      'rev-parse --verify refs/heads/main': { stdout: 'main123' },
      'rev-parse --verify main': { stdout: 'baseline123' },
      'status --porcelain=v1': { stdout: '' },
      'rev-list --left-right --count main...main': { stdout: '0 0' },
      'log -1 --format=%H%x1f%an%x1f%aI%x1f%s HEAD': { stdout: 'head123\u001fJean\u001f2026-04-04T00:00:00Z\u001fProtected branch' },
      'worktree remove /repo-worktree': { stdout: '' },
      'worktree prune': { stdout: '' },
    });

    const result = await cleanupWorkspaceCandidate({
      attemptRepository,
      policyResolver,
      leaseService,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
      worktreePath: '/repo-worktree',
      branch: 'main',
      deleteBranch: false,
      confirmProtectedBranch: true,
    });

    expect(result.summary.pathRemoved).toBe(true);
    expect(result.summary.branchRemoved).toBe(false);
  });

  it('removes a patch-equivalent worktree and deletes the matching branch ref', async () => {
    mockInspectCleanupCandidates.mockResolvedValue([cleanupCandidate({
      classification: 'patch_equivalent',
      reasonCode: 'no_unique_patches',
    })]);
    mockGitResponses({
      'rev-parse HEAD': { stdout: 'head123' },
      'rev-parse --verify refs/heads/feature/test': { stdout: 'abc123' },
      'rev-parse --verify main': { stdout: 'baseline123' },
      'status --porcelain=v1': { stdout: '' },
      'rev-list --left-right --count main...feature/test': { stdout: '0 0' },
      'log -1 --format=%H%x1f%an%x1f%aI%x1f%s HEAD': { stdout: 'head123\u001fJean\u001f2026-04-04T00:00:00Z\u001fPatch equivalent branch' },
      'worktree remove /repo-worktree': { stdout: '' },
      'worktree prune': { stdout: '' },
      'update-ref -d refs/heads/feature/test abc123': { stdout: '' },
    });

    const reviewFingerprint = createCleanupFingerprint({
      headOid: 'head123',
      branchRefOid: 'abc123',
      baselineOid: 'baseline123',
      statusDigest: '',
    });

    const result = await cleanupWorkspaceCandidate({
      attemptRepository,
      policyResolver,
      leaseService,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
      worktreePath: '/repo-worktree',
      deleteBranch: true,
      reviewFingerprint,
    });

    expect(result.summary.disposition).toBe('completed');
    expect(result.summary.branchRemoved).toBe(true);
    const [attempt] = attemptRepository.listByProject('github.com/org/repo');
    expect(attempt.disposition).toBe('completed');
  });

  it('rejects stale fingerprints before any destructive git command runs', async () => {
    mockInspectCleanupCandidates.mockResolvedValue([cleanupCandidate()]);
    mockGitResponses({
      'rev-parse HEAD': { stdout: 'head123' },
      'rev-parse --verify refs/heads/feature/test': { stdout: 'abc123' },
      'rev-parse --verify main': { stdout: 'baseline123' },
      'status --porcelain=v1': { stdout: '' },
      'rev-list --left-right --count main...feature/test': { stdout: '0 0' },
      'log -1 --format=%H%x1f%an%x1f%aI%x1f%s HEAD': { stdout: 'head123\u001fJean\u001f2026-04-04T00:00:00Z\u001fSafe branch' },
    });

    await expect(cleanupWorkspaceCandidate({
      attemptRepository,
      policyResolver,
      leaseService,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
      worktreePath: '/repo-worktree',
      deleteBranch: true,
      reviewFingerprint: 'stale-fingerprint',
    })).rejects.toThrow('Cleanup review is stale');

    expect(mockExecFile.mock.calls.some(([, args]) => args.includes('worktree') && args.includes('remove'))).toBe(false);
  });

  it('requires explicit reviewed discard before dirty cleanup', async () => {
    mockInspectCleanupCandidates.mockResolvedValue([cleanupCandidate({
      classification: 'dirty',
      reasonCode: 'uncommitted_changes',
    })]);

    await expect(cleanupWorkspaceCandidate({
      attemptRepository,
      policyResolver,
      leaseService,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
      worktreePath: '/repo-worktree',
      reviewFingerprint: 'ignored',
    })).rejects.toThrow('Dirty cleanup requires an explicit reviewed discard request');

    const [attempt] = attemptRepository.listByProject('github.com/org/repo');
    expect(attempt.status).toBe('blocked');
  });

  it('creates a recovery stash before removing a dirty worktree while keeping the branch', async () => {
    mockInspectCleanupCandidates.mockResolvedValue([cleanupCandidate({
      classification: 'dirty',
      reasonCode: 'uncommitted_changes',
    })]);
    mockGitResponses({
      'rev-parse HEAD': { stdout: 'headdirty' },
      'rev-parse --verify refs/heads/feature/test': { stdout: 'dirtybranch123' },
      'rev-parse --verify main': { stdout: 'baseline123' },
      'status --porcelain=v1': { stdout: ' M src/file.ts\n?? scratch.txt' },
      'rev-list --left-right --count main...feature/test': { stdout: '0 0' },
      'log -1 --format=%H%x1f%an%x1f%aI%x1f%s HEAD': { stdout: 'headdirty\u001fJean\u001f2026-04-05T00:00:00Z\u001fDirty branch' },
      'rev-parse --verify refs/stash': { error: true, stderr: 'fatal: ambiguous argument refs/stash' },
      'stash push --all -m': { stdout: 'Saved working directory and index state' },
      'stash list -1 --format=%H%x1f%gd%x1f%s': { stdout: 'stashsha123\u001fstash@{0}\u001fkookr workspace cleanup' },
      'worktree remove /repo-worktree': { stdout: '' },
      'worktree prune': { stdout: '' },
    });

    const reviewFingerprint = createCleanupFingerprint({
      headOid: 'headdirty',
      branchRefOid: 'dirtybranch123',
      baselineOid: 'baseline123',
      statusDigest: ' M src/file.ts\n?? scratch.txt',
    });

    const result = await cleanupWorkspaceCandidate({
      attemptRepository,
      policyResolver,
      leaseService,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
      worktreePath: '/repo-worktree',
      deleteBranch: false,
      discardDirtyState: true,
      reviewFingerprint,
    });

    expect(result.summary.disposition).toBe('path_removed_branch_retained');
    expect(result.summary.recoveryRef).toBe('stash@{0}');
    expect(result.summary.retainedReason).toBe('user_requested_keep_branch');
  });

  it('requires explicit risk acceptance before deleting a dirty branch with local-only commits', async () => {
    mockInspectCleanupCandidates.mockResolvedValue([cleanupCandidate({
      classification: 'dirty',
      reasonCode: 'uncommitted_changes',
    })]);
    mockGitResponses({
      'rev-parse HEAD': { stdout: 'headdirty' },
      'rev-parse --verify refs/heads/feature/test': { stdout: 'dirtybranch123' },
      'rev-parse --verify main': { stdout: 'baseline123' },
      'status --porcelain=v1': { stdout: ' M src/file.ts' },
      'rev-list --left-right --count main...feature/test': { stdout: '0 2' },
      'log -1 --format=%H%x1f%an%x1f%aI%x1f%s HEAD': { stdout: 'headdirty\u001fJean\u001f2026-04-05T00:00:00Z\u001fDirty branch' },
    });

    const reviewFingerprint = createCleanupFingerprint({
      headOid: 'headdirty',
      branchRefOid: 'dirtybranch123',
      baselineOid: 'baseline123',
      statusDigest: ' M src/file.ts',
    });

    await expect(cleanupWorkspaceCandidate({
      attemptRepository,
      policyResolver,
      leaseService,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
      worktreePath: '/repo-worktree',
      deleteBranch: true,
      discardDirtyState: true,
      reviewFingerprint,
    })).rejects.toThrow('Deleting a dirty branch with local-only commits requires explicit risk acceptance');
  });

  it('allows dirty branch deletion after recovery stash and risk acceptance', async () => {
    mockInspectCleanupCandidates.mockResolvedValue([cleanupCandidate({
      classification: 'dirty',
      reasonCode: 'uncommitted_changes',
    })]);
    mockGitResponses({
      'rev-parse HEAD': { stdout: 'headdirty' },
      'rev-parse --verify refs/heads/feature/test': { stdout: 'dirtybranch123' },
      'rev-parse --verify main': { stdout: 'baseline123' },
      'status --porcelain=v1': { stdout: ' M src/file.ts' },
      'rev-list --left-right --count main...feature/test': { stdout: '0 2' },
      'log -1 --format=%H%x1f%an%x1f%aI%x1f%s HEAD': { stdout: 'headdirty\u001fJean\u001f2026-04-05T00:00:00Z\u001fDirty branch' },
      'rev-parse --verify refs/stash': { error: true, stderr: 'fatal: ambiguous argument refs/stash' },
      'stash push --all -m': { stdout: 'Saved working directory and index state' },
      'stash list -1 --format=%H%x1f%gd%x1f%s': { stdout: 'stashsha123\u001fstash@{0}\u001fkookr workspace cleanup' },
      'worktree remove /repo-worktree': { stdout: '' },
      'worktree prune': { stdout: '' },
      'update-ref -d refs/heads/feature/test dirtybranch123': { stdout: '' },
    });

    const reviewFingerprint = createCleanupFingerprint({
      headOid: 'headdirty',
      branchRefOid: 'dirtybranch123',
      baselineOid: 'baseline123',
      statusDigest: ' M src/file.ts',
    });

    const result = await cleanupWorkspaceCandidate({
      attemptRepository,
      policyResolver,
      leaseService,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
      worktreePath: '/repo-worktree',
      deleteBranch: true,
      discardDirtyState: true,
      riskAccepted: true,
      reviewFingerprint,
    });

    expect(result.summary.disposition).toBe('completed');
    expect(result.summary.recoveryRef).toBe('stash@{0}');
    expect(result.summary.branchRemoved).toBe(true);
  });

  it('allows unique-commit keep-branch cleanup after review', async () => {
    mockInspectCleanupCandidates.mockResolvedValue([cleanupCandidate({
      classification: 'unique_commits',
      reasonCode: 'has_unique_commits',
    })]);
    mockGitResponses({
      'rev-parse HEAD': { stdout: 'head555' },
      'rev-parse --verify refs/heads/feature/test': { stdout: 'abc555' },
      'rev-parse --verify main': { stdout: 'baseline123' },
      'status --porcelain=v1': { stdout: '' },
      'rev-list --left-right --count main...feature/test': { stdout: '2 3' },
      'log -1 --format=%H%x1f%an%x1f%aI%x1f%s HEAD': { stdout: 'head555\u001fJean\u001f2026-04-04T00:00:00Z\u001fUnique branch' },
      'worktree remove /repo-worktree': { stdout: '' },
      'worktree prune': { stdout: '' },
    });

    const reviewFingerprint = createCleanupFingerprint({
      headOid: 'head555',
      branchRefOid: 'abc555',
      baselineOid: 'baseline123',
      statusDigest: '',
    });

    const result = await cleanupWorkspaceCandidate({
      attemptRepository,
      policyResolver,
      leaseService,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
      worktreePath: '/repo-worktree',
      deleteBranch: false,
      reviewFingerprint,
    });

    expect(result.summary.disposition).toBe('path_removed_branch_retained');
    expect(result.summary.retainedReason).toBe('user_requested_keep_branch');
  });

  it('requires risk acceptance before deleting a unique-commit branch', async () => {
    mockInspectCleanupCandidates.mockResolvedValue([cleanupCandidate({
      classification: 'unique_commits',
      reasonCode: 'has_unique_commits',
    })]);

    await expect(cleanupWorkspaceCandidate({
      attemptRepository,
      policyResolver,
      leaseService,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
      worktreePath: '/repo-worktree',
      deleteBranch: true,
      reviewFingerprint: 'fresh',
    })).rejects.toThrow('requires explicit risk acceptance');
  });

  it('deletes a unique-commit branch after reviewed risk acceptance', async () => {
    mockInspectCleanupCandidates.mockResolvedValue([cleanupCandidate({
      classification: 'unique_commits',
      reasonCode: 'has_unique_commits',
    })]);
    mockGitResponses({
      'rev-parse HEAD': { stdout: 'head777' },
      'rev-parse --verify refs/heads/feature/test': { stdout: 'abc777' },
      'rev-parse --verify main': { stdout: 'baseline123' },
      'status --porcelain=v1': { stdout: '' },
      'rev-list --left-right --count main...feature/test': { stdout: '1 4' },
      'log -1 --format=%H%x1f%an%x1f%aI%x1f%s HEAD': { stdout: 'head777\u001fJean\u001f2026-04-04T00:00:00Z\u001fReviewed cleanup branch' },
      'worktree remove /repo-worktree': { stdout: '' },
      'worktree prune': { stdout: '' },
      'update-ref -d refs/heads/feature/test abc777': { stdout: '' },
    });

    const reviewFingerprint = createCleanupFingerprint({
      headOid: 'head777',
      branchRefOid: 'abc777',
      baselineOid: 'baseline123',
      statusDigest: '',
    });

    const result = await cleanupWorkspaceCandidate({
      attemptRepository,
      policyResolver,
      leaseService,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
      worktreePath: '/repo-worktree',
      deleteBranch: true,
      riskAccepted: true,
      reviewFingerprint,
    });

    expect(result.summary.disposition).toBe('completed');
    expect(result.summary.branchRemoved).toBe(true);
  });
});

describe('cleanupSafeWorkspaceCandidates', () => {
  let attemptRepository: WorkspaceAttemptRepository;
  let policyResolver: RepoPolicyResolver;
  let leaseService: WorktreeLeaseService;

  beforeEach(() => {
    vi.clearAllMocks();
    attemptRepository = new WorkspaceAttemptRepository();
    policyResolver = new RepoPolicyResolver({ profiles: [{ projectId: 'github.com/org/repo', baselineRef: 'main' }] });
    leaseService = new WorktreeLeaseService();
  });

  it('cleans up only currently safe candidates', async () => {
    mockInspectCleanupCandidates
      .mockResolvedValueOnce([
        cleanupCandidate({
          worktreePath: '/repo-safe-a',
          branch: 'feature/safe-a',
          classification: 'merged',
          reasonCode: 'ancestor_of_baseline',
        }),
        cleanupCandidate({
          worktreePath: '/repo-safe-b',
          branch: 'feature/safe-b',
          classification: 'patch_equivalent',
          reasonCode: 'no_unique_patches',
        }),
        cleanupCandidate({
          worktreePath: '/repo-unique',
          branch: 'feature/unique',
          classification: 'unique_commits',
          reasonCode: 'has_unique_commits',
        }),
      ])
      .mockResolvedValueOnce([
        cleanupCandidate({
          worktreePath: '/repo-safe-a',
          branch: 'feature/safe-a',
          classification: 'merged',
          reasonCode: 'ancestor_of_baseline',
        }),
        cleanupCandidate({
          worktreePath: '/repo-safe-b',
          branch: 'feature/safe-b',
          classification: 'patch_equivalent',
          reasonCode: 'no_unique_patches',
        }),
      ])
      .mockResolvedValueOnce([
        cleanupCandidate({
          worktreePath: '/repo-safe-a',
          branch: 'feature/safe-a',
          classification: 'merged',
          reasonCode: 'ancestor_of_baseline',
        }),
        cleanupCandidate({
          worktreePath: '/repo-safe-b',
          branch: 'feature/safe-b',
          classification: 'patch_equivalent',
          reasonCode: 'no_unique_patches',
        }),
      ]);

    mockGitResponses({
      'rev-parse HEAD': { stdout: 'head123' },
      'rev-parse --verify refs/heads/feature/safe-a': { stdout: 'safea123' },
      'rev-parse --verify refs/heads/feature/safe-b': { stdout: 'safeb123' },
      'rev-parse --verify main': { stdout: 'baseline123' },
      'status --porcelain=v1': { stdout: '' },
      'rev-list --left-right --count main...feature/safe-a': { stdout: '0 0' },
      'rev-list --left-right --count main...feature/safe-b': { stdout: '0 0' },
      'log -1 --format=%H%x1f%an%x1f%aI%x1f%s HEAD': { stdout: 'head123\u001fJean\u001f2026-04-04T00:00:00Z\u001fSafe branch' },
      'worktree remove /repo-safe-a': { stdout: '' },
      'worktree remove /repo-safe-b': { stdout: '' },
      'worktree prune': { stdout: '' },
      'update-ref -d refs/heads/feature/safe-a safea123': { stdout: '' },
      'update-ref -d refs/heads/feature/safe-b safeb123': { stdout: '' },
    });

    const result = await cleanupSafeWorkspaceCandidates({
      attemptRepository,
      policyResolver,
      leaseService,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
    });

    expect(result.summaries).toHaveLength(2);
    expect(result.summaries.map((summary) => summary.branch)).toEqual(['feature/safe-a', 'feature/safe-b']);
  });

  it('continues past candidates that become unsafe before execution', async () => {
    mockInspectCleanupCandidates
      .mockResolvedValueOnce([
        cleanupCandidate({
          worktreePath: '/repo-safe-a',
          branch: 'feature/safe-a',
          classification: 'merged',
          reasonCode: 'ancestor_of_baseline',
        }),
        cleanupCandidate({
          worktreePath: '/repo-safe-b',
          branch: 'feature/safe-b',
          classification: 'patch_equivalent',
          reasonCode: 'no_unique_patches',
        }),
      ])
      .mockResolvedValueOnce([
        cleanupCandidate({
          worktreePath: '/repo-safe-a',
          branch: 'feature/safe-a',
          classification: 'dirty',
          reasonCode: 'uncommitted_changes',
        }),
        cleanupCandidate({
          worktreePath: '/repo-safe-b',
          branch: 'feature/safe-b',
          classification: 'patch_equivalent',
          reasonCode: 'no_unique_patches',
        }),
      ])
      .mockResolvedValueOnce([
        cleanupCandidate({
          worktreePath: '/repo-safe-a',
          branch: 'feature/safe-a',
          classification: 'dirty',
          reasonCode: 'uncommitted_changes',
        }),
        cleanupCandidate({
          worktreePath: '/repo-safe-b',
          branch: 'feature/safe-b',
          classification: 'patch_equivalent',
          reasonCode: 'no_unique_patches',
        }),
      ]);

    mockGitResponses({
      'rev-parse HEAD': { stdout: 'head123' },
      'rev-parse --verify refs/heads/feature/safe-b': { stdout: 'safeb123' },
      'rev-parse --verify main': { stdout: 'baseline123' },
      'status --porcelain=v1': { stdout: '' },
      'rev-list --left-right --count main...feature/safe-b': { stdout: '0 0' },
      'log -1 --format=%H%x1f%an%x1f%aI%x1f%s HEAD': { stdout: 'head123\u001fJean\u001f2026-04-04T00:00:00Z\u001fSafe branch' },
      'worktree remove /repo-safe-b': { stdout: '' },
      'worktree prune': { stdout: '' },
      'update-ref -d refs/heads/feature/safe-b safeb123': { stdout: '' },
    });

    const result = await cleanupSafeWorkspaceCandidates({
      attemptRepository,
      policyResolver,
      leaseService,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
    });

    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0].branch).toBe('feature/safe-b');
    const attempts = attemptRepository.listByProject('github.com/org/repo');
    expect(attempts.some((attempt) => attempt.status === 'blocked')).toBe(true);
  });

  it('respects a caller-supplied classificationFilter (merged only)', async () => {
    mockInspectCleanupCandidates
      .mockResolvedValueOnce([
        cleanupCandidate({
          worktreePath: '/repo-merged',
          branch: 'feature/merged',
          classification: 'merged',
          reasonCode: 'ancestor_of_baseline',
        }),
        cleanupCandidate({
          worktreePath: '/repo-patch-eq',
          branch: 'feature/patch-eq',
          classification: 'patch_equivalent',
          reasonCode: 'no_unique_patches',
        }),
      ])
      .mockResolvedValueOnce([
        cleanupCandidate({
          worktreePath: '/repo-merged',
          branch: 'feature/merged',
          classification: 'merged',
          reasonCode: 'ancestor_of_baseline',
        }),
      ]);

    mockGitResponses({
      'rev-parse HEAD': { stdout: 'head123' },
      'rev-parse --verify refs/heads/feature/merged': { stdout: 'merged123' },
      'rev-parse --verify main': { stdout: 'baseline123' },
      'status --porcelain=v1': { stdout: '' },
      'rev-list --left-right --count main...feature/merged': { stdout: '0 0' },
      'log -1 --format=%H%x1f%an%x1f%aI%x1f%s HEAD': { stdout: 'head123Jean2026-04-04T00:00:00ZMerged branch' },
      'worktree remove /repo-merged': { stdout: '' },
      'worktree prune': { stdout: '' },
      'update-ref -d refs/heads/feature/merged merged123': { stdout: '' },
    });

    const result = await cleanupSafeWorkspaceCandidates({
      attemptRepository,
      policyResolver,
      leaseService,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
      classificationFilter: (candidate) => candidate.classification === 'merged',
    });

    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0].branch).toBe('feature/merged');
  });

  it('stamps sweepRunId onto attempt records when provided', async () => {
    mockInspectCleanupCandidates
      .mockResolvedValueOnce([
        cleanupCandidate({
          worktreePath: '/repo-merged',
          branch: 'feature/merged',
          classification: 'merged',
          reasonCode: 'ancestor_of_baseline',
        }),
      ])
      .mockResolvedValueOnce([
        cleanupCandidate({
          worktreePath: '/repo-merged',
          branch: 'feature/merged',
          classification: 'merged',
          reasonCode: 'ancestor_of_baseline',
        }),
      ]);

    mockGitResponses({
      'rev-parse HEAD': { stdout: 'head123' },
      'rev-parse --verify refs/heads/feature/merged': { stdout: 'merged123' },
      'rev-parse --verify main': { stdout: 'baseline123' },
      'status --porcelain=v1': { stdout: '' },
      'rev-list --left-right --count main...feature/merged': { stdout: '0 0' },
      'log -1 --format=%H%x1f%an%x1f%aI%x1f%s HEAD': { stdout: 'head123Jean2026-04-04T00:00:00ZMerged branch' },
      'worktree remove /repo-merged': { stdout: '' },
      'worktree prune': { stdout: '' },
      'update-ref -d refs/heads/feature/merged merged123': { stdout: '' },
    });

    await cleanupSafeWorkspaceCandidates({
      attemptRepository,
      policyResolver,
      leaseService,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
      sweepRunId: 'run-xyz',
    });

    const attempts = attemptRepository.listByProject('github.com/org/repo');
    const cleanupAttempts = attempts.filter((a) => a.type === 'cleanup');
    expect(cleanupAttempts).toHaveLength(1);
    expect(cleanupAttempts[0].sweepRunId).toBe('run-xyz');
    expect(cleanupAttempts[0].source).toBe('cross_project_sweep');
  });

  it('preserves existing per-project behavior when signal is undefined', async () => {
    // Backward-compat: the per-project panel calls with no signal / no filter / no sweepRunId.
    // This must continue to work and must include patch_equivalent.
    mockInspectCleanupCandidates
      .mockResolvedValueOnce([
        cleanupCandidate({
          worktreePath: '/repo-merged',
          branch: 'feature/merged',
          classification: 'merged',
          reasonCode: 'ancestor_of_baseline',
        }),
        cleanupCandidate({
          worktreePath: '/repo-patch-eq',
          branch: 'feature/patch-eq',
          classification: 'patch_equivalent',
          reasonCode: 'no_unique_patches',
        }),
      ])
      .mockResolvedValueOnce([
        cleanupCandidate({
          worktreePath: '/repo-merged',
          branch: 'feature/merged',
          classification: 'merged',
          reasonCode: 'ancestor_of_baseline',
        }),
        cleanupCandidate({
          worktreePath: '/repo-patch-eq',
          branch: 'feature/patch-eq',
          classification: 'patch_equivalent',
          reasonCode: 'no_unique_patches',
        }),
      ])
      .mockResolvedValueOnce([
        cleanupCandidate({
          worktreePath: '/repo-merged',
          branch: 'feature/merged',
          classification: 'merged',
          reasonCode: 'ancestor_of_baseline',
        }),
        cleanupCandidate({
          worktreePath: '/repo-patch-eq',
          branch: 'feature/patch-eq',
          classification: 'patch_equivalent',
          reasonCode: 'no_unique_patches',
        }),
      ]);

    mockGitResponses({
      'rev-parse HEAD': { stdout: 'head123' },
      'rev-parse --verify refs/heads/feature/merged': { stdout: 'merged123' },
      'rev-parse --verify refs/heads/feature/patch-eq': { stdout: 'patcheq123' },
      'rev-parse --verify main': { stdout: 'baseline123' },
      'status --porcelain=v1': { stdout: '' },
      'rev-list --left-right --count main...feature/merged': { stdout: '0 0' },
      'rev-list --left-right --count main...feature/patch-eq': { stdout: '0 0' },
      'log -1 --format=%H%x1f%an%x1f%aI%x1f%s HEAD': { stdout: 'head123Jean2026-04-04T00:00:00ZSafe branch' },
      'worktree remove /repo-merged': { stdout: '' },
      'worktree remove /repo-patch-eq': { stdout: '' },
      'worktree prune': { stdout: '' },
      'update-ref -d refs/heads/feature/merged merged123': { stdout: '' },
      'update-ref -d refs/heads/feature/patch-eq patcheq123': { stdout: '' },
    });

    const result = await cleanupSafeWorkspaceCandidates({
      attemptRepository,
      policyResolver,
      leaseService,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
      // no classificationFilter, no signal, no sweepRunId — must match pre-change behavior
    });

    expect(result.summaries).toHaveLength(2);
    expect(result.summaries.map((s) => s.branch).sort()).toEqual(['feature/merged', 'feature/patch-eq']);
    const attempts = attemptRepository.listByProject('github.com/org/repo');
    const cleanupAttempts = attempts.filter((a) => a.type === 'cleanup');
    expect(cleanupAttempts.every((a) => a.sweepRunId === undefined)).toBe(true);
    expect(cleanupAttempts.every((a) => a.source === 'workspace_ui')).toBe(true);
  });
});

describe('bulkRemoveProbablySafeCandidates (RFC PR 3)', () => {
  let attemptRepository: WorkspaceAttemptRepository;
  let policyResolver: RepoPolicyResolver;
  let leaseService: WorktreeLeaseService;

  beforeEach(() => {
    vi.clearAllMocks();
    attemptRepository = new WorkspaceAttemptRepository();
    policyResolver = new RepoPolicyResolver({ profiles: [{ projectId: 'github.com/org/repo', baselineRef: 'main' }] });
    leaseService = new WorktreeLeaseService();
    mockInspectCleanupCandidate.mockImplementation(async (_repoPath, _projectId, worktreePath) => {
      const candidates = await mockInspectCleanupCandidates();
      return candidates.find((candidate) => candidate.worktreePath === worktreePath);
    });
  });

  const deps = () => ({ attemptRepository, policyResolver, leaseService });
  const resolveRepoPath = async () => '/repo';

  /** git responses for a healthy keep-branch removal of a unique_commits row. */
  function mockKeepBranchGit(overrides: Record<string, { stdout?: string; stderr?: string; error?: boolean }> = {}) {
    mockGitResponses({
      'rev-parse HEAD': { stdout: 'head123' },
      'rev-parse --verify refs/heads/feature/test': { stdout: 'abc123' },
      'rev-parse --verify main': { stdout: 'baseline123' },
      'status --porcelain=v1': { stdout: '' },
      'rev-list --left-right --count main...feature/test': { stdout: '1 0' },
      'log -1 --format=%H%x1f%an%x1f%aI%x1f%s HEAD': { stdout: 'head123Jean2026-04-04T00:00:00ZLocal only' },
      'worktree remove /repo-worktree': { stdout: '' },
      'worktree prune': { stdout: '' },
      ...overrides,
    });
  }

  const matchingFingerprint = () => createCleanupFingerprint({
    headOid: 'head123',
    branchRefOid: 'abc123',
    baselineOid: 'baseline123',
    statusDigest: '',
  });

  it('removes the path but NEVER deletes the branch (keep-branch regression)', async () => {
    mockInspectCleanupCandidates.mockResolvedValue([cleanupCandidate({
      classification: 'unique_commits',
      reasonCode: 'has_unique_commits',
    })]);
    mockKeepBranchGit();

    const result = await bulkRemoveProbablySafeCandidates(deps(), {
      runId: 'bulk-1',
      resolveRepoPath,
      rows: [{
        projectId: 'github.com/org/repo',
        worktreePath: '/repo-worktree',
        branch: 'feature/test',
        fingerprint: matchingFingerprint(),
      }],
    });

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.status).toBe('done');
    expect(result.rows[0]!.branchRemoved).toBe(false);
    expect(result.rows[0]!.disposition).toBe('path_removed_branch_retained');
    // Structural proof the branch ref was never touched: no branch delete ran.
    expect(mockExecFile.mock.calls.some(([, args]) => args.includes('update-ref'))).toBe(false);
    // The path WAS reclaimed.
    expect(mockExecFile.mock.calls.some(([, args]) => args.includes('worktree') && args.includes('remove'))).toBe(true);
  });

  it('skips a row that became busy between report and bulk (revalidation)', async () => {
    mockInspectCleanupCandidates.mockResolvedValue([cleanupCandidate({
      classification: 'busy',
      reasonCode: 'active_lease',
    })]);
    mockKeepBranchGit();

    const result = await bulkRemoveProbablySafeCandidates(deps(), {
      runId: 'bulk-busy',
      resolveRepoPath,
      rows: [{
        projectId: 'github.com/org/repo',
        worktreePath: '/repo-worktree',
        branch: 'feature/test',
        fingerprint: matchingFingerprint(),
      }],
    });

    expect(result.rows[0]!.status).toBe('skipped');
    expect(result.rows[0]!.branchRemoved).toBe(false);
    // Blocked before any destructive git ran.
    expect(mockExecFile.mock.calls.some(([, args]) => args.includes('worktree') && args.includes('remove'))).toBe(false);
  });

  it('degrades to a benign skip when a second actor already removed the worktree', async () => {
    mockInspectCleanupCandidates.mockResolvedValue([cleanupCandidate({
      classification: 'unique_commits',
      reasonCode: 'has_unique_commits',
    })]);
    // The remove itself fails (second-actor double-click) → manual_intervention_required.
    mockKeepBranchGit({
      'worktree remove /repo-worktree': { error: true, stderr: 'fatal: not a working tree' },
    });

    const result = await bulkRemoveProbablySafeCandidates(deps(), {
      runId: 'bulk-race',
      resolveRepoPath,
      rows: [{
        projectId: 'github.com/org/repo',
        worktreePath: '/repo-worktree',
        branch: 'feature/test',
        fingerprint: matchingFingerprint(),
      }],
    });

    expect(result.rows[0]!.status).toBe('skipped');
    expect(result.rows[0]!.branchRemoved).toBe(false);
    expect(mockExecFile.mock.calls.some(([, args]) => args.includes('update-ref'))).toBe(false);
  });

  it('skips a row whose fingerprint went stale (ref changed mid-window)', async () => {
    mockInspectCleanupCandidates.mockResolvedValue([cleanupCandidate({
      classification: 'unique_commits',
      reasonCode: 'has_unique_commits',
    })]);
    mockKeepBranchGit();

    const result = await bulkRemoveProbablySafeCandidates(deps(), {
      runId: 'bulk-stale',
      resolveRepoPath,
      rows: [{
        projectId: 'github.com/org/repo',
        worktreePath: '/repo-worktree',
        branch: 'feature/test',
        fingerprint: 'stale-fingerprint',
      }],
    });

    expect(result.rows[0]!.status).toBe('skipped');
    expect(result.rows[0]!.branchRemoved).toBe(false);
    expect(mockExecFile.mock.calls.some(([, args]) => args.includes('worktree') && args.includes('remove'))).toBe(false);
  });

  it('emits a determinate running→terminal progress event per selected row', async () => {
    mockInspectCleanupCandidates.mockResolvedValue([cleanupCandidate({
      classification: 'unique_commits',
      reasonCode: 'has_unique_commits',
    })]);
    mockKeepBranchGit();

    const events: BulkRemoveProgressEvent[] = [];
    await bulkRemoveProbablySafeCandidates(deps(), {
      runId: 'bulk-progress',
      resolveRepoPath,
      onProgress: (event) => events.push(event),
      rows: [{
        projectId: 'github.com/org/repo',
        worktreePath: '/repo-worktree',
        branch: 'feature/test',
        fingerprint: matchingFingerprint(),
      }],
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ index: 1, total: 1, status: 'running', worktreePath: '/repo-worktree' });
    expect(events[1]).toMatchObject({ index: 1, total: 1, status: 'done' });
    expect(events[1]!.result?.branchRemoved).toBe(false);
  });

  it('skips a row whose repo path cannot be resolved without touching git', async () => {
    mockInspectCleanupCandidates.mockResolvedValue([cleanupCandidate({
      classification: 'unique_commits',
      reasonCode: 'has_unique_commits',
    })]);
    mockKeepBranchGit();

    const result = await bulkRemoveProbablySafeCandidates(deps(), {
      runId: 'bulk-unresolved',
      resolveRepoPath: async () => { throw new Error('no repo path'); },
      rows: [{
        projectId: 'github.com/org/repo',
        worktreePath: '/repo-worktree',
        branch: 'feature/test',
        fingerprint: matchingFingerprint(),
      }],
    });

    expect(result.rows[0]!.status).toBe('skipped');
    expect(result.rows[0]!.reason).toContain('repo path');
    expect(mockExecFile.mock.calls.length).toBe(0);
  });
});
