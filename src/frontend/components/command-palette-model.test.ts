import { describe, expect, test } from 'vitest';
import {
  filterActions,
  filterFindings,
  filterProjects,
  filterTasks,
  groupActionsBySection,
  scoreMatch,
  type CommandAction,
  type CommandFindingItem,
  type CommandProjectItem,
  type CommandTaskItem,
} from './command-palette-model.js';

const noop = (): void => {};

function action(id: string, label: string, section: CommandAction['section'], keywords?: string[]): CommandAction {
  return { id, label, section, keywords, run: noop };
}

const ACTIONS: CommandAction[] = [
  action('diagnostics', 'Diagnostics', 'view', ['operations', 'health']),
  action('schedules', 'Schedules', 'tools', ['cron', 'routine']),
  action('settings', 'Settings', 'session', ['preferences']),
  action('shortcuts', 'Help & shortcuts', 'session', ['keys']),
];

describe('scoreMatch', () => {
  test('empty query matches everything with score 0', () => {
    expect(scoreMatch(['anything'], '')).toBe(0);
    expect(scoreMatch(['anything'], '   ')).toBe(0);
  });

  test('returns null when no candidate contains the query', () => {
    expect(scoreMatch(['Diagnostics'], 'zzz')).toBeNull();
  });

  test('exact match beats prefix beats interior', () => {
    const exact = scoreMatch(['cron'], 'cron')!;
    const prefix = scoreMatch(['cronjob'], 'cron')!;
    const interior = scoreMatch(['my cron'], 'cron')!;
    expect(exact).toBeLessThan(prefix);
    expect(prefix).toBeLessThan(interior);
  });

  test('is case-insensitive', () => {
    expect(scoreMatch(['Schedules'], 'sched')).not.toBeNull();
  });
});

describe('filterActions', () => {
  test('empty query preserves source order', () => {
    expect(filterActions(ACTIONS, '').map((a) => a.id)).toEqual(['diagnostics', 'schedules', 'settings', 'shortcuts']);
  });

  test('matches against label and keywords', () => {
    expect(filterActions(ACTIONS, 'cron').map((a) => a.id)).toEqual(['schedules']);
    expect(filterActions(ACTIONS, 'health').map((a) => a.id)).toEqual(['diagnostics']);
  });

  test('ranks a label prefix above a keyword-only interior match', () => {
    const ranked = filterActions(ACTIONS, 's').map((a) => a.id);
    // "Schedules"/"Settings"/"shortcuts" all start with s (after lowercasing),
    // so they outrank "Diagnostics" which only matches via "operations".
    expect(ranked[ranked.length - 1]).toBe('diagnostics');
  });
});

describe('filterTasks', () => {
  const tasks: CommandTaskItem[] = [
    { taskId: 't1', agentId: 'a1', label: 'Fix telegram STT' },
    { taskId: 't2', agentId: 'a2', label: 'Wire dependency rail', projectLabel: 'kookr' },
  ];

  test('empty query yields no tasks (tasks only appear while searching)', () => {
    expect(filterTasks(tasks, '')).toEqual([]);
  });

  test('matches task label and project label', () => {
    expect(filterTasks(tasks, 'telegram').map((t) => t.taskId)).toEqual(['t1']);
    expect(filterTasks(tasks, 'kookr').map((t) => t.taskId)).toEqual(['t2']);
  });
});

describe('filterFindings', () => {
  const findings: CommandFindingItem[] = [
    {
      agentId: 'a1',
      label: 'Fix telegram STT',
      severity: 'warning',
      type: 'needs input',
      projectLabel: 'kookr',
      explanation: 'Agent asked for model choice',
    },
    {
      agentId: 'a2',
      label: 'Investigate launch failure',
      severity: 'critical',
      type: 'api error',
      projectLabel: 'openclaw',
      explanation: 'Launch dependency failed',
    },
  ];

  test('empty query yields no findings (findings only appear while searching)', () => {
    expect(filterFindings(findings, '')).toEqual([]);
  });

  test('matches finding label, type, severity, project, and explanation', () => {
    expect(filterFindings(findings, 'telegram').map((f) => f.agentId)).toEqual(['a1']);
    expect(filterFindings(findings, 'api error').map((f) => f.agentId)).toEqual(['a2']);
    expect(filterFindings(findings, 'critical').map((f) => f.agentId)).toEqual(['a2']);
    expect(filterFindings(findings, 'openclaw').map((f) => f.agentId)).toEqual(['a2']);
    expect(filterFindings(findings, 'model choice').map((f) => f.agentId)).toEqual(['a1']);
  });
});

describe('filterProjects', () => {
  const projects: CommandProjectItem[] = [
    { projectId: 'github.com/kookr-ai/kookr', label: 'kookr', activeAgents: 3, findingCount: 1 },
    {
      projectId: 'github.com/example/openclaw',
      label: 'openclaw',
      activeAgents: 1,
      findingCount: 0,
      keywords: ['/srv/openclaw'],
    },
  ];

  test('empty query yields no projects (projects only appear while searching)', () => {
    expect(filterProjects(projects, '')).toEqual([]);
  });

  test('matches project label, id, and keywords', () => {
    expect(filterProjects(projects, 'kookr-ai').map((p) => p.projectId)).toEqual(['github.com/kookr-ai/kookr']);
    expect(filterProjects(projects, 'openclaw').map((p) => p.projectId)).toEqual(['github.com/example/openclaw']);
    expect(filterProjects(projects, '/srv').map((p) => p.projectId)).toEqual(['github.com/example/openclaw']);
  });
});

describe('groupActionsBySection', () => {
  test('groups in task→view→tools→session order, dropping empty sections', () => {
    const groups = groupActionsBySection(ACTIONS);
    expect(groups.map((g) => g.section)).toEqual(['view', 'tools', 'session']);
    expect(groups.find((g) => g.section === 'session')!.actions.map((a) => a.id)).toEqual(['settings', 'shortcuts']);
  });
});
