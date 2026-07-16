import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RepoPolicyResolver } from '../../core/repo-policy-resolver.js';
import { WorktreeLeaseService } from '../../core/worktree-lease-service.js';
import {
  createCleanupFingerprint,
  getCleanupCandidateDetail,
} from './workspace-cleanup-detail-query.js';
import { deriveCleanupCapabilities } from '../../core/workspace-cleanup-policy.js';

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

vi.mock('./cleanup-inspector.js', () => ({
  inspectCleanupCandidates: vi.fn(),
}));

import { inspectCleanupCandidates } from './cleanup-inspector.js';

const mockInspectCleanupCandidates = vi.mocked(inspectCleanupCandidates);

function mockGitResponses(handlers: Record<string, string>) {
  mockExecFile.mockImplementation((_cmd: string, args: string[], maybeOpts: unknown, maybeCb?: Function) => {
    const cb = typeof maybeCb === 'function'
      ? maybeCb
      : maybeOpts as Function;
    const argsStr = args.join(' ');
    for (const [pattern, response] of Object.entries(handlers)) {
      if (argsStr.includes(pattern)) {
        cb(null, { stdout: response, stderr: '' });
        return;
      }
    }
    cb(new Error(`Unhandled git args: ${argsStr}`));
  });
}

describe('getCleanupCandidateDetail', () => {
  let policyResolver: RepoPolicyResolver;
  let leaseService: WorktreeLeaseService;

  beforeEach(() => {
    vi.clearAllMocks();
    policyResolver = new RepoPolicyResolver({ profiles: [{ projectId: 'github.com/org/repo', baselineRef: 'main' }] });
    leaseService = new WorktreeLeaseService();
  });

  it('returns fingerprinted dirty evidence and commit summary on demand', async () => {
    mockInspectCleanupCandidates.mockResolvedValue([{
      projectId: 'github.com/org/repo',
      worktreePath: '/repo-worktree',
      branch: 'feature/detail',
      classification: 'unique_commits',
      reasonCode: 'has_unique_commits',
      source: 'cleanup_inspector',
      baselineRef: 'main',
      baselineSha: 'baseline123',
      checkedAt: '2026-04-04T00:00:00Z',
      observedAt: '2026-04-04T00:00:00Z',
      recoveryGuidance: 'Review before removing.',
      capabilities: deriveCleanupCapabilities({
        classification: 'unique_commits',
        reasonCode: 'has_unique_commits',
      }),
    }]);
    mockGitResponses({
      'rev-parse HEAD': 'head123\n',
      'rev-parse --path-format=absolute --git-dir': '/repo/.git/worktrees/detail\n',
      'rev-parse --verify refs/heads/feature/detail': 'branch123\n',
      'status --porcelain=v1': ' M src/file.ts\nA  src/new.ts\n?? scratch.txt\n',
      'rev-list --left-right --count main...feature/detail': '2 5\n',
      'log -1 --format=%H%x1f%an%x1f%aI%x1f%s HEAD': 'head123\u001fJean\u001f2026-04-04T00:00:00Z\u001fRefine cleanup policy\n',
    });

    const detail = await getCleanupCandidateDetail({
      policyResolver,
      leaseService,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
      worktreePath: '/repo-worktree',
    });

    expect(detail.commitSummary).toMatchObject({
      aheadCount: 5,
      behindCount: 2,
      lastCommitSubject: 'Refine cleanup policy',
    });
    expect(detail.dirtySummary).toEqual({
      modified: 1,
      added: 1,
      deleted: 0,
      renamed: 0,
      untracked: 1,
    });
    expect(detail.dirtyFilesSample).toEqual([
      { path: 'src/file.ts', status: ' M' },
      { path: 'src/new.ts', status: 'A ' },
      { path: 'scratch.txt', status: '??' },
    ]);
    expect(detail.fingerprint).toBe(createCleanupFingerprint({
      headOid: 'head123',
      gitDir: '/repo/.git/worktrees/detail',
      branchRefOid: 'branch123',
      baselineOid: 'baseline123',
      statusDigest: ' M src/file.ts\n?? scratch.txt\nA  src/new.ts',
    }));
  });
});
