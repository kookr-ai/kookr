import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Task } from '../core/tasks.js';
import { aSession, aTask } from '../core/__fixtures__/task-builders.js';
import {
  createMergedPrByBranchProbe,
  pickMergedPrBranchProbeTarget,
  selectMergedPrForBranch,
} from './merged-pr-by-branch-probe.js';

const CREATED = new Date('2026-11-10T07:34:18.008Z');

/** Shape of task 02107c4f (issue #3578): own worktree branch, kookr project. */
function makeTask(overrides: Partial<Task> = {}): Task {
  return aTask({
    id: 'task-1',
    status: 'inProgress',
    projectId: 'github.com/kookr-ai/kookr',
    createdAt: CREATED,
    sessions: [aSession({
      tmuxSession: 'kookr-a',
      gitBranch: 'fix/terminal-snapshot-seed-3564',
      gitIsWorktree: true,
    })],
    ...overrides,
  });
}

describe('pickMergedPrBranchProbeTarget (issue #3578)', () => {
  it('uses the project repo and the latest session branch', () => {
    const task = makeTask({
      sessions: [
        aSession({ tmuxSession: 'a', gitBranch: 'old-branch', gitIsWorktree: true }),
        aSession({ tmuxSession: 'b', gitBranch: 'fix/terminal-snapshot-seed-3564', gitIsWorktree: true }),
      ],
    });
    expect(pickMergedPrBranchProbeTarget(task)).toEqual({
      owner: 'kookr-ai',
      repo: 'kookr',
      branch: 'fix/terminal-snapshot-seed-3564',
      notBeforeMs: CREATED.getTime(),
    });
  });

  it('accepts an ISO-string createdAt from a persisted record', () => {
    const task = makeTask({ createdAt: CREATED.toISOString() as unknown as Date });
    expect(pickMergedPrBranchProbeTarget(task)?.notBeforeMs).toBe(CREATED.getTime());
  });

  // 16dec794 ran in the repo's main checkout: a PR "from main" says nothing
  // about which task delivered it.
  it.each(['main', 'master', 'MAIN', 'HEAD'])('refuses default branch %s', (branch) => {
    expect(pickMergedPrBranchProbeTarget(makeTask({
      sessions: [aSession({ tmuxSession: 'a', gitBranch: branch, gitIsWorktree: true })],
    }))).toBeNull();
  });

  // #3797: with `.kookr/delivery-gate.json` naming `staging`, pull requests
  // merge into staging; a session on staging is not a task's own branch.
  it('refuses the configured integration branch, and only when one is configured', () => {
    const onStaging = makeTask({
      sessions: [aSession({ tmuxSession: 'a', gitBranch: 'staging', gitIsWorktree: true })],
    });
    expect(pickMergedPrBranchProbeTarget(onStaging, 'staging')).toBeNull();
    // No config: `staging` is an ordinary branch name, as before.
    expect(pickMergedPrBranchProbeTarget(onStaging)?.branch).toBe('staging');
    expect(pickMergedPrBranchProbeTarget(onStaging, null)?.branch).toBe('staging');
    // A configured branch never hides a different task branch.
    expect(pickMergedPrBranchProbeTarget(makeTask(), 'staging')?.branch).toBe('fix/terminal-snapshot-seed-3564');
  });

  // A session parked in the shared main checkout reports whatever branch that
  // checkout is on — possibly another task's feature branch.
  it.each([false, undefined])('refuses a session outside a linked worktree (gitIsWorktree=%s)', (gitIsWorktree) => {
    expect(pickMergedPrBranchProbeTarget(makeTask({
      sessions: [aSession({ tmuxSession: 'a', gitBranch: 'feat-issue-2765-task-archive', gitIsWorktree })],
    }))).toBeNull();
  });

  it('refuses when the latest session is outside a worktree, even if an earlier one was inside', () => {
    expect(pickMergedPrBranchProbeTarget(makeTask({
      sessions: [
        aSession({ tmuxSession: 'a', gitBranch: 'fix/mine', gitIsWorktree: true }),
        aSession({ tmuxSession: 'b', gitBranch: 'someone-elses-branch', gitIsWorktree: false }),
      ],
    }))).toBeNull();
  });

  it('does not fall back to an older session branch when the latest session has none', () => {
    expect(pickMergedPrBranchProbeTarget(makeTask({
      sessions: [
        aSession({ tmuxSession: 'a', gitBranch: 'fix/old', gitIsWorktree: true }),
        aSession({ tmuxSession: 'b', gitIsWorktree: true }),
      ],
    }))).toBeNull();
  });

  // Without this guard notBeforeMs would be NaN and every PR on the branch
  // would pass the opened-after check.
  it('refuses a task whose createdAt cannot be parsed', () => {
    expect(pickMergedPrBranchProbeTarget(makeTask({ createdAt: 'garbage' as unknown as Date }))).toBeNull();
    expect(pickMergedPrBranchProbeTarget(makeTask({ createdAt: new Date(Number.NaN) }))).toBeNull();
  });

  it('refuses a task with no session branch', () => {
    expect(pickMergedPrBranchProbeTarget(makeTask({
      sessions: [aSession({ tmuxSession: 'a' })],
    }))).toBeNull();
  });

  it.each([undefined, 'local/some-dir', 'gitlab.com/o/r', 'github.com/o'])(
    'refuses a non-GitHub project id %s',
    (projectId) => {
      expect(pickMergedPrBranchProbeTarget(makeTask({ projectId }))).toBeNull();
    },
  );
});

