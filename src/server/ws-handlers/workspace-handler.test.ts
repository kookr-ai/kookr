import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { WorkspaceHandler, type WorkspaceHandlerDeps } from './workspace-handler.js';

const {
  getWorkspaceViewMock,
  resolveWorkspaceContextMock,
  cleanupWorkspaceCandidateMock,
  cleanupSafeWorkspaceCandidatesMock,
  launchWorkspaceCleanupDiagnosticMock,
  getCleanupCandidateDetailMock,
} = vi.hoisted(() => ({
  getWorkspaceViewMock: vi.fn(),
  resolveWorkspaceContextMock: vi.fn(),
  cleanupWorkspaceCandidateMock: vi.fn(),
  cleanupSafeWorkspaceCandidatesMock: vi.fn(),
  launchWorkspaceCleanupDiagnosticMock: vi.fn(),
  getCleanupCandidateDetailMock: vi.fn(),
}));

vi.mock('../use-cases/contribution-workspace-query.js', () => ({
  getWorkspaceView: getWorkspaceViewMock,
}));

vi.mock('../use-cases/workspace-context.js', () => ({
  resolveWorkspaceContext: resolveWorkspaceContextMock,
}));

vi.mock('../use-cases/workspace-cleanup-service.js', () => ({
  cleanupWorkspaceCandidate: cleanupWorkspaceCandidateMock,
  cleanupSafeWorkspaceCandidates: cleanupSafeWorkspaceCandidatesMock,
}));

vi.mock('../use-cases/workspace-cleanup-diagnostic-service.js', () => ({
  launchWorkspaceCleanupDiagnostic: launchWorkspaceCleanupDiagnosticMock,
}));

vi.mock('../use-cases/workspace-cleanup-detail-query.js', () => ({
  getCleanupCandidateDetail: getCleanupCandidateDetailMock,
}));

function makeDeps(overrides: Partial<WorkspaceHandlerDeps> = {}): { deps: WorkspaceHandlerDeps; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  return {
    sent,
    deps: {
      send: (msg) => sent.push(msg),
      taskStore: {} as WorkspaceHandlerDeps['taskStore'],
      serverCwd: '/repo',
      workspaceEnabled: true,
      projectConfigStore: {} as WorkspaceHandlerDeps['projectConfigStore'],
      attemptRepository: {} as WorkspaceHandlerDeps['attemptRepository'],
      policyResolver: {} as WorkspaceHandlerDeps['policyResolver'],
      leaseService: {} as WorkspaceHandlerDeps['leaseService'],
      launchTask: vi.fn(),
      ...overrides,
    },
  };
}

// A stubbed view returned by getWorkspaceView so success/error-recovery paths
// have a concrete payload to broadcast.
const STUB_VIEW = {
  projectId: 'p1',
  displayName: 'p1',
  policy: 'contribution' as const,
  candidates: [],
  recentAttempts: [],
  activeLeases: [],
};

// Each of the five messages this handler dispatches, together with the response
// message `type` the availability guard emits and the field that carries the
// "Workspace is not available" text.
const MESSAGES = [
  { label: 'workspace:getView', msg: { type: 'workspace:getView', projectId: 'p1' }, responseType: 'workspaceView' },
  { label: 'workspace:getCleanupDetail', msg: { type: 'workspace:getCleanupDetail', projectId: 'p1', worktreePath: '/wt/a' }, responseType: 'workspaceCleanupDetail' },
  { label: 'workspace:runCleanupDiagnostic', msg: { type: 'workspace:runCleanupDiagnostic', projectId: 'p1', worktreePath: '/wt/a', reviewFingerprint: 'fp' }, responseType: 'workspaceView' },
  { label: 'workspace:cleanupCandidate', msg: { type: 'workspace:cleanupCandidate', projectId: 'p1', worktreePath: '/wt/a' }, responseType: 'workspaceView' },
  { label: 'workspace:bulkSafeCleanup', msg: { type: 'workspace:bulkSafeCleanup', projectId: 'p1' }, responseType: 'workspaceView' },
] as const;

