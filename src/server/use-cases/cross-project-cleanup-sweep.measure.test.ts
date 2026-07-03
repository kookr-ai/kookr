/**
 * Integration coverage for the per-project measurement seam of the sweep:
 * `measureProject` inside `runCrossProjectSweep`. The pure builder and the
 * adapters are tested elsewhere; here we drive the real loop with the
 * collaborators (footprint/ignored-scan/detail-query) mocked to non-degenerate
 * values, so the footprint→row wiring, the probably-safe hydration gate, and
 * the "measurement hiccup never demotes a completed removal" invariant are
 * exercised end to end — not inferred through injected maps.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCrossProjectSweep, type CrossProjectSweepDeps } from './cross-project-cleanup-sweep.js';
import type { ProjectConfigStore, ProjectConfig } from '../../core/project-config-store.js';
import type { TaskStore } from '../../core/tasks.js';
import type { WorkspaceCleanupDeps } from './workspace-cleanup-service.js';
import type { CleanupCandidateAssessment } from '../../core/workspace-types.js';
import { WorkspaceAttemptRepository } from '../../core/workspace-attempt-repository.js';

const { cleanupMock, footprintMock, ignoredMock, hydrateMock } = vi.hoisted(() => ({
  cleanupMock: { impl: vi.fn() },
  footprintMock: vi.fn(),
  ignoredMock: vi.fn(),
  hydrateMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, { stdout: '', stderr: '' });
  }),
}));
vi.mock('./workspace-cleanup-service.js', async () => {
  const actual = await vi.importActual<typeof import('./workspace-cleanup-service.js')>('./workspace-cleanup-service.js');
  return { ...actual, cleanupSafeWorkspaceCandidates: (...args: unknown[]) => cleanupMock.impl(...args) };
});
vi.mock('../../adapters/worktree-footprint.js', () => ({
  measureWorktreeFootprint: (...args: unknown[]) => footprintMock(...args),
}));
vi.mock('../../adapters/ignored-scan.js', () => ({
  scanIgnored: (...args: unknown[]) => ignoredMock(...args),
}));
vi.mock('./workspace-cleanup-detail-query.js', () => ({
  hydrateCleanupCandidateDetail: (...args: unknown[]) => hydrateMock(...args),
}));

function makeConfigStore(configs: ProjectConfig[]): ProjectConfigStore {
  return {
    getAllConfigs: () => configs,
    getConfig: (p: string) => configs.find((c) => c.project === p),
    setConfig: () => { throw new Error('not used'); },
    removeConfig: () => false,
    load: async () => {},
    save: async () => {},
  } as unknown as ProjectConfigStore;
}

function makeCleanupDeps(): WorkspaceCleanupDeps {
  return {
    policyResolver: {} as WorkspaceCleanupDeps['policyResolver'],
    leaseService: {} as WorkspaceCleanupDeps['leaseService'],
    attemptRepository: new WorkspaceAttemptRepository(),
  };
}

function staleUniqueCommits(worktreePath: string): CleanupCandidateAssessment {
  return {
    projectId: 'github.com/acme/a',
    worktreePath,
    branch: 'feat/keep',
    classification: 'unique_commits',
    reasonCode: 'has_unique_commits',
    source: 'cleanup_inspector',
    observedAt: new Date(0).toISOString(),
    recoveryGuidance: 'x',
    capabilities: {
      canSafeRemove: false, canRemovePathKeepBranch: true, canReviewedDiscard: true,
      requiresDirtyRecovery: false, defaultActionLabel: 'x', riskSummary: 'x',
    },
  };
}

describe('runCrossProjectSweep — measureProject integration', () => {
  let lockDir: string;
  let deps: CrossProjectSweepDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    lockDir = mkdtempSync(join(tmpdir(), 'sweep-measure-'));
    deps = {
      cleanupDeps: makeCleanupDeps(),
      projectConfigStore: makeConfigStore([{ project: 'github.com/acme/a' }]),
      taskStore: { getAllTasks: () => [] } as unknown as TaskStore,
      resolveRepoPath: async () => '/repos/a',
      lockDir,
      perProjectTimeoutMs: 500,
      // Fixed "now" ~ 2026; the stale mtime below is 30 days earlier.
      now: () => new Date('2026-07-03T00:00:00.000Z'),
    };
    footprintMock.mockResolvedValue({ footprintBytes: 4096, lastTouchedMs: Date.parse('2026-06-01T00:00:00.000Z') });
    ignoredMock.mockResolvedValue({ hasSensitiveIgnored: true, sample: ['.env'] });
    hydrateMock.mockResolvedValue({ fingerprint: 'fp-abc' });
  });

  afterEach(() => {
    rmSync(lockDir, { recursive: true, force: true });
  });

  it('drives footprint + probably-safe hydration into a probably_safe row', async () => {
    cleanupMock.impl.mockResolvedValue({
      summaries: [],
      safeCandidates: [],
      nonRemoved: [staleUniqueCommits('/wt/keep')],
    });

    const outcome = await runCrossProjectSweep(deps);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;

    const row = outcome.result.report.rows.find((r) => r.worktreePath === '/wt/keep');
    expect(row?.bucket).toBe('probably_safe');
    expect(row?.footprintBytes).toBe(4096);
    expect(row?.fingerprint).toBe('fp-abc');
    expect(row?.hasSensitiveIgnored).toBe(true);
    expect(row?.ignoredSample).toEqual(['.env']);
    // Hydration + ignored-scan run only for the probably-safe candidate.
    expect(hydrateMock).toHaveBeenCalledTimes(1);
    expect(ignoredMock).toHaveBeenCalledTimes(1);
  });

  it('does not hydrate a recently-touched unique_commits candidate (stays needs_call)', async () => {
    footprintMock.mockResolvedValue({ footprintBytes: 512, lastTouchedMs: Date.parse('2026-07-02T00:00:00.000Z') });
    cleanupMock.impl.mockResolvedValue({
      summaries: [],
      safeCandidates: [],
      nonRemoved: [staleUniqueCommits('/wt/recent')],
    });

    const outcome = await runCrossProjectSweep(deps);
    if (outcome.kind !== 'completed') throw new Error('expected completed');

    const row = outcome.result.report.rows.find((r) => r.worktreePath === '/wt/recent');
    expect(row?.bucket).toBe('needs_call');
    expect(row?.footprintBytes).toBe(512);
    expect(hydrateMock).not.toHaveBeenCalled();
    expect(ignoredMock).not.toHaveBeenCalled();
  });

  it('a measurement hiccup never demotes a completed removal to a failure', async () => {
    footprintMock.mockRejectedValue(new Error('du blew up'));
    cleanupMock.impl.mockResolvedValue({
      summaries: [{ branch: 'feat/done', disposition: 'completed', pathRemoved: true, branchRemoved: true }],
      safeCandidates: [],
      nonRemoved: [staleUniqueCommits('/wt/keep')],
    });

    const outcome = await runCrossProjectSweep(deps);
    if (outcome.kind !== 'completed') throw new Error('expected completed');

    const project = outcome.result.projects[0];
    expect(project?.kind).toBe('ok');
    if (project?.kind === 'ok') expect(project.summaries).toHaveLength(1);
  });
});