describe('selectMergedPrForBranch (issue #3578)', () => {
  const target = {
    owner: 'kookr-ai',
    repo: 'kookr',
    branch: 'fix/x',
    notBeforeMs: CREATED.getTime(),
  };

  it('returns the PR merged from the exact branch after the task started', () => {
    expect(selectMergedPrForBranch([
      { number: 3575, url: 'https://github.com/kookr-ai/kookr/pull/3575', createdAt: '2026-11-10T08:37:39Z', mergedAt: '2026-11-10T08:48:33Z', headRefName: 'fix/x', isCrossRepository: false },
    ], target)).toEqual({
      prNumber: 3575,
      prUrl: 'https://github.com/kookr-ai/kookr/pull/3575',
      owner: 'kookr-ai',
      repo: 'kookr',
    });
  });

  it('ignores a PR merged before the task was created (not this task\'s delivery)', () => {
    expect(selectMergedPrForBranch([
      { number: 10, createdAt: '2026-11-09T07:00:00Z', mergedAt: '2026-11-09T08:00:00Z', headRefName: 'fix/x', isCrossRepository: false },
    ], target)).toBeNull();
  });

  it('ignores a PR opened before the task started even if it merged afterwards', () => {
    expect(selectMergedPrForBranch([
      { number: 14, createdAt: '2026-11-10T07:00:00Z', mergedAt: '2026-11-10T09:00:00Z', headRefName: 'fix/x', isCrossRepository: false },
    ], target)).toBeNull();
  });

  it('ignores a different head branch and malformed rows', () => {
    expect(selectMergedPrForBranch([
      { number: 11, createdAt: '2026-11-10T08:00:00Z', mergedAt: '2026-11-10T09:00:00Z', headRefName: 'fix/x-other', isCrossRepository: false },
      { number: 'x', createdAt: '2026-11-10T08:00:00Z', mergedAt: '2026-11-10T09:00:00Z', headRefName: 'fix/x', isCrossRepository: false },
      { number: 12, createdAt: '2026-11-10T08:00:00Z', mergedAt: null, headRefName: 'fix/x', isCrossRepository: false },
      { number: 13, createdAt: '2026-11-10T08:00:00Z', mergedAt: 'not-a-date', headRefName: 'fix/x', isCrossRepository: false },
      { number: 15, mergedAt: '2026-11-10T09:00:00Z', headRefName: 'fix/x', isCrossRepository: false },
    ], target)).toBeNull();
  });

  it('ignores a fork PR that reuses the branch name, and rows with unknown origin', () => {
    expect(selectMergedPrForBranch([
      { number: 40, createdAt: '2026-11-10T08:00:00Z', mergedAt: '2026-11-10T09:00:00Z', headRefName: 'fix/x', isCrossRepository: true },
      { number: 41, createdAt: '2026-11-10T08:00:00Z', mergedAt: '2026-11-10T09:00:00Z', headRefName: 'fix/x' },
    ], target)).toBeNull();
  });

  it('picks the earliest qualifying merge regardless of row order', () => {
    const later = { number: 21, createdAt: '2026-11-10T08:00:00Z', mergedAt: '2026-11-10T10:00:00Z', headRefName: 'fix/x', isCrossRepository: false };
    const earlier = { number: 20, createdAt: '2026-11-10T08:00:00Z', mergedAt: '2026-11-10T09:00:00Z', headRefName: 'fix/x', isCrossRepository: false };
    expect(selectMergedPrForBranch([later, earlier], target)?.prNumber).toBe(20);
    expect(selectMergedPrForBranch([earlier, later], target)?.prNumber).toBe(20);
  });

  it('accepts a PR opened at exactly the task creation instant', () => {
    expect(selectMergedPrForBranch([
      { number: 30, createdAt: CREATED.toISOString(), mergedAt: '2026-11-10T09:00:00Z', headRefName: 'fix/x', isCrossRepository: false },
    ], target)?.prNumber).toBe(30);
  });
});

