import { describe, expect, test } from 'vitest';
import { deriveLaunchProjectCwd, deriveProjectCwd } from './derive-project-cwd.js';
import type { AgentState } from '../shared/protocol.js';
import type { ProjectSummary } from '../shared/protocol.js';

function agent(over: Partial<AgentState>): AgentState {
  return {
    agentId: 'a',
    events: [],
    anomaly: null,
    ...over,
  };
}

function project(over: Partial<ProjectSummary>): ProjectSummary {
  return {
    project: 'github.com/me/repo',
    displayName: 'repo',
    activeAgents: 0,
    attentionScore: 0,
    recentTasks: [],
    ...over,
  };
}

describe('deriveProjectCwd', () => {
  test('returns null when no agent matches the project', () => {
    const agents = [agent({ projectId: 'github.com/other/repo', cwd: '/x' })];
    expect(deriveProjectCwd(agents, 'github.com/me/repo')).toBeNull();
  });

  test('returns null when matching agents have no cwd', () => {
    const agents = [agent({ projectId: 'github.com/me/repo' })];
    expect(deriveProjectCwd(agents, 'github.com/me/repo')).toBeNull();
  });

  test('returns the matching agent cwd', () => {
    const agents = [agent({ projectId: 'github.com/me/repo', cwd: '/work/repo' })];
    expect(deriveProjectCwd(agents, 'github.com/me/repo')).toBe('/work/repo');
  });

  test('picks the most recent agent by startedAt when several match', () => {
    const agents = [
      agent({ agentId: 'old', projectId: 'p', cwd: '/old', startedAt: '2026-01-01T00:00:00Z' }),
      agent({ agentId: 'new', projectId: 'p', cwd: '/new', startedAt: '2026-05-01T00:00:00Z' }),
      agent({ agentId: 'mid', projectId: 'p', cwd: '/mid', startedAt: '2026-03-01T00:00:00Z' }),
    ];
    expect(deriveProjectCwd(agents, 'p')).toBe('/new');
  });

  test('treats missing startedAt as oldest', () => {
    const agents = [
      agent({ agentId: 'dated', projectId: 'p', cwd: '/dated', startedAt: '2026-01-01T00:00:00Z' }),
      agent({ agentId: 'undated', projectId: 'p', cwd: '/undated' }),
    ];
    expect(deriveProjectCwd(agents, 'p')).toBe('/dated');
  });

  test('strips protected worktree suffix to parent repo', () => {
    // PROTECTED_SUFFIX in worktree-protection.ts is the literal "kookr-prod".
    const agents = [
      agent({ projectId: 'p', cwd: '/home/me/git/kookr-prod', startedAt: '2026-05-01T00:00:00Z' }),
    ];
    expect(deriveProjectCwd(agents, 'p')).toBe('/home/me/git/kookr');
  });

  test('ignores agents without a projectId', () => {
    const agents = [
      agent({ projectId: undefined, cwd: '/orphan' }),
      agent({ projectId: 'p', cwd: '/work/repo' }),
    ];
    expect(deriveProjectCwd(agents, 'p')).toBe('/work/repo');
  });
});

describe('deriveLaunchProjectCwd', () => {
  test('falls back to project localPath when the project has no agent cwd', () => {
    expect(deriveLaunchProjectCwd([], project({ localPath: '/work/repo' }))).toBe('/work/repo');
  });

  test('keeps project localPath ahead of agent-derived cwd', () => {
    const agents = [
      agent({ projectId: 'github.com/me/repo', cwd: '/work/repo-from-agent' }),
    ];

    expect(deriveLaunchProjectCwd(agents, project({ localPath: '/work/repo-from-config' })))
      .toBe('/work/repo-from-config');
  });

  test('returns null when neither agents nor project localPath provide a cwd', () => {
    expect(deriveLaunchProjectCwd([], project({ localPath: undefined }))).toBeNull();
  });
});
