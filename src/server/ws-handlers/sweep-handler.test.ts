import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { SweepHandler, type SweepHandlerDeps } from './sweep-handler.js';

const {
  runCrossProjectSweepMock,
  resolveWorkspaceContextMock,
  bulkRemoveProbablySafeCandidatesMock,
} = vi.hoisted(() => ({
  runCrossProjectSweepMock: vi.fn(),
  resolveWorkspaceContextMock: vi.fn(),
  bulkRemoveProbablySafeCandidatesMock: vi.fn(),
}));

vi.mock('../use-cases/cross-project-cleanup-sweep.js', () => ({
  runCrossProjectSweep: runCrossProjectSweepMock,
}));

vi.mock('../use-cases/workspace-context.js', () => ({
  resolveWorkspaceContext: resolveWorkspaceContextMock,
}));

vi.mock('../use-cases/workspace-cleanup-service.js', () => ({
  bulkRemoveProbablySafeCandidates: bulkRemoveProbablySafeCandidatesMock,
}));

function makeDeps(overrides: Partial<SweepHandlerDeps> = {}): { deps: SweepHandlerDeps; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  return {
    sent,
    deps: {
      send: (msg) => sent.push(msg),
      taskStore: { getAllTasks: () => [] } as unknown as SweepHandlerDeps['taskStore'],
      serverCwd: '/repo',
      workspaceEnabled: true,
      projectConfigStore: {} as SweepHandlerDeps['projectConfigStore'],
      attemptRepository: {} as SweepHandlerDeps['attemptRepository'],
      policyResolver: {} as SweepHandlerDeps['policyResolver'],
      leaseService: {} as SweepHandlerDeps['leaseService'],
      ...overrides,
    },
  };
}