describe('selectMergedPrForBranch base branch (issue #4077)', () => {
  const target = { owner: 'kookr-ai', repo: 'kookr', branch: 'fix/x', notBeforeMs: CREATED.getTime() };
  const row = (number: number, baseRefName?: string) => ({
    number,
    createdAt: '2026-11-10T08:00:00Z',
    mergedAt: '2026-11-10T09:00:00Z',
    headRefName: 'fix/x',
    isCrossRepository: false,
    ...(baseRefName !== undefined ? { baseRefName } : {}),
  });

  it('ignores a PR merged into a feature branch when the delivery branches are known', () => {
    expect(selectMergedPrForBranch([row(50, 'feat/parent')], target, ['main', 'staging'])).toBeNull();
  });

  it('accepts a PR merged into the default or the integration branch', () => {
    expect(selectMergedPrForBranch([row(51, 'main')], target, ['main', 'staging'])?.prNumber).toBe(51);
    expect(selectMergedPrForBranch([row(52, 'staging')], target, ['main', 'staging'])?.prNumber).toBe(52);
  });

  it('skips the feature-branch merge and picks the delivery-branch one', () => {
    const intoFeature = { ...row(53, 'feat/parent'), mergedAt: '2026-11-10T08:30:00Z' };
    expect(selectMergedPrForBranch([intoFeature, row(54, 'main')], target, ['main'])?.prNumber).toBe(54);
  });

  it('counts any base branch when the delivery branches are unknown or the row has none', () => {
    expect(selectMergedPrForBranch([row(55, 'feat/parent')], target)?.prNumber).toBe(55);
    expect(selectMergedPrForBranch([row(56, 'feat/parent')], target, [])?.prNumber).toBe(56);
    expect(selectMergedPrForBranch([row(57)], target, ['main'])?.prNumber).toBe(57);
    expect(selectMergedPrForBranch([row(58, '')], target, ['main'])?.prNumber).toBe(58);
  });
});

