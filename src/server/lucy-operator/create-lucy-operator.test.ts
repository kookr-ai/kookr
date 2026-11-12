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
    queue: { getAll: () => [{ agentId: 'kookr-s1', anomaly: { type: 'permission_blocked' } }] },
    adapter: { captureDisplay: async (sessionId: string) => { asked.push(`capture:${sessionId}`); return 'live line 1\nlive line 2'; } },
    githubStateStore: { getReferences: (taskId: string) => { asked.push(`refs:${taskId}`); return [{ type: 'pr', number: 3620 }]; } },
    getQuotaStatus: () => ({ fiveHour: null, sevenDay: { utilization: 42, resetsAt: '2026-11-15T00:00:00Z' }, updatedAt: 1 }),
    taskTailStore: { getByTaskId: async (taskId: string) => { asked.push(`tail:${taskId}`); return { text: 'saved tail' }; } },
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

  test('a task\'s output is read from its running terminal', async () => {
    const { deps, asked } = routeDeps();
    expect(await buildLucyLookSource(deps).taskOutput('t1', 40)).toEqual({ text: 'live line 1\nlive line 2', source: 'live' });
    expect(asked).toEqual(['capture:kookr-s1']);
  });

  test('when the terminal cannot be read, the saved tail is used', async () => {
    const { deps, asked } = routeDeps({ adapter: { captureDisplay: async () => { throw new Error('gone'); } } });
    expect(await buildLucyLookSource(deps).taskOutput('t1', 40)).toEqual({ text: 'saved tail', source: 'persisted' });
    expect(asked).toEqual(['tail:t1']);
  });

  test('a task\'s detail carries its linked pull requests', () => {
    const { deps, asked } = routeDeps();
    expect(buildLucyLookSource(deps).taskDetail('t1')).toMatchObject({ prompt: 'Write the report', references: ['PR #3620'] });
    expect(asked).toEqual(['refs:t1']);
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
