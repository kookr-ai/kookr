import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WorkspaceAttemptRepository } from '../../core/workspace-attempt-repository.js';
import { RepoPolicyResolver } from '../../core/repo-policy-resolver.js';
import { WorktreeLeaseService } from '../../core/worktree-lease-service.js';
import {
  buildCleanupDiagnosticPrompt,
  launchWorkspaceCleanupDiagnostic,
} from './workspace-cleanup-diagnostic-service.js';
import { deriveCleanupCapabilities } from '../../core/workspace-cleanup-policy.js';

vi.mock('./workspace-cleanup-detail-query.js', () => ({
  getCleanupCandidateDetail: vi.fn(),
}));

import { getCleanupCandidateDetail } from './workspace-cleanup-detail-query.js';

const mockGetCleanupCandidateDetail = vi.mocked(getCleanupCandidateDetail);

describe('launchWorkspaceCleanupDiagnostic', () => {
  let attemptRepository: WorkspaceAttemptRepository;
  let policyResolver: RepoPolicyResolver;
  let leaseService: WorktreeLeaseService;
  let launchTask: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    attemptRepository = new WorkspaceAttemptRepository();
    policyResolver = new RepoPolicyResolver({ profiles: [{ projectId: 'github.com/org/repo', baselineRef: 'main' }] });
    leaseService = new WorktreeLeaseService();
    launchTask = vi.fn().mockResolvedValue({
      task: { id: 'task-42' },
      queued: false,
    });
  });

  it('launches a normal Kookr task for a dirty candidate', async () => {
    mockGetCleanupCandidateDetail.mockResolvedValue({
      projectId: 'github.com/org/repo',
      worktreePath: '/repo-worktree',
      branch: 'feature/dirty',
      classification: 'dirty',
      reasonCode: 'uncommitted_changes',
      fingerprint: 'fresh-fingerprint',
      dirtySummary: { modified: 1, added: 0, deleted: 0, renamed: 0, untracked: 2 },
      dirtyFilesSample: [{ path: 'scratch.txt', status: '??' }],
      capabilities: deriveCleanupCapabilities({
        classification: 'dirty',
        reasonCode: 'uncommitted_changes',
      }),
    });

    const result = await launchWorkspaceCleanupDiagnostic({
      attemptRepository,
      policyResolver,
      leaseService,
      launchTask,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
      worktreePath: '/repo-worktree',
      reviewFingerprint: 'fresh-fingerprint',
    });

    expect(result.launch.taskId).toBe('task-42');
    expect(launchTask).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo-worktree',
      disableDedup: true,
      name: 'Cleanup diagnostic: feature/dirty',
    }));
    const [attempt] = attemptRepository.listByProject('github.com/org/repo');
    expect(attempt.type).toBe('diagnostic');
    expect(attempt.correlatedTaskId).toBe('task-42');
    expect(attempt.status).toBe('passed');
  });

  it('rejects stale fingerprints before launching a task', async () => {
    mockGetCleanupCandidateDetail.mockResolvedValue({
      projectId: 'github.com/org/repo',
      worktreePath: '/repo-worktree',
      branch: 'feature/dirty',
      classification: 'dirty',
      reasonCode: 'uncommitted_changes',
      fingerprint: 'new-fingerprint',
      capabilities: deriveCleanupCapabilities({
        classification: 'dirty',
        reasonCode: 'uncommitted_changes',
      }),
    });

    await expect(launchWorkspaceCleanupDiagnostic({
      attemptRepository,
      policyResolver,
      leaseService,
      launchTask,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
      worktreePath: '/repo-worktree',
      reviewFingerprint: 'stale-fingerprint',
    })).rejects.toThrow('Cleanup diagnostic review is stale');

    expect(launchTask).not.toHaveBeenCalled();
  });

  it('blocks diagnostics for safe candidates', async () => {
    mockGetCleanupCandidateDetail.mockResolvedValue({
      projectId: 'github.com/org/repo',
      worktreePath: '/repo-worktree',
      branch: 'feature/merged',
      classification: 'merged',
      reasonCode: 'ancestor_of_baseline',
      fingerprint: 'fresh-fingerprint',
      capabilities: deriveCleanupCapabilities({
        classification: 'merged',
        reasonCode: 'ancestor_of_baseline',
      }),
    });

    await expect(launchWorkspaceCleanupDiagnostic({
      attemptRepository,
      policyResolver,
      leaseService,
      launchTask,
    }, {
      projectId: 'github.com/org/repo',
      repoPath: '/repo',
      worktreePath: '/repo-worktree',
      reviewFingerprint: 'fresh-fingerprint',
    })).rejects.toThrow('Cleanup diagnostics are only available');
  });
});

describe('buildCleanupDiagnosticPrompt', () => {
  it('includes advisory-only instructions and cleanup evidence', () => {
    const prompt = buildCleanupDiagnosticPrompt({
      projectId: 'github.com/org/repo',
      worktreePath: '/repo-worktree',
      branch: 'feature/dirty',
      classification: 'dirty',
      reasonCode: 'uncommitted_changes',
      fingerprint: 'fresh-fingerprint',
      dirtySummary: { modified: 1, added: 0, deleted: 0, renamed: 0, untracked: 1 },
      dirtyFilesSample: [{ path: 'scratch.txt', status: '??' }],
      commitSummary: { aheadCount: 2, behindCount: 1, lastCommitSha: 'abc123', lastCommitSubject: 'Investigate cleanup' },
      capabilities: deriveCleanupCapabilities({
        classification: 'dirty',
        reasonCode: 'uncommitted_changes',
      }),
    });

    expect(prompt).toContain('advisory guidance only');
    expect(prompt).toContain('Do not delete branches');
    expect(prompt).toContain('Worktree path: /repo-worktree');
    expect(prompt).toContain('Dirty file sample:');
    expect(prompt).toContain('?? scratch.txt');
  });
});