describe('createMergedPrByBranchProbe (issue #3578)', () => {
  it('does not ask gh about the integration branch the task repository configures (#3797)', async () => {
    const runGh = vi.fn(async () => ({ stdout: '[]' }));
    const readIntegrationBranch = vi.fn(async () => 'staging');
    const probe = createMergedPrByBranchProbe({ runGh, readIntegrationBranch });
    const onStaging = makeTask({
      sessions: [aSession({ tmuxSession: 'a', gitBranch: 'staging', gitIsWorktree: true })],
    });
    await expect(probe(onStaging)).resolves.toBeNull();
    expect(runGh).not.toHaveBeenCalled();
    expect(readIntegrationBranch).toHaveBeenCalledWith(onStaging);
  });

  it('by default reads the config from the latest session cwd, falling back to the task cwd (#3797)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'probe-gate-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'staging'], { cwd: dir });
      mkdirSync(path.join(dir, '.kookr'));
      writeFileSync(path.join(dir, '.kookr', 'delivery-gate.json'), '{"integrationBranch":"staging"}');
      const runGh = vi.fn(async () => ({ stdout: '[]' }));
      const probe = createMergedPrByBranchProbe({ runGh });
      const session = (cwd: string) => aSession({ tmuxSession: 'a', gitBranch: 'staging', gitIsWorktree: true, cwd });
      // Latest session's cwd configures staging.
      await expect(probe(makeTask({ sessions: [session(dir)] }))).resolves.toBeNull();
      // The session's worktree is gone: the task cwd still answers.
      await expect(probe(makeTask({ cwd: dir, sessions: [session(path.join(dir, 'gone'))] }))).resolves.toBeNull();
      expect(runGh).not.toHaveBeenCalled();
      // A repository without the config: staging is probed as before.
      await probe(makeTask({ sessions: [session(tmpdir())] }));
      expect(runGh).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not read the config for a task that is not a probe candidate (#3797)', async () => {
    const readIntegrationBranch = vi.fn(async () => 'staging');
    const probe = createMergedPrByBranchProbe({ runGh: vi.fn(), readIntegrationBranch });
    await expect(probe(makeTask({ projectId: 'local/thing' }))).resolves.toBeNull();
    expect(readIntegrationBranch).not.toHaveBeenCalled();
  });

  it('a failing config read falls back to the legacy behaviour (#3797)', async () => {
    const runGh = vi.fn(async () => ({ stdout: '[]' }));
    const probe = createMergedPrByBranchProbe({ runGh, readIntegrationBranch: async () => { throw new Error('boom'); } });
    await expect(probe(makeTask())).resolves.toBeNull();
    expect(runGh).toHaveBeenCalledTimes(1);
  });

  it('asks gh for merged PRs on the task branch in the project repo', async () => {
    const runGh = vi.fn(async () => ({
      stdout: JSON.stringify([
        { number: 3575, url: 'https://github.com/kookr-ai/kookr/pull/3575', createdAt: '2026-11-10T08:37:39Z', mergedAt: '2026-11-10T08:48:33Z', headRefName: 'fix/terminal-snapshot-seed-3564', isCrossRepository: false },
      ]),
    }));
    const probe = createMergedPrByBranchProbe({ runGh, timeoutMs: 1234 });

    await expect(probe(makeTask())).resolves.toMatchObject({ prNumber: 3575 });
    expect(runGh).toHaveBeenCalledWith(
      [
        'pr', 'list',
        '--repo', 'kookr-ai/kookr',
        '--head', 'fix/terminal-snapshot-seed-3564',
        '--state', 'merged',
        '--json', 'number,url,createdAt,mergedAt,headRefName,baseRefName,isCrossRepository',
        '--limit', '20',
      ],
      { timeout: 1234 },
    );
  });

  // Issue #4077: the store resolver rejects a merge into a feature branch
  // (#3983); the by-branch fallback must not label it delivered either.
  it('applies the repository delivery branches from the lookup to the gh rows', async () => {
    const intoFeature = { number: 60, createdAt: '2026-11-10T08:00:00Z', mergedAt: '2026-11-10T09:00:00Z', headRefName: 'fix/terminal-snapshot-seed-3564', baseRefName: 'feat/parent', isCrossRepository: false };
    const runGh = vi.fn(async () => ({ stdout: JSON.stringify([intoFeature]) }));
    const deliveryBranchesOf = vi.fn((owner: string, repo: string) =>
      owner === 'kookr-ai' && repo === 'kookr' ? { defaultBranch: 'main', integrationBranch: 'staging' } : undefined);
    const probe = createMergedPrByBranchProbe({ runGh, readIntegrationBranch: async () => null, deliveryBranchesOf });

    await expect(probe(makeTask())).resolves.toBeNull();
    expect(deliveryBranchesOf).toHaveBeenCalledWith('kookr-ai', 'kookr');

    runGh.mockResolvedValueOnce({ stdout: JSON.stringify([{ ...intoFeature, baseRefName: 'staging' }]) });
    await expect(probe(makeTask())).resolves.toMatchObject({ prNumber: 60 });

    // Default branch unknown: the tracker cannot tell a feature branch apart, so any base counts.
    const unknown = createMergedPrByBranchProbe({
      runGh: async () => ({ stdout: JSON.stringify([intoFeature]) }),
      readIntegrationBranch: async () => null,
      deliveryBranchesOf: () => ({ defaultBranch: null, integrationBranch: 'staging' }),
    });
    await expect(unknown(makeTask())).resolves.toMatchObject({ prNumber: 60 });
  });

  it('does not call gh when the task has no usable target', async () => {
    const runGh = vi.fn();
    const probe = createMergedPrByBranchProbe({ runGh });
    await expect(probe(makeTask({ projectId: undefined }))).resolves.toBeNull();
    expect(runGh).not.toHaveBeenCalled();
  });

  it('resolves null when gh fails or returns non-array JSON', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const failing = createMergedPrByBranchProbe({
        runGh: async () => { throw new Error('HTTP 502'); },
      });
      await expect(failing(makeTask())).resolves.toBeNull();

      const garbage = createMergedPrByBranchProbe({ runGh: async () => ({ stdout: '{"x":1}' }) });
      await expect(garbage(makeTask())).resolves.toBeNull();

      const notJson = createMergedPrByBranchProbe({ runGh: async () => ({ stdout: 'oops' }) });
      await expect(notJson(makeTask())).resolves.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});
