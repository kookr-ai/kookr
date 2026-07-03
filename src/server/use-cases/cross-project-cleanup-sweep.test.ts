import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  enumerateSweepProjects,
  isSweepInProgress,
  runCrossProjectSweep,
  type CrossProjectSweepDeps,
  type ProcessProbe,
  type SweepProgressEvent,
} from './cross-project-cleanup-sweep.js';
import { canSweepRemove } from '../../core/workspace-cleanup-policy.js';
import type { ProjectConfigStore, ProjectConfig } from '../../core/project-config-store.js';
import type { TaskStore } from '../../core/tasks.js';
import type { WorkspaceCleanupDeps, WorkspaceBulkCleanupInput } from './workspace-cleanup-service.js';
import { WorkspaceAttemptRepository } from '../../core/workspace-attempt-repository.js';

// We exercise cleanupSafeWorkspaceCandidates via a stub rather than real git.
const { cleanupMock, execFileMock } = vi.hoisted(() => ({
  cleanupMock: { impl: vi.fn() },
  execFileMock: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
    cb(null, { stdout: '', stderr: '' });
  }),
}));
vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));
vi.mock('./workspace-cleanup-service.js', async () => {
  const actual = await vi.importActual<typeof import('./workspace-cleanup-service.js')>('./workspace-cleanup-service.js');
  return {
    ...actual,
    cleanupSafeWorkspaceCandidates: (...args: unknown[]) => cleanupMock.impl(...args),
  };
});

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

function makeTaskStore(projectIds: string[]): TaskStore {
  return {
    getAllTasks: () => projectIds.map((projectId, idx) => ({
      id: `task-${idx}`,
      projectId,
      sessions: [],
      cwd: `/some/path/${idx}`,
    })),
  } as unknown as TaskStore;
}

function makeCleanupDeps(): WorkspaceCleanupDeps {
  return {
    policyResolver: {} as unknown as WorkspaceCleanupDeps['policyResolver'],
    leaseService: {} as unknown as WorkspaceCleanupDeps['leaseService'],
    attemptRepository: new WorkspaceAttemptRepository(),
  };
}

describe('enumerateSweepProjects', () => {
  it('unions config-store and task-store project ids, deduped, sorted', () => {
    const configStore = makeConfigStore([
      { project: 'github.com/b/b' },
      { project: 'github.com/a/a' },
    ]);
    const taskStore = makeTaskStore(['github.com/a/a', 'github.com/c/c']);

    const result = enumerateSweepProjects(configStore, taskStore);
    expect(result).toEqual(['github.com/a/a', 'github.com/b/b', 'github.com/c/c']);
  });

  it('returns empty array when no projects are known', () => {
    const configStore = makeConfigStore([]);
    const taskStore = makeTaskStore([]);
    expect(enumerateSweepProjects(configStore, taskStore)).toEqual([]);
  });

  it('ignores tasks with missing or non-string projectId', () => {
    const configStore = makeConfigStore([{ project: 'github.com/a/a' }]);
    const taskStore = {
      getAllTasks: () => [
        { id: 't1', projectId: undefined, sessions: [], cwd: '/x' },
        { id: 't2', projectId: 'github.com/b/b', sessions: [], cwd: '/y' },
      ],
    } as unknown as TaskStore;
    expect(enumerateSweepProjects(configStore, taskStore)).toEqual([
      'github.com/a/a',
      'github.com/b/b',
    ]);
  });
});

