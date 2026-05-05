import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWorkspaceView } from './contribution-workspace-query.js';
import { WorktreeLeaseService } from '../../core/worktree-lease-service.js';
import { RepoPolicyResolver } from '../../core/repo-policy-resolver.js';
import { WorkspaceAttemptRepository } from '../../core/workspace-attempt-repository.js';

// Mock the cleanup inspector
vi.mock('./cleanup-inspector.js', () => ({
  inspectCleanupCandidates: vi.fn().mockResolvedValue([]),
}));

import { inspectCleanupCandidates } from './cleanup-inspector.js';
const mockInspect = vi.mocked(inspectCleanupCandidates);

describe('getWorkspaceView', () => {
  let policyResolver: RepoPolicyResolver;
  let leaseService: WorktreeLeaseService;
  let attemptRepo: WorkspaceAttemptRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    policyResolver = new RepoPolicyResolver({
      profiles: [{ projectId: 'github.com/org/repo', baselineRef: 'main' }],
    });
    leaseService = new WorktreeLeaseService();
    attemptRepo = new WorkspaceAttemptRepository();
  });

  it('returns workspace view with correct fields', async () => {
    mockInspect.mockResolvedValue([]);

    const view = await getWorkspaceView('github.com/org/repo', '/repo', {
      policyResolver,
      leaseService,
      attemptRepository: attemptRepo,
    });

    expect(view.projectId).toBe('github.com/org/repo');
    expect(view.displayName).toBe('org/repo');
    expect(view.policy).toBe('known_policy');
    expect(view.candidates).toEqual([]);
    expect(view.recentAttempts).toEqual([]);
    expect(view.activeLeases).toEqual([]);
  });

  it('includes candidates from inspector', async () => {
    mockInspect.mockResolvedValue([
      {
        projectId: 'github.com/org/repo',
        worktreePath: '/wt1',
        branch: 'feature',
        classification: 'merged',
        reasonCode: 'ancestor_of_baseline',
        source: 'cleanup_inspector',
        observedAt: '2026-04-04T00:00:00Z',
        recoveryGuidance: 'Safe to remove',
      },
    ]);

    const view = await getWorkspaceView('github.com/org/repo', '/repo', {
      policyResolver,
      leaseService,
      attemptRepository: attemptRepo,
    });

    expect(view.candidates).toHaveLength(1);
    expect(view.candidates[0].classification).toBe('merged');
  });

  it('includes recent attempts', async () => {
    attemptRepo.createAttempt({
      type: 'preflight',
      projectId: 'github.com/org/repo',
      reasonCode: 'test',
      source: 'test',
      evidenceSummary: 'test attempt',
    });

    const view = await getWorkspaceView('github.com/org/repo', '/repo', {
      policyResolver,
      leaseService,
      attemptRepository: attemptRepo,
    });

    expect(view.recentAttempts).toHaveLength(1);
  });

  it('includes active leases', async () => {
    leaseService.acquire('/wt1', 'task-1');

    const view = await getWorkspaceView('github.com/org/repo', '/repo', {
      policyResolver,
      leaseService,
      attemptRepository: attemptRepo,
    });

    expect(view.activeLeases).toHaveLength(1);
    expect(view.activeLeases[0].worktreePath).toBe('/wt1');
  });

  it('returns unknown_policy for unconfigured repos', async () => {
    const view = await getWorkspaceView('github.com/unknown/repo', '/repo', {
      policyResolver,
      leaseService,
      attemptRepository: attemptRepo,
    });

    expect(view.policy).toBe('unknown_policy');
  });

  it('handles inspector failure gracefully', async () => {
    mockInspect.mockRejectedValue(new Error('git not found'));

    const view = await getWorkspaceView('github.com/org/repo', '/repo', {
      policyResolver,
      leaseService,
      attemptRepository: attemptRepo,
    });

    // Should not throw, candidates should be empty
    expect(view.candidates).toEqual([]);
  });
});
