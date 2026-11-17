import { afterEach, describe, expect, test, vi } from 'vitest';

const registry = vi.hoisted(() => ({ summaries: [] as unknown[] }));
vi.mock('../routes/project-routes.js', () => ({ listProjectSummaries: async () => registry.summaries }));

import { closeSharedTerminalSnapshotWorker } from '../terminal-snapshot-worker.js';
import type { RouteDeps } from '../routes/shared.js';
import { buildLucyLookSource, buildLucyOperator } from './create-lucy-operator.js';

const NOW = new Date('2026-11-12T12:00:00Z');

/** Just enough of the server's route dependencies for her look-ups, each part recording what it was asked. */
function routeDeps(overrides: Record<string, unknown> = {}) {
  const asked: string[] = [];
  const task = {
    id: 't1',
    name: 'Bake-off report',
    status: 'inProgress',
    prompt: 'Write the report',
    cwd: '/srv/work/kookr',
    agentType: 'claude-code',
    createdAt: NOW,
    updatedAt: NOW,
    sessions: [{ tmuxSession: 'kookr-s1', lastStatus: 'running' }],
  };
  const deps = {
    taskStore: { viewTasks: () => [task], getLifetimeSpendUsd: () => 698.26 },
    queue: {
      inspectActive: () => [{ agentId: 'kookr-s1', anomaly: { type: 'permission_blocked' } }],
      getAll: () => { throw new Error('getAll restores expired snoozes; her look-ups must only read'); },
    },
    // The board and a task's detail must not read a terminal; only `taskOutput` does (tests that use it override these).
    adapter: { captureDisplay: async () => { throw new Error('the board and a task\'s detail must not read a terminal'); } },
    githubStateStore: {
      getReferences: (taskId: string) => { asked.push(`refs:${taskId}`); return [{ type: 'pr', number: 3620 }]; },
      // No pull-request state is known unless a test says so.
      getTaskState: (taskId: string) => { asked.push(`prs:${taskId}`); return { prs: [] }; },
    },
    getQuotaStatus: () => ({ fiveHour: null, sevenDay: { utilization: 42, resetsAt: '2026-11-15T00:00:00Z' }, updatedAt: 1 }),
    taskTailStore: { getByTaskId: async () => { throw new Error('the board and a task\'s detail must not read a saved terminal tail'); } },
    ...overrides,
  };
  return { deps: deps as unknown as RouteDeps, asked };
}

