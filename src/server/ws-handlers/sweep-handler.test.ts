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