describe('WorkspaceHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('availability guard', () => {
    for (const { label, msg, responseType } of MESSAGES) {
      it(`replies "Workspace is not available" for ${label} when a required dep is missing`, async () => {
        // workspaceEnabled is required by all five guards; drop it so every
        // branch takes its unavailable path without touching any use-case.
        const { deps, sent } = makeDeps({ workspaceEnabled: false });

        await new WorkspaceHandler(deps).handle(msg as never);

        expect(resolveWorkspaceContextMock).not.toHaveBeenCalled();
        expect(sent).toHaveLength(1);
        expect(sent[0]).toMatchObject({ type: responseType, error: 'Workspace is not available' });
      });
    }

    it('also guards when a non-enable dep (attemptRepository) is missing', async () => {
      // cleanupCandidate additionally requires attemptRepository; ensure the
      // guard is a conjunction, not just an `workspaceEnabled` check.
      const { deps, sent } = makeDeps({ attemptRepository: undefined });

      await new WorkspaceHandler(deps).handle({ type: 'workspace:cleanupCandidate', projectId: 'p1', worktreePath: '/wt/a' } as never);

      expect(cleanupWorkspaceCandidateMock).not.toHaveBeenCalled();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ type: 'workspaceView', error: 'Workspace is not available' });
    });
  });

  describe('use-case failures', () => {
    it('turns a throwing mutation into an error-tagged workspaceView, not an unhandled rejection', async () => {
      resolveWorkspaceContextMock.mockResolvedValue({ repoPath: '/resolved/repo' });
      cleanupWorkspaceCandidateMock.mockRejectedValueOnce(new Error('worktree removal exploded'));
      // sendViewWithError re-fetches the current view to attach the error to.
      getWorkspaceViewMock.mockResolvedValue(STUB_VIEW);

      const { deps, sent } = makeDeps();

      await expect(
        new WorkspaceHandler(deps).handle({ type: 'workspace:cleanupCandidate', projectId: 'p1', worktreePath: '/wt/a' } as never),
      ).resolves.toBeUndefined();

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: 'workspaceView',
        view: STUB_VIEW,
        error: 'worktree removal exploded',
      });
    });

    it('falls back to the unavailable placeholder view when the error-recovery re-fetch also throws', async () => {
      resolveWorkspaceContextMock.mockResolvedValue({ repoPath: '/resolved/repo' });
      cleanupSafeWorkspaceCandidatesMock.mockRejectedValueOnce(new Error('primary boom'));
      // Both the try-body view fetch and the sendViewWithError re-fetch fail.
      getWorkspaceViewMock.mockRejectedValue(new Error('secondary boom'));

      const { deps, sent } = makeDeps();

      await new WorkspaceHandler(deps).handle({ type: 'workspace:bulkSafeCleanup', projectId: 'p1' } as never);

      expect(sent).toHaveLength(1);
      // The user still gets an error tag carrying the *primary* failure, on the
      // empty placeholder view.
      expect(sent[0]).toMatchObject({
        type: 'workspaceView',
        error: 'primary boom',
        view: { projectId: 'p1', candidates: [], activeLeases: [] },
      });
    });
  });

  describe('workspace:cleanupCandidate wiring', () => {
    it('forwards projectId and worktreePath to the cleanup service exactly once', async () => {
      resolveWorkspaceContextMock.mockResolvedValue({ repoPath: '/resolved/repo' });
      cleanupWorkspaceCandidateMock.mockResolvedValue({ summary: { branch: 'feat/a', disposition: 'completed' } });
      getWorkspaceViewMock.mockResolvedValue(STUB_VIEW);

      const { deps, sent } = makeDeps();

      await new WorkspaceHandler(deps).handle({
        type: 'workspace:cleanupCandidate',
        projectId: 'p1',
        worktreePath: '/wt/a',
        branch: 'feat/a',
        deleteBranch: true,
      } as never);

      expect(cleanupWorkspaceCandidateMock).toHaveBeenCalledTimes(1);
      expect(cleanupWorkspaceCandidateMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ projectId: 'p1', worktreePath: '/wt/a', repoPath: '/resolved/repo' }),
      );
      // On success the handler broadcasts the refreshed view plus the summary.
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        type: 'workspaceView',
        view: STUB_VIEW,
        cleanupResult: { branch: 'feat/a', disposition: 'completed' },
      });
    });
  });
});
