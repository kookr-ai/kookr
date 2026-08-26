import { describe, expect, test } from 'vitest';
import { buildLaunchDependencyDiagnostics } from './launch-dependency-diagnostics.js';
import type { TaskLaunchHealthFinding } from './task-read-model.js';

function finding(
  dependency: string,
  category: string,
  summary = `${dependency}/${category}`,
): TaskLaunchHealthFinding {
  return {
    dependency,
    status: 'failed',
    category,
    summary,
    recommendedAction: 'inspect',
  };
}

function task(
  id: string,
  createdAt: string,
  findings: TaskLaunchHealthFinding[] = [],
) {
  return {
    id,
    status: 'completed' as const,
    createdAt: new Date(createdAt),
    launchHealthSummary: findings.length > 0
      ? {
          degradedDependencies: [...new Set(findings.map((f) => f.dependency))],
          findings,
        }
      : undefined,
  };
}

describe('buildLaunchDependencyDiagnostics', () => {
  test('empty task list yields zero totals and empty rollups', () => {
    expect(buildLaunchDependencyDiagnostics([])).toEqual({
      schemaVersion: 'launch-dependency-diagnostics.v1',
      totalDegradedTasks: 0,
      totalFindings: 0,
      dependencies: [],
      categories: [],
    });
  });

  test('tasks without findings do not count as degraded', () => {
    const snapshot = buildLaunchDependencyDiagnostics([
      task('t-healthy', '2026-01-01T00:00:00.000Z'),
      {
        id: 't-empty-summary',
        status: 'completed' as const,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        launchHealthSummary: { degradedDependencies: [], findings: [] },
      },
    ]);

    expect(snapshot).toEqual({
      schemaVersion: 'launch-dependency-diagnostics.v1',
      totalDegradedTasks: 0,
      totalFindings: 0,
      dependencies: [],
      categories: [],
    });
  });

  test('reports unknown separately while preserving legacy v1 totals and rollups', () => {
    const snapshot = buildLaunchDependencyDiagnostics([
      task('t-unknown', '2026-03-01T00:00:00.000Z', [finding('kb', 'unknown')]),
    ]);

    expect(snapshot).toMatchObject({
      totalDegradedTasks: 1,
      totalFindings: 1,
      totalUnknownTasks: 1,
      totalUnknownFindings: 1,
      dependencies: [{ dependency: 'kb', findingCount: 1, categories: ['unknown'] }],
      categories: [{ category: 'unknown', findingCount: 1, dependencies: ['kb'] }],
    });
    expect(snapshot.totalConfirmedDegradedTasks).toBeUndefined();
    expect(snapshot.totalConfirmedFindings).toBeUndefined();
  });

  test('reports parked work separately from degraded launch findings and live circuit state', () => {
    const snapshot = buildLaunchDependencyDiagnostics(
      [{
        ...task('parked-1', '2026-03-01T12:00:00.000Z'),
        status: 'pending' as const,
        launchHealthSummary: {
          degradedDependencies: ['kb'],
          findings: [finding('kb', 'provider_api')],
        },
        launchAdmission: {
          status: 'parked' as const,
          reason: 'dependency_degraded' as const,
          dependencies: [{ dependency: 'kb', state: 'degraded' as const, reason: 'provider down' }],
          parkedAt: '2026-03-01T12:01:00.000Z',
        },
      }],
      [{ dependency: 'kb', state: 'degraded', lastChangedAt: 123, reason: 'provider down' }],
    );

    expect(snapshot.totalDegradedTasks).toBe(0);
    expect(snapshot.parkedTasks).toEqual({
      total: 1,
      taskIds: ['parked-1'],
      byDependency: [{
        dependency: 'kb',
        taskCount: 1,
        taskIds: ['parked-1'],
        reasons: ['provider down'],
      }],
    });
    expect(snapshot.dependencyStates).toEqual([
      { dependency: 'kb', state: 'degraded', lastChangedAt: 123, reason: 'provider down' },
    ]);
  });

  test('does not report terminal parked records as pending work', () => {
    const snapshot = buildLaunchDependencyDiagnostics([{
      ...task('cancelled-parked', '2026-03-01T12:00:00.000Z'),
      status: 'cancelled' as const,
      launchAdmission: {
        status: 'parked' as const,
        reason: 'dependency_degraded' as const,
        dependencies: [{ dependency: 'kb', state: 'degraded' as const }],
        parkedAt: '2026-03-01T12:01:00.000Z',
      },
    }]);

    expect(snapshot.parkedTasks).toBeUndefined();
  });

  test('one task with multi-findings rolls up findingCount and related sets', () => {
    const snapshot = buildLaunchDependencyDiagnostics([
      task('t1', '2026-03-01T12:00:00.000Z', [
        finding('kb', 'server_reachability'),
        finding('kb', 'empty_index_data'),
        finding('gh', 'auth'),
      ]),
    ]);

    expect(snapshot.totalDegradedTasks).toBe(1);
    expect(snapshot.totalFindings).toBe(3);
    expect(snapshot.totalConfirmedDegradedTasks).toBe(1);
    expect(snapshot.totalConfirmedFindings).toBe(3);

    expect(snapshot.dependencies).toEqual([
      {
        dependency: 'kb',
        degradedTaskCount: 1,
        findingCount: 2,
        affectedTaskIds: ['t1'],
        categories: ['empty_index_data', 'server_reachability'],
        lastOccurredAt: '2026-03-01T12:00:00.000Z',
      },
      {
        dependency: 'gh',
        degradedTaskCount: 1,
        findingCount: 1,
        affectedTaskIds: ['t1'],
        categories: ['auth'],
        lastOccurredAt: '2026-03-01T12:00:00.000Z',
      },
    ]);

    expect(snapshot.categories).toEqual([
      {
        category: 'auth',
        degradedTaskCount: 1,
        findingCount: 1,
        affectedTaskIds: ['t1'],
        dependencies: ['gh'],
        lastOccurredAt: '2026-03-01T12:00:00.000Z',
      },
      {
        category: 'empty_index_data',
        degradedTaskCount: 1,
        findingCount: 1,
        affectedTaskIds: ['t1'],
        dependencies: ['kb'],
        lastOccurredAt: '2026-03-01T12:00:00.000Z',
      },
      {
        category: 'server_reachability',
        degradedTaskCount: 1,
        findingCount: 1,
        affectedTaskIds: ['t1'],
        dependencies: ['kb'],
        lastOccurredAt: '2026-03-01T12:00:00.000Z',
      },
    ]);
  });

  test('multi-task same dependency counts degraded tasks and sorts affectedTaskIds', () => {
    const snapshot = buildLaunchDependencyDiagnostics([
      task('t-z', '2026-03-02T00:00:00.000Z', [finding('kb', 'server_reachability')]),
      task('t-a', '2026-03-01T00:00:00.000Z', [finding('kb', 'server_reachability')]),
    ]);

    expect(snapshot.totalDegradedTasks).toBe(2);
    expect(snapshot.totalFindings).toBe(2);
    expect(snapshot.dependencies).toEqual([
      {
        dependency: 'kb',
        degradedTaskCount: 2,
        findingCount: 2,
        affectedTaskIds: ['t-a', 't-z'],
        categories: ['server_reachability'],
        lastOccurredAt: '2026-03-02T00:00:00.000Z',
      },
    ]);
    expect(snapshot.categories[0]).toMatchObject({
      category: 'server_reachability',
      degradedTaskCount: 2,
      findingCount: 2,
      affectedTaskIds: ['t-a', 't-z'],
      dependencies: ['kb'],
    });
  });

  test('sorts by findingCount desc, then key asc on ties', () => {
    const snapshot = buildLaunchDependencyDiagnostics([
      task('t1', '2026-01-01T00:00:00.000Z', [
        finding('zebra', 'cat-z'),
        finding('apple', 'cat-a'),
        finding('mango', 'cat-m'),
        finding('mango', 'cat-m2'),
      ]),
    ]);

    // mango:2 first; apple/zebra tied at 1 → key asc
    expect(snapshot.dependencies.map((d) => d.dependency)).toEqual([
      'mango',
      'apple',
      'zebra',
    ]);
    expect(snapshot.dependencies.map((d) => d.findingCount)).toEqual([2, 1, 1]);

    // categories: cat-m/cat-m2/cat-a/cat-z each count 1 → key asc
    expect(snapshot.categories.map((c) => c.category)).toEqual([
      'cat-a',
      'cat-m',
      'cat-m2',
      'cat-z',
    ]);
  });

  test('lastOccurredAt takes the max ISO timestamp across tasks', () => {
    const snapshot = buildLaunchDependencyDiagnostics([
      task('old', '2026-01-01T00:00:00.000Z', [finding('kb', 'auth')]),
      task('mid', '2026-02-15T12:30:00.000Z', [finding('kb', 'auth')]),
      task('new', '2026-03-20T18:45:30.000Z', [finding('kb', 'auth')]),
    ]);

    expect(snapshot.dependencies[0]?.lastOccurredAt).toBe('2026-03-20T18:45:30.000Z');
    expect(snapshot.categories[0]?.lastOccurredAt).toBe('2026-03-20T18:45:30.000Z');
  });

  test('same task with multiple findings for one dependency still counts once in degradedTaskCount', () => {
    const snapshot = buildLaunchDependencyDiagnostics([
      task('t1', '2026-04-01T00:00:00.000Z', [
        finding('kb', 'server_reachability'),
        finding('kb', 'empty_index_data'),
      ]),
    ]);

    expect(snapshot.totalDegradedTasks).toBe(1);
    expect(snapshot.dependencies[0]).toMatchObject({
      dependency: 'kb',
      degradedTaskCount: 1,
      findingCount: 2,
    });
  });
});