describe('buildLucyLookSource', () => {
  test('the board reads the task list, the findings, the spend and the quota from the server', () => {
    const board = buildLucyLookSource(routeDeps().deps).board();
    expect(board.tasks).toEqual([expect.objectContaining({ id: 't1', name: 'Bake-off report', project: 'kookr', attention: 'it is blocked on a permission' })]);
    expect(board.lifetimeSpendUsd).toBe(698.26);
    expect(board.quota).toEqual({ fiveHour: null, sevenDay: { utilization: 42, resetsAt: '2026-11-15T00:00:00Z' } });
  });

  test('the board lists the questions tasks asked the operator, read from the ask service', () => {
    const record = { id: 'a1', taskId: 't1', question: 'Which database?', options: ['Postgres', 'SQLite'], allowText: false, state: 'pending', createdAt: NOW.getTime() - 60_000, expiresAt: NOW.getTime() + 600_000, nonce: 'n', delivery: { chatId: 1, messageId: 2 } };
    const { deps } = routeDeps({ asks: { service: { all: () => [record] } }, taskStore: { viewTasks: () => [], getTask: () => ({ name: 'Bake-off report' }), getLifetimeSpendUsd: () => 0 } });
    const board = buildLucyLookSource(deps).board();
    expect(board.asks).toEqual([expect.objectContaining({ id: 'a1', taskName: 'Bake-off report', state: 'pending' })]);
    expect(board.asks?.[0]).not.toHaveProperty('nonce');
  });

  test('each listed question says whether its task has ended, from the task store', () => {
    const record = (id: string, taskId: string) => ({ id, taskId, question: 'Which database?', options: ['Postgres'], allowText: false, state: 'pending', createdAt: NOW.getTime() - 60_000, expiresAt: NOW.getTime() + 600_000, nonce: 'n', delivery: { chatId: 1, messageId: 2 } });
    const tasks: Record<string, { name: string; status: string }> = { running: { name: 'A', status: 'inProgress' }, done: { name: 'B', status: 'completed' } };
    const { deps } = routeDeps({
      asks: { service: { all: () => [record('a1', 'running'), record('a2', 'done'), record('a3', 'deleted')] } },
      taskStore: { viewTasks: () => [], getTask: (id: string) => tasks[id], getLifetimeSpendUsd: () => 0 },
    });
    const asks = buildLucyLookSource(deps).board().asks ?? [];
    expect(asks.map((a) => [a.id, a.taskEnded]).sort()).toEqual([['a1', false], ['a2', true], ['a3', true]]);
  });

  test('without an ask service the board has no questions', () => {
    expect(buildLucyLookSource(routeDeps().deps).board().asks).toBeUndefined();
  });

  test('a task\'s detail carries its linked pull requests', () => {
    const { deps, asked } = routeDeps();
    expect(buildLucyLookSource(deps).taskDetail('t1')).toMatchObject({ prompt: 'Write the report', references: ['PR #3620'] });
    expect(asked.sort()).toEqual(['prs:t1', 'refs:t1']);
  });

  describe('delivery facts', () => {
    const pr = (number: number, status: string, detectedFrom: string) => ({ ref: { type: 'pr', number, detectedFrom }, status });
    const withPrs = (prs: unknown[], refs: unknown[]) => routeDeps({ githubStateStore: { getReferences: () => refs, getTaskState: () => ({ prs }) } }).deps;

    test('a task\'s detail says which of its pull requests merged and which is still open', () => {
      const deps = withPrs([pr(12, 'merged', 'kookr-s1'), pr(15, 'open', 'kookr-s1')], [{ type: 'pr', number: 12 }, { type: 'pr', number: 15 }, { type: 'issue', number: 7 }]);
      const detail = buildLucyLookSource(deps).taskDetail('t1');
      expect(detail?.pullRequests).toEqual([{ number: 12, status: 'merged' }, { number: 15, status: 'open' }]);
      // Listed once, with its state: not again among the plain links.
      expect(detail?.references).toEqual(['issue #7']);
    });

    test('a pull request that the task\'s request only cites is not presented as its delivery', () => {
      const deps = withPrs([pr(9, 'merged', 'prompt'), pr(12, 'open', 'kookr-s1')], [{ type: 'pr', number: 9 }, { type: 'pr', number: 12 }]);
      const detail = buildLucyLookSource(deps).taskDetail('t1');
      expect(detail?.pullRequests).toEqual([{ number: 12, status: 'open' }]);
      // It stays a plain link, with no "merged" beside it.
      expect(detail?.references).toEqual(['PR #9']);
    });

    test('the board can read the same facts for the task lines it shows', () => {
      const board = buildLucyLookSource(withPrs([pr(9, 'merged', 'prompt'), pr(12, 'merged', 'kookr-s1')], [])).board();
      expect(board.pullRequestsOf?.('t1')).toEqual([{ number: 12, status: 'merged' }]);
    });
  });

  test('only the terminal look-up reads a terminal or a saved terminal tail', async () => {
    const source = buildLucyLookSource(routeDeps().deps);
    source.board();
    source.taskDetail('t1');
    await source.projects();
    expect(Object.keys(source).sort()).toEqual(['board', 'projects', 'taskDetail', 'taskOutput']);
  });

  describe('taskOutput (issue #3683)', () => {
    afterEach(() => closeSharedTerminalSnapshotWorker());
    const redrawn = Array.from({ length: 30 }, (_, i) => `\x1b[2J\x1b[Hbuilding\r\nstep ${i % 2}`).join('');

    test('a running task: the live terminal is rendered, not passed on raw', async () => {
      const captured: string[] = [];
      const { deps } = routeDeps({ adapter: { captureDisplay: async (name: string) => { captured.push(name); return redrawn; } } });
      const output = await buildLucyLookSource(deps).taskOutput('t1');
      expect(captured).toEqual(['kookr-s1']);
      expect(output).toEqual({ live: true, text: 'building\nstep 1' });
    }, 30_000);

    test('an ended task: the saved tail is rendered', async () => {
      const ended = { id: 't1', name: 'x', status: 'completed', updatedAt: NOW, sessions: [{ tmuxSession: 'kookr-s1', lastStatus: 'completed' }] };
      const { deps } = routeDeps({
        taskStore: { viewTasks: () => [ended], getLifetimeSpendUsd: () => 0 },
        taskTailStore: { getByTaskId: async () => ({ text: '\x1b[32mall done\x1b[0m\r\n' }) },
      });
      expect(await buildLucyLookSource(deps).taskOutput('t1')).toEqual({ live: false, text: 'all done' });
    }, 30_000);

    test('a live capture that fails falls back to the saved tail; with neither there is no output', async () => {
      const failing = { captureDisplay: async () => { throw new Error('session gone'); } };
      const withTail = routeDeps({ adapter: failing, taskTailStore: { getByTaskId: async () => ({ text: 'saved\r\n' }) } }).deps;
      expect(await buildLucyLookSource(withTail).taskOutput('t1')).toEqual({ live: false, text: 'saved' });
      const without = routeDeps({ adapter: failing, taskTailStore: { getByTaskId: async () => null } }).deps;
      expect(await buildLucyLookSource(without).taskOutput('t1')).toBeNull();
    }, 30_000);
  });

  describe('list_projects with a project registry', () => {
    const registryDeps = () => routeDeps({ ledgerAnalytics: {}, projectConfigStore: {} }).deps;
    const summary = (displayName: string, extra: Record<string, unknown>) => ({ project: `github.com/o/${displayName}`, displayName, activeAgents: 0, findingCount: 0, ...extra });

    test('marks where she may launch when launching is on, by the same rule the launcher uses', async () => {
      registry.summaries = [
        summary('tracked', { localPath: '/work/tracked', tracked: true }),
        summary('untracked', { localPath: '/work/untracked', tracked: false }),
        summary('nopath', { tracked: true }),
      ];
      expect(await buildLucyLookSource(registryDeps(), { launching: true }).projects()).toEqual([
        { name: 'tracked', activeTasks: 0, findings: 0, launchable: true },
        // Not tracked, but it has a folder here: the Launch dialog offers it, so she may launch in it (issue #4144).
        { name: 'untracked', activeTasks: 0, findings: 0, launchable: true },
        { name: 'nopath', activeTasks: 0, findings: 0, launchable: false },
      ]);
    });

    test('says nothing about launching when it is off for this install', async () => {
      registry.summaries = [summary('tracked', { localPath: '/work/tracked', tracked: true })];
      expect(await buildLucyLookSource(registryDeps()).projects()).toEqual([{ name: 'tracked', activeTasks: 0, findings: 0 }]);
    });
  });

  test('without a project registry, projects come from the task list', async () => {
    expect(await buildLucyLookSource(routeDeps().deps).projects()).toEqual([{ name: 'kookr', activeTasks: 1, findings: 1 }]);
  });
});

describe('buildLucyOperator', () => {
  test('gives the route nothing when the setting is off or absent', () => {
    expect(buildLucyOperator(routeDeps().deps)).toBeUndefined();
    expect(buildLucyOperator(routeDeps({ lucyOperatorConfig: { enabled: false } }).deps)).toBeUndefined();
  });

  test('gives the route the reason when it is switched on but unusable', () => {
    const result = buildLucyOperator(routeDeps({ lucyOperatorConfig: { enabled: true, ok: false, reason: 'needs a key', warnings: [] } }).deps);
    expect(result).toEqual({ unavailableReason: 'needs a key' });
  });

  test('gives the route a service when it is switched on and usable', () => {
    const model = { apiKey: 'k', model: 'm', baseUrl: 'http://127.0.0.1:9', providers: [], reasoning: 'medium' as const };
    const result = buildLucyOperator(routeDeps({ lucyOperatorConfig: { enabled: true, ok: true, warnings: [], model } }).deps);
    expect(result?.service?.isBusy('c1')).toBe(false);
  });
});
