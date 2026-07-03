import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '../../shared/contracts/messages.js';
import { SweepHandler, type SweepHandlerDeps } from './sweep-handler.js';

const {
  runCrossProjectSweepMock,
  resolveWorkspaceContextMock,
} = vi.hoisted(() => ({
  runCrossProjectSweepMock: vi.fn(),
  resolveWorkspaceContextMock: vi.fn(),
}));

vi.mock('../use-cases/cross-project-cleanup-sweep.js', () => ({
  runCrossProjectSweep: runCrossProjectSweepMock,
}));

vi.mock('../use-cases/workspace-context.js', () => ({
  resolveWorkspaceContext: resolveWorkspaceContextMock,
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