describe('runCrossProjectSweep', () => {
  let lockDir: string;
  let deps: CrossProjectSweepDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    lockDir = mkdtempSync(join(tmpdir(), 'sweep-test-'));

    deps = {
      cleanupDeps: makeCleanupDeps(),
      projectConfigStore: makeConfigStore([
        { project: 'github.com/a/a' },
        { project: 'github.com/b/b' },
      ]),
      taskStore: makeTaskStore([]),
      resolveRepoPath: async (projectId) => `/repos/${projectId}`,
      lockDir,
      perProjectTimeoutMs: 200,
    };

    cleanupMock.impl.mockImplementation(async (_deps: unknown, input: WorkspaceBulkCleanupInput) => ({
      summaries: [{
        branch: `feat/${input.projectId}`,
        disposition: 'completed',
        pathRemoved: true,
        branchRemoved: true,
      }],
      safeCandidates: [],
      nonRemoved: [],
    }));
  });

  afterEach(() => {
    rmSync(lockDir, { recursive: true, force: true });
  });

  it('returns ok for each project when delegate succeeds', async () => {
    const outcome = await runCrossProjectSweep(deps);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;

    expect(outcome.result.projects).toHaveLength(2);
    for (const project of outcome.result.projects) {
      expect(project.kind).toBe('ok');
    }
    expect(outcome.result.runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('assembles a disk-aware report, bucketing non-removed candidates', async () => {
    cleanupMock.impl.mockImplementation(async (_deps: unknown, input: WorkspaceBulkCleanupInput) => ({
      summaries: [],
      safeCandidates: [],
      nonRemoved: [
        {
          projectId: input.projectId,
          worktreePath: `/nonexistent/${input.projectId}/dirty`,
          branch: 'dirty-br',
          classification: 'dirty' as const,
          reasonCode: 'uncommitted_changes',
          source: 'cleanup_inspector',
          observedAt: new Date().toISOString(),
          recoveryGuidance: 'x',
          capabilities: {
            canSafeRemove: false, canRemovePathKeepBranch: false, canReviewedDiscard: true,
            requiresDirtyRecovery: true, defaultActionLabel: 'x', riskSummary: 'x',
          },
        },
        {
          projectId: input.projectId,
          worktreePath: `/nonexistent/${input.projectId}/busy`,
          branch: 'busy-br',
          classification: 'busy' as const,
          reasonCode: 'active_lease',
          source: 'cleanup_inspector',
          observedAt: new Date().toISOString(),
          recoveryGuidance: 'x',
          capabilities: {
            canSafeRemove: false, canRemovePathKeepBranch: false, canReviewedDiscard: false,
            requiresDirtyRecovery: false, defaultActionLabel: 'x', riskSummary: 'x',
          },
        },
      ],
    }));

    const outcome = await runCrossProjectSweep(deps);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;

    const report = outcome.result.report;
    expect(report.runId).toBe(outcome.result.runId);
    // two projects × (1 dirty + 1 busy)
    expect(report.buckets.needs_call.count).toBe(2);
    expect(report.buckets.blocked.count).toBe(2);
    // dirty worktree paths don't exist → footprint measured as unknown, row still present
    const dirtyRow = report.rows.find((r) => r.bucket === 'needs_call');
    expect(dirtyRow?.footprintBytes).toBeNull();
  });

  it('emits live progress at each project boundary', async () => {
    const progress: SweepProgressEvent[] = [];
    deps.onProgress = (event) => {
      progress.push(event);
    };

    const outcome = await runCrossProjectSweep(deps);
    expect(outcome.kind).toBe('completed');

    expect(progress).toHaveLength(4);
    expect(progress.map((event) => ({
      index: event.index,
      total: event.total,
      projectId: event.projectId,
      status: event.status,
      counts: event.counts,
      hasResult: Boolean(event.result),
    }))).toEqual([
      { index: 1, total: 2, projectId: 'github.com/a/a', status: 'running', counts: { done: 0, skipped: 0, failed: 0 }, hasResult: false },
      { index: 1, total: 2, projectId: 'github.com/a/a', status: 'done', counts: { done: 1, skipped: 0, failed: 0 }, hasResult: true },
      { index: 2, total: 2, projectId: 'github.com/b/b', status: 'running', counts: { done: 1, skipped: 0, failed: 0 }, hasResult: false },
      { index: 2, total: 2, projectId: 'github.com/b/b', status: 'done', counts: { done: 2, skipped: 0, failed: 0 }, hasResult: true },
    ]);
  });

  it('forwards the canSweepRemove filter and sweepRunId to the delegate', async () => {
    await runCrossProjectSweep(deps);
    const calls = cleanupMock.impl.mock.calls;
    expect(calls).toHaveLength(2);
    for (const [, input] of calls) {
      const typed = input as WorkspaceBulkCleanupInput;
      // The filter is the canSweepRemove function itself — reference equality
      // is the strongest possible assertion that the sweep hasn't silently
      // swapped it for a looser filter.
      expect(typed.classificationFilter).toBe(canSweepRemove);
      // Functional probe: confirms the filter accepts both strict merges and
      // patch-equivalent squash merges, which is the sweep's core behavior.
      expect(typed.classificationFilter!({
        worktreePath: '/x', branch: 'b', projectId: 'p',
        classification: 'patch_equivalent', reasonCode: 'no_unique_patches',
        observedAt: new Date().toISOString(),
      })).toBe(true);
      expect(typed.classificationFilter!({
        worktreePath: '/x', branch: 'b', projectId: 'p',
        classification: 'merged', reasonCode: 'ancestor_of_baseline',
        observedAt: new Date().toISOString(),
      })).toBe(true);
      expect(typed.sweepRunId).toBeTruthy();
      expect(typed.signal).toBeDefined();
    }
    // All calls share the same runId.
    const runIds = new Set(calls.map(([, input]) => (input as WorkspaceBulkCleanupInput).sweepRunId));
    expect(runIds.size).toBe(1);
  });

  it('refreshes origin refs before classifying cleanup candidates', async () => {
    deps.projectConfigStore = makeConfigStore([{ project: 'github.com/a/a' }]);

    await runCrossProjectSweep(deps);

    const fetchCallIndex = execFileMock.mock.calls.findIndex(([, args]) => (
      Array.isArray(args)
      && args.join(' ') === '-C /repos/github.com/a/a fetch origin --prune'
    ));
    expect(fetchCallIndex).toBeGreaterThanOrEqual(0);
    const fetchOrder = execFileMock.mock.invocationCallOrder[fetchCallIndex];
    const cleanupOrder = cleanupMock.impl.mock.invocationCallOrder[0];
    expect(fetchOrder).toBeLessThan(cleanupOrder);
  });

  it('records an audit attempt even when a sweep removes zero worktrees', async () => {
    deps.projectConfigStore = makeConfigStore([{ project: 'github.com/a/a' }]);
    cleanupMock.impl.mockResolvedValueOnce({ summaries: [], safeCandidates: [], nonRemoved: [] });

    await runCrossProjectSweep(deps);

    const attempts = deps.cleanupDeps.attemptRepository.listByProject('github.com/a/a');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      type: 'cleanup',
      source: 'cross_project_sweep',
      reasonCode: 'cross_project_sweep',
      status: 'passed',
      disposition: 'passed',
    });
    expect(attempts[0].evidenceSummary).toContain('removed 0 worktree(s)');
  });

  it('skips projects whose repoPath cannot be resolved', async () => {
    deps.resolveRepoPath = async (projectId) => {
      if (projectId === 'github.com/a/a') throw new Error('no root');
      return `/repos/${projectId}`;
    };

    const outcome = await runCrossProjectSweep(deps);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;

    const a = outcome.result.projects.find((p) => p.projectId === 'github.com/a/a')!;
    const b = outcome.result.projects.find((p) => p.projectId === 'github.com/b/b')!;
    expect(a.kind).toBe('skipped');
    if (a.kind === 'skipped') expect(a.reason).toBe('repo_path_unresolved');
    expect(b.kind).toBe('ok');
  });

  it('isolates per-project failures', async () => {
    cleanupMock.impl.mockImplementation(async (_deps: unknown, input: WorkspaceBulkCleanupInput) => {
      if (input.projectId === 'github.com/a/a') {
        throw new Error('delegate exploded');
      }
      return { summaries: [], safeCandidates: [], nonRemoved: [] };
    });

    const outcome = await runCrossProjectSweep(deps);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;

    const a = outcome.result.projects.find((p) => p.projectId === 'github.com/a/a')!;
    const b = outcome.result.projects.find((p) => p.projectId === 'github.com/b/b')!;
    expect(a.kind).toBe('failed');
    if (a.kind === 'failed') {
      expect(a.code).toBe('error');
      expect(a.message).toContain('delegate exploded');
    }
    expect(b.kind).toBe('ok');
    if (b.kind === 'ok') expect(b.summaries).toEqual([]);
  });

  it('records timeout (and a not-analyzed banner) when a project exceeds perProjectTimeoutMs', async () => {
    // Mirror the REAL delegate: classification does not observe the abort
    // signal, so the promise simply never settles on a hang. The rejecting
    // timeout race — not a delegate rejection — is what must trigger timeout.
    cleanupMock.impl.mockImplementation(() => new Promise(() => {
      // never resolves, never rejects
    }));

    deps.perProjectTimeoutMs = 50;
    const outcome = await runCrossProjectSweep(deps);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;

    for (const project of outcome.result.projects) {
      expect(project.kind).toBe('failed');
      if (project.kind === 'failed') {
        expect(project.code).toBe('timeout');
      }
    }
    // The disk-aware report surfaces a loud "not analyzed" banner per project.
    expect(outcome.result.report.notAnalyzed).toHaveLength(outcome.result.projects.length);
    for (const banner of outcome.result.report.notAnalyzed) {
      expect(banner.code).toBe('timeout');
    }
  });

  it('returns busy when the lock file belongs to a live foreign PID', async () => {
    // Use a PID that is guaranteed to exist — our own.
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'sweep.lock'),
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );

    const outcome = await runCrossProjectSweep(deps);
    expect(outcome.kind).toBe('busy');
    if (outcome.kind === 'busy') {
      expect(outcome.holderPid).toBe(process.pid);
    }
    // Lock file should still exist (we did not reclaim it).
    expect(existsSync(join(lockDir, 'sweep.lock'))).toBe(true);
  });

  it('does NOT reclaim a live-PID lock even when mtime exceeds TTL', async () => {
    // Regression guard: the initial implementation reclaimed the lock when
    // mtime was stale regardless of PID liveness, which allows two concurrent
    // sweeps during a legitimately slow run. PID must be authoritative.
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, 'sweep.lock');
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    // Force mtime far in the past so a naive TTL check would trip.
    const ancient = Date.now() / 1000 - 3600; // 1 hour ago
    require('node:fs').utimesSync(lockPath, ancient, ancient);

    const outcome = await runCrossProjectSweep(deps);
    expect(outcome.kind).toBe('busy');
    expect(existsSync(lockPath)).toBe(true);
  });

  it('reclaims a lock whose PID is dead', async () => {
    // PID 1 is init — we can't kill it, so use an obviously-invalid large PID.
    // Use 2^31 - 1 which should never be a live process.
    const deadPid = 2_147_483_646;
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'sweep.lock'),
      JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString() }),
    );

    const outcome = await runCrossProjectSweep(deps);
    expect(outcome.kind).toBe('completed');
    if (outcome.kind === 'completed') {
      expect(outcome.result.projects).toHaveLength(2);
      // New lock file was written with our PID and released at end of sweep.
      expect(existsSync(join(lockDir, 'sweep.lock'))).toBe(false);
    }
  });

  it('creates the lock directory if missing', async () => {
    const missingDir = join(lockDir, 'nested', 'deeper');
    deps.lockDir = missingDir;
    expect(existsSync(missingDir)).toBe(false);

    const outcome = await runCrossProjectSweep(deps);
    expect(outcome.kind).toBe('completed');
    expect(existsSync(missingDir)).toBe(true);
  });

  it('releases the lock on completion', async () => {
    await runCrossProjectSweep(deps);
    expect(existsSync(join(lockDir, 'sweep.lock'))).toBe(false);
  });

  it('writes pid + startedAt to the lock file during the sweep', async () => {
    let observedLock: { pid: number; startedAt: string } | undefined;
    cleanupMock.impl.mockImplementation(async () => {
      const raw = readFileSync(join(lockDir, 'sweep.lock'), 'utf-8');
      observedLock = JSON.parse(raw);
      return { summaries: [], safeCandidates: [], nonRemoved: [] };
    });
    await runCrossProjectSweep(deps);
    expect(observedLock?.pid).toBe(process.pid);
    expect(observedLock?.startedAt).toMatch(/T.*Z$/);
  });

  // ---- PID-recycle guard (#1287) ----

  const RECYCLED_PID = 4242; // arbitrary — the probe controls liveness/start-time.

  function writeLock(startedAt: string): void {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'sweep.lock'),
      JSON.stringify({ pid: RECYCLED_PID, startedAt }),
    );
  }

  it('does NOT reclaim a live PID that started before the lock (genuine holder)', async () => {
    const lockStart = new Date('2026-07-04T12:00:00.000Z');
    writeLock(lockStart.toISOString());
    // Holder process started a minute BEFORE it wrote the lock — the original.
    deps.processProbe = {
      isAlive: () => true,
      startTimeMs: () => lockStart.getTime() - 60_000,
    };

    const outcome = await runCrossProjectSweep(deps);
    expect(outcome.kind).toBe('busy');
    if (outcome.kind === 'busy') expect(outcome.holderPid).toBe(RECYCLED_PID);
    expect(existsSync(join(lockDir, 'sweep.lock'))).toBe(true);
  });

  it('reclaims a lock whose live PID started after the lock (recycled PID)', async () => {
    const lockStart = new Date('2026-07-04T12:00:00.000Z');
    writeLock(lockStart.toISOString());
    // A different process reused the dead holder's PID — it started well AFTER.
    deps.processProbe = {
      isAlive: () => true,
      startTimeMs: () => lockStart.getTime() + 5 * 60_000,
    };

    const outcome = await runCrossProjectSweep(deps);
    expect(outcome.kind).toBe('completed');
    // The stale lock was reclaimed, the sweep ran, and released its own lock.
    expect(existsSync(join(lockDir, 'sweep.lock'))).toBe(false);
  });

  it('treats a same-second start/lock boundary as held (never double-sweep)', async () => {
    const lockStart = new Date('2026-07-04T12:00:00.000Z');
    writeLock(lockStart.toISOString());
    // Within the coarse start-time resolution — must resolve to "held".
    deps.processProbe = {
      isAlive: () => true,
      startTimeMs: () => lockStart.getTime() + 500,
    };

    const outcome = await runCrossProjectSweep(deps);
    expect(outcome.kind).toBe('busy');
    expect(existsSync(join(lockDir, 'sweep.lock'))).toBe(true);
  });

  it('HOLDS a live PID with unreadable start time even past the mtime TTL', async () => {
    // A live PID is authoritative: an unreadable start time must NOT let the
    // mtime TTL reclaim it, or a legitimately slow sweep could be double-run.
    const lockPath = join(lockDir, 'sweep.lock');
    writeLock(new Date('2026-07-04T12:00:00.000Z').toISOString());
    const ancient = Date.now() / 1000 - 3600; // 1 hour ago — well past the TTL.
    require('node:fs').utimesSync(lockPath, ancient, ancient);
    deps.processProbe = { isAlive: () => true, startTimeMs: () => null };

    const outcome = await runCrossProjectSweep(deps);
    expect(outcome.kind).toBe('busy');
    expect(existsSync(lockPath)).toBe(true);
  });

  it('reclaims a MALFORMED lock (no pid) once its mtime exceeds the TTL', async () => {
    // The mtime TTL is the last-resort path for locks with no readable pid.
    const lockPath = join(lockDir, 'sweep.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ startedAt: new Date().toISOString() }));
    const ancient = Date.now() / 1000 - 3600;
    require('node:fs').utimesSync(lockPath, ancient, ancient);

    const outcome = await runCrossProjectSweep(deps);
    expect(outcome.kind).toBe('completed');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('holds a MALFORMED lock (no pid) whose mtime is within the TTL', async () => {
    const lockPath = join(lockDir, 'sweep.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ startedAt: new Date().toISOString() }));

    const outcome = await runCrossProjectSweep(deps);
    expect(outcome.kind).toBe('busy');
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe('isSweepInProgress PID-recycle guard', () => {
  let lockDir: string;

  beforeEach(() => {
    lockDir = mkdtempSync(join(tmpdir(), 'sweep-inprogress-'));
  });
  afterEach(() => {
    rmSync(lockDir, { recursive: true, force: true });
  });

  function writeLock(pid: number, startedAt: string): void {
    writeFileSync(join(lockDir, 'sweep.lock'), JSON.stringify({ pid, startedAt }));
  }

  it('reports not-running when the live PID is a recycled one', () => {
    const lockStart = new Date('2026-07-04T12:00:00.000Z');
    writeLock(4242, lockStart.toISOString());
    const probe: ProcessProbe = {
      isAlive: () => true,
      startTimeMs: () => lockStart.getTime() + 5 * 60_000,
    };
    expect(isSweepInProgress(lockDir, probe)).toBe(false);
  });

  it('reports running for the genuine live holder', () => {
    const lockStart = new Date('2026-07-04T12:00:00.000Z');
    writeLock(4242, lockStart.toISOString());
    const probe: ProcessProbe = {
      isAlive: () => true,
      startTimeMs: () => lockStart.getTime() - 60_000,
    };
    expect(isSweepInProgress(lockDir, probe)).toBe(true);
  });

  it('reports running when the start time is unknown (conservative)', () => {
    writeLock(4242, new Date().toISOString());
    const probe: ProcessProbe = { isAlive: () => true, startTimeMs: () => null };
    expect(isSweepInProgress(lockDir, probe)).toBe(true);
  });

  it('reports not-running when the PID is dead', () => {
    writeLock(4242, new Date().toISOString());
    const probe: ProcessProbe = { isAlive: () => false, startTimeMs: () => null };
    expect(isSweepInProgress(lockDir, probe)).toBe(false);
  });
});