describe('SweepHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports workspace_unavailable instead of an empty successful sweep when deps are missing', async () => {
    const { deps, sent } = makeDeps({
      workspaceEnabled: false,
      attemptRepository: undefined,
    });

    await new SweepHandler(deps).handle();

    expect(runCrossProjectSweepMock).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'workspaceSweepComplete',
      runId: '',
      projects: [{
        kind: 'skipped',
        projectId: '',
        reason: 'workspace_unavailable',
        missingDeps: ['workspaceEnabled', 'attemptRepository'],
      }],
    });
  });

  it('emits the sweep completion summary without broadcasting unrelated workspace views', async () => {
    runCrossProjectSweepMock.mockResolvedValueOnce({
      kind: 'completed',
      result: {
        runId: 'run-1',
        startedAt: '2026-06-21T05:00:00.000Z',
        finishedAt: '2026-06-21T05:00:01.000Z',
        projects: [
          {
            kind: 'ok',
            projectId: 'github.com/acme/a',
            summaries: [{ branch: 'feat/a', disposition: 'completed', pathRemoved: true, branchRemoved: true }],
            elapsedMs: 5,
          },
          { kind: 'skipped', projectId: 'github.com/acme/b', reason: 'repo_path_unresolved' },
        ],
      },
    });

    const { deps, sent } = makeDeps();
    await new SweepHandler(deps).handle();

    expect(resolveWorkspaceContextMock).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'workspaceSweepComplete',
      runId: 'run-1',
      projects: [
        { kind: 'ok', projectId: 'github.com/acme/a' },
        { kind: 'skipped', projectId: 'github.com/acme/b', reason: 'repo_path_unresolved' },
      ],
    });
  });

  it('carries the disk-aware report on the completion broadcast', async () => {
    const report = {
      runId: 'run-r',
      generatedAt: '2026-06-21T05:00:01.000Z',
      thresholdDays: 14,
      rows: [],
      buckets: {
        removed: { count: 1, footprintBytesUpperBound: 0, unknownFootprintCount: 1 },
        removal_failed: { count: 0, footprintBytesUpperBound: 0, unknownFootprintCount: 0 },
        probably_safe: { count: 0, footprintBytesUpperBound: 0, unknownFootprintCount: 0 },
        needs_call: { count: 0, footprintBytesUpperBound: 0, unknownFootprintCount: 0 },
        blocked: { count: 0, footprintBytesUpperBound: 0, unknownFootprintCount: 0 },
      },
      notAnalyzed: [],
    };
    runCrossProjectSweepMock.mockResolvedValueOnce({
      kind: 'completed',
      result: {
        runId: 'run-r',
        startedAt: '2026-06-21T05:00:00.000Z',
        finishedAt: '2026-06-21T05:00:01.000Z',
        projects: [],
        report,
      },
    });

    const { deps, sent } = makeDeps();
    await new SweepHandler(deps).handle();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'workspaceSweepComplete', runId: 'run-r', report });
  });

  it('reconstructs the Removed manifest from the ledger on report request', () => {
    const listBySweepRunId = vi.fn().mockReturnValue([
      { attemptId: 'a1', type: 'cleanup', projectId: 'p', reasonCode: 'cleanup_requested', source: 'cross_project_sweep', observedAt: 'x', startedAt: 'x', status: 'completed', disposition: 'completed', evidenceSummary: '', sweepRunId: 'run-x', worktreePath: '/wt/a', branch: 'a' },
      { attemptId: 'a2', type: 'cleanup', projectId: 'p', reasonCode: 'cleanup_requested', source: 'cross_project_sweep', observedAt: 'x', startedAt: 'x', status: 'completed', disposition: 'manual_intervention_required', evidenceSummary: '', sweepRunId: 'run-x', worktreePath: '/wt/b', branch: 'b' },
      { attemptId: 'a3', type: 'cleanup', projectId: 'p', reasonCode: 'cross_project_sweep', source: 'cross_project_sweep', observedAt: 'x', startedAt: 'x', status: 'passed', disposition: 'passed', evidenceSummary: '', sweepRunId: 'run-x' },
    ]);
    const { deps, sent } = makeDeps({
      attemptRepository: { listBySweepRunId } as unknown as SweepHandlerDeps['attemptRepository'],
    });

    new SweepHandler(deps).handleReportRequest('run-x');

    expect(listBySweepRunId).toHaveBeenCalledWith('run-x');
    expect(sent).toHaveLength(1);
    const msg = sent[0] as Extract<ServerMessage, { type: 'workspaceSweepReport' }>;
    expect(msg.type).toBe('workspaceSweepReport');
    expect(msg.runId).toBe('run-x');
    expect(msg.report?.reconstructedFromLedger).toBe(true);
    expect(msg.report?.buckets.removed.count).toBe(1);
    expect(msg.report?.buckets.removal_failed.count).toBe(1);
  });

  it('broadcasts bulk-remove progress and re-resolves repo paths per row', async () => {
    resolveWorkspaceContextMock.mockResolvedValue({ repoPath: '/resolved/repo' });
    bulkRemoveProbablySafeCandidatesMock.mockImplementationOnce(async (_deps: unknown, input: {
      resolveRepoPath: (p: string) => Promise<string>;
      onProgress?: (event: unknown) => void;
      rows: unknown[];
    }) => {
      // The handler wires a resolver backed by resolveWorkspaceContext.
      await expect(input.resolveRepoPath('github.com/acme/a')).resolves.toBe('/resolved/repo');
      input.onProgress?.({ runId: 'bulk-1', index: 1, total: 1, projectId: 'github.com/acme/a', worktreePath: '/wt/a', status: 'done' });
      return { runId: 'bulk-1', rows: [] };
    });

    const broadcast: ServerMessage[] = [];
    const { deps } = makeDeps({ broadcastToAll: (msg) => broadcast.push(msg) });

    await new SweepHandler(deps).handleBulkRemove([
      { projectId: 'github.com/acme/a', worktreePath: '/wt/a', branch: 'feat/a', fingerprint: 'fp-a' },
    ]);

    expect(bulkRemoveProbablySafeCandidatesMock).toHaveBeenCalledTimes(1);
    expect(broadcast).toEqual([
      { type: 'workspaceBulkRemoveProgress', runId: 'bulk-1', index: 1, total: 1, projectId: 'github.com/acme/a', worktreePath: '/wt/a', status: 'done' },
    ]);
  });

  it('emits a terminal event (no work) for an empty bulk-remove selection so the client unsticks', async () => {
    const { deps, sent } = makeDeps();
    await new SweepHandler(deps).handleBulkRemove([]);
    expect(bulkRemoveProbablySafeCandidatesMock).not.toHaveBeenCalled();
    // A 0/0 terminal event clears the client's optimistic bulkRemoveRunning flag.
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'workspaceBulkRemoveProgress', index: 0, total: 0, status: 'skipped' });
  });

  it('emits a terminal event instead of running when workspace deps are missing', async () => {
    const { deps, sent } = makeDeps({ workspaceEnabled: false });
    await new SweepHandler(deps).handleBulkRemove([
      { projectId: 'github.com/acme/a', worktreePath: '/wt/a', branch: 'feat/a' },
    ]);
    expect(bulkRemoveProbablySafeCandidatesMock).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'workspaceBulkRemoveProgress', index: 0, total: 0, status: 'skipped' });
  });

  it('emits a terminal event when the bulk operation throws unexpectedly', async () => {
    bulkRemoveProbablySafeCandidatesMock.mockRejectedValueOnce(new Error('boom'));
    resolveWorkspaceContextMock.mockResolvedValue({ repoPath: '/resolved/repo' });
    const broadcast: ServerMessage[] = [];
    const { deps } = makeDeps({ broadcastToAll: (msg) => broadcast.push(msg) });
    await new SweepHandler(deps).handleBulkRemove([
      { projectId: 'github.com/acme/a', worktreePath: '/wt/a', branch: 'feat/a' },
    ]);
    expect(broadcast).toHaveLength(1);
    expect(broadcast[0]).toMatchObject({ type: 'workspaceBulkRemoveProgress', index: 0, total: 0, status: 'skipped' });
  });

  it('replies with an empty report request when the runId is unknown to the ledger', () => {
    const listBySweepRunId = vi.fn().mockReturnValue([]);
    const { deps, sent } = makeDeps({
      attemptRepository: { listBySweepRunId } as unknown as SweepHandlerDeps['attemptRepository'],
    });

    new SweepHandler(deps).handleReportRequest('nope');

    expect(sent).toEqual([{ type: 'workspaceSweepReport', runId: 'nope' }]);
  });

  it('broadcasts progress and completion to all clients when broadcaster is available', async () => {
    runCrossProjectSweepMock.mockImplementationOnce(async (depsArg: {
      onProgress?: (msg: unknown) => void;
    }) => {
      depsArg.onProgress?.({
        runId: 'run-2',
        startedAt: '2026-06-21T05:00:00.000Z',
        index: 1,
        total: 1,
        projectId: 'github.com/acme/a',
        status: 'running',
        counts: { done: 0, skipped: 0, failed: 0 },
      });
      return {
        kind: 'completed',
        result: {
          runId: 'run-2',
          startedAt: '2026-06-21T05:00:00.000Z',
          finishedAt: '2026-06-21T05:00:01.000Z',
          projects: [],
        },
      };
    });

    const sent: ServerMessage[] = [];
    const broadcast: ServerMessage[] = [];
    const { deps } = makeDeps({
      send: (msg) => sent.push(msg),
      broadcastToAll: (msg) => broadcast.push(msg),
    });

    await new SweepHandler(deps).handle();

    expect(sent).toHaveLength(0);
    expect(broadcast).toEqual([
      {
        type: 'workspaceSweepProgress',
        runId: 'run-2',
        startedAt: '2026-06-21T05:00:00.000Z',
        index: 1,
        total: 1,
        projectId: 'github.com/acme/a',
        status: 'running',
        counts: { done: 0, skipped: 0, failed: 0 },
      },
      {
        type: 'workspaceSweepComplete',
        runId: 'run-2',
        startedAt: '2026-06-21T05:00:00.000Z',
        finishedAt: '2026-06-21T05:00:01.000Z',
        projects: [],
      },
    ]);
  });
});
