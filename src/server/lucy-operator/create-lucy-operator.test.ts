import { describe, expect, test } from 'vitest';
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
    // Her look-ups must not read a terminal (issue #3683): any call here fails the test.
    adapter: { captureDisplay: async () => { throw new Error('her look-ups must not read a terminal'); } },
    githubStateStore: { getReferences: (taskId: string) => { asked.push(`refs:${taskId}`); return [{ type: 'pr', number: 3620 }]; } },
    getQuotaStatus: () => ({ fiveHour: null, sevenDay: { utilization: 42, resetsAt: '2026-11-15T00:00:00Z' }, updatedAt: 1 }),
    taskTailStore: { getByTaskId: async () => { throw new Error('her look-ups must not read a saved terminal tail'); } },
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

  test('a task\'s detail carries its linked pull requests', () => {
    const { deps, asked } = routeDeps();
    expect(buildLucyLookSource(deps).taskDetail('t1')).toMatchObject({ prompt: 'Write the report', references: ['PR #3620'] });
    expect(asked).toEqual(['refs:t1']);
  });

  test('nothing she can look up reads a terminal or a saved terminal tail', async () => {
    const source = buildLucyLookSource(routeDeps().deps);
    source.board();
    source.taskDetail('t1');
    await source.projects();
    expect(Object.keys(source).sort()).toEqual(['board', 'projects', 'taskDetail']);
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
