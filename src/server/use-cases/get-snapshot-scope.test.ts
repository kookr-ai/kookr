import { describe, expect, it } from 'vitest';
import {
  computeSnapshotBaseAgents,
  createSnapshotMessage,
  getProjectSummaries,
  getSnapshotAgentsForClient,
} from './get-snapshot.js';
import type { Scope } from '../viewer-data-policy.js';
import type { TaskRelation } from '../../shared/contracts/task-relations.js';
import { TaskStore } from '../../core/tasks.js';

// --- #809: buildScopedSnapshot project-scope filtering + scrub-list ---
//
// These cover the issue Acceptance criteria: a `projects`-scoped snapshot
// excludes out-of-scope tasks/agents/summaries/relations/aggregates; unassigned
// (no projectId) agents are hidden; the `all` scope (and no scope) is byte-for-
// byte the full snapshot.

const P1 = 'github.com/acme/alpha';
const P2 = 'github.com/acme/beta';

function agent(over: Record<string, unknown>): any {
  return { events: [], anomaly: null, ...over };
}

/** A monitor whose `getSnapshot` returns fixed agents and no task projection,
 *  so the agents flow through `filterAgentsToScope` unchanged in shape. */
function monitorOf(agents: any[]): any {
  return { getSnapshot: () => agents };
}

const AGENTS = [
  agent({ agentId: 'a-1', taskId: 't-1', projectId: P1 }),
  agent({ agentId: 'a-2', taskId: 't-2', projectId: P2 }),
  agent({ agentId: 'a-3', taskId: 't-3' }), // unassigned (no projectId)
];

describe('createSnapshotMessage — scope filtering', () => {
  it('all scope (and no scope) keeps every agent, including unassigned', () => {
    const noScope = createSnapshotMessage({ monitor: monitorOf(AGENTS), serverCwd: '/repo' });
    expect(noScope.agents.map((a) => a.agentId)).toEqual(['a-1', 'a-2', 'a-3']);

    const allScope = createSnapshotMessage({
      monitor: monitorOf(AGENTS),
      serverCwd: '/repo',
      scope: { kind: 'all' },
    });
    expect(allScope.agents.map((a) => a.agentId)).toEqual(['a-1', 'a-2', 'a-3']);
  });

  it('projects scope keeps only in-scope agents and hides unassigned', () => {
    const msg = createSnapshotMessage({
      monitor: monitorOf(AGENTS),
      serverCwd: '/repo',
      scope: { kind: 'projects', projectIds: [P1] },
    });
    expect(msg.agents.map((a) => a.agentId)).toEqual(['a-1']);
  });

  it('projects scope scrubs whole-world aggregates even when their deps are passed', () => {
    const msg = createSnapshotMessage({
      monitor: monitorOf(AGENTS),
      serverCwd: '/repo',
      scope: { kind: 'projects', projectIds: [P1] },
      totalSpendUsd: 99,
      achievements: { first: '2026-01-01T00:00:00.000Z' },
      achievementCounters: {
        repeated_error_resolutions: 1,
        permission_blocked_resolutions: 1,
        merge_conflict_resolutions: 1,
        api_error_resolutions: 1,
        needs_input_resolutions: 1,
        session_start_total: 1,
      },
      achievementStreak: { lastActiveDate: null, currentStreak: 0 },
      coordinator: { taskStore: { listTasks: () => [] } },
    });
    expect(msg).not.toHaveProperty('totalSpendUsd');
    expect(msg).not.toHaveProperty('achievements');
    expect(msg).not.toHaveProperty('achievementCounters');
    expect(msg).not.toHaveProperty('achievementStreak');
    expect(msg).not.toHaveProperty('coordinator');
  });

  it('all scope still ships aggregates', () => {
    const msg = createSnapshotMessage({
      monitor: monitorOf(AGENTS),
      serverCwd: '/repo',
      scope: { kind: 'all' },
      totalSpendUsd: 99,
    });
    expect(msg.totalSpendUsd).toBe(99);
  });

  it('projects scope drops relation edges touching an out-of-scope task', () => {
    const relations: TaskRelation[] = [
      rel('r-in', 't-1', 't-1b'), // both in-scope (t-1b also p1 below)
      rel('r-cross', 't-1', 't-2'), // touches out-of-scope t-2 -> dropped
      rel('r-out', 't-2', 't-9'), // entirely out-of-scope -> dropped
    ];
    const agents = [
      agent({ agentId: 'a-1', taskId: 't-1', projectId: P1 }),
      agent({ agentId: 'a-1b', taskId: 't-1b', projectId: P1 }),
      agent({ agentId: 'a-2', taskId: 't-2', projectId: P2 }),
    ];
    const msg = createSnapshotMessage({
      monitor: monitorOf(agents),
      serverCwd: '/repo',
      scope: { kind: 'projects', projectIds: [P1] },
      relationTaskStore: {
        listRelations: () => relations,
        getPendingSignal: () => undefined,
      } as any,
    });
    expect(msg.taskRelations?.map((r) => r.id)).toEqual(['r-in']);
  });

  it('all scope retains every active relation', () => {
    const relations: TaskRelation[] = [rel('r-in', 't-1', 't-2'), rel('r-cross', 't-1', 't-9')];
    const msg = createSnapshotMessage({
      monitor: monitorOf(AGENTS),
      serverCwd: '/repo',
      relationTaskStore: {
        listRelations: () => relations,
        getPendingSignal: () => undefined,
      } as any,
    });
    expect(msg.taskRelations?.map((r) => r.id)).toEqual(['r-in', 'r-cross']);
  });

  it('projects scope excludes out-of-scope children from a parent childRollup count', () => {
    // child is `source`, parent is `target` for a spawned_by edge.
    const relations: TaskRelation[] = [
      { ...rel('r-cin', 'child-in', 'parent'), type: 'spawned_by' },
      { ...rel('r-cout', 'child-out', 'parent'), type: 'spawned_by' },
    ];
    const agents = [
      agent({ agentId: 'a-parent', taskId: 'parent', projectId: P1 }),
      agent({ agentId: 'a-cin', taskId: 'child-in', projectId: P1 }),
      agent({ agentId: 'a-cout', taskId: 'child-out', projectId: P2 }),
    ];
    const store = { listRelations: () => relations, getPendingSignal: () => undefined } as any;

    const scoped = createSnapshotMessage({
      monitor: monitorOf(agents),
      serverCwd: '/repo',
      scope: { kind: 'projects', projectIds: [P1] },
      relationTaskStore: store,
    });
    const scopedParent = scoped.agents.find((a) => a.taskId === 'parent');
    // Only the in-scope child is counted — the out-of-scope child's existence
    // must not leak via the parent's childCount.
    expect(scopedParent?.childRollup?.childCount).toBe(1);

    // All scope counts both children.
    const all = createSnapshotMessage({
      monitor: monitorOf(agents),
      serverCwd: '/repo',
      relationTaskStore: store,
    });
    expect(all.agents.find((a) => a.taskId === 'parent')?.childRollup?.childCount).toBe(2);
  });

  it('projects scope with an empty projectIds list hides every agent', () => {
    const msg = createSnapshotMessage({
      monitor: monitorOf(AGENTS),
      serverCwd: '/repo',
      scope: { kind: 'projects', projectIds: [] },
    });
    expect(msg.agents).toEqual([]);
  });

  it('projects scope scrubs speech endpoints and owner-config capabilities', () => {
    const deps = {
      monitor: monitorOf(AGENTS),
      serverCwd: '/repo',
      sttUrl: 'ws://localhost:8003',
      ttsUrl: 'http://localhost:8004',
      availableAgentTypes: [{ type: 'claude-code', label: 'Claude Code' }] as any,
      defaultAgentType: 'claude-code' as any,
      workspaceEnabled: true,
      sweepRunning: true,
      getMaxActiveTasks: () => 5,
    };
    const scoped = createSnapshotMessage({ ...deps, scope: { kind: 'projects', projectIds: [P1] } });
    for (const field of [
      'sttEnabled', 'sttUrl', 'ttsEnabled', 'ttsUrl', 'speechCapabilities',
      'availableAgentTypes', 'defaultAgentType', 'workspaceEnabled', 'sweepRunning', 'maxActiveTasks',
    ]) {
      expect(scoped).not.toHaveProperty(field);
    }

    // The same deps under `all` scope keep these fields — proves the scrub is
    // scope-gated, not an accidental drop.
    const all = createSnapshotMessage({ ...deps, scope: { kind: 'all' } });
    expect(all).toHaveProperty('sttUrl', 'ws://localhost:8003');
    expect(all).toHaveProperty('availableAgentTypes');
    expect(all).toHaveProperty('maxActiveTasks', 5);
  });
});

describe('getSnapshotAgentsForClient — scope filtering', () => {
  it('filters agents to the in-scope projects', () => {
    const agents = getSnapshotAgentsForClient({
      monitor: monitorOf(AGENTS),
      scope: { kind: 'projects', projectIds: [P2] },
    });
    expect(agents.map((a) => a.agentId)).toEqual(['a-2']);
  });
});

describe('getProjectSummaries — scope filtering', () => {
  const ledgerAnalytics = {
    getTodayCount: () => 0,
    getWeekCount: () => 0,
    getAttemptsByProject: () => [],
    getAttemptsByProjectRecent: () => [],
    getProjects: () => [],
    getTodayBlockedEntries: () => [],
  } as any;
  const projectConfigStore = {
    getConfig: () => undefined,
    getRateLimit: () => undefined,
    getAllConfigs: () => [],
    getEffectiveDailyLimit: () => undefined,
  } as any;

  it('drops out-of-scope summaries, including non-agent-derived (seeded) ones', () => {
    const agents = [
      agent({ agentId: 'a-1', taskId: 't-1', taskStatus: 'inProgress', projectId: P1, summary: '' }),
      agent({ agentId: 'a-2', taskId: 't-2', taskStatus: 'inProgress', projectId: P2, summary: '' }),
    ];
    const summaries = getProjectSummaries({
      monitor: monitorOf(agents),
      ledgerAnalytics,
      projectConfigStore,
      // Seed an out-of-scope project that has NO agents — proves the final
      // isProjectInScope filter catches summaries not derived from agents.
      getRegistryActiveProjects: () => [P2],
      scope: { kind: 'projects', projectIds: [P1] },
    });
    expect(summaries.map((s) => s.project)).toEqual([P1]);
  });

  it('all scope keeps every project summary', () => {
    const agents = [
      agent({ agentId: 'a-1', taskId: 't-1', taskStatus: 'inProgress', projectId: P1, summary: '' }),
      agent({ agentId: 'a-2', taskId: 't-2', taskStatus: 'inProgress', projectId: P2, summary: '' }),
    ];
    const summaries = getProjectSummaries({
      monitor: monitorOf(agents),
      ledgerAnalytics,
      projectConfigStore,
      scope: { kind: 'all' },
    });
    expect(summaries.map((s) => s.project).sort()).toEqual([P1, P2].sort());
  });
});

// --- #1398: reuse the base fleet projection across per-scope snapshot builds ---
//
// A single broadcast flush builds one snapshot per distinct viewer scope. Before
// #1398 each scope re-ran monitor.getSnapshot() + buildSnapshotProjection() + the
// per-agent client projection; now the full-fleet base is computed once and each
// scope only re-runs filterAgentsToScope. These lock in the two acceptance
// criteria: getSnapshot runs once per flush regardless of scope count, and the
// scoped outputs are byte-identical to the per-scope recompute.
describe('createSnapshotMessage — shared fleet base reuse (#1398)', () => {
  /** A monitor whose getSnapshot returns fixed agents and counts its invocations. */
  function countingMonitor(agents: any[]): { getSnapshot: () => any[]; calls: () => number } {
    let calls = 0;
    return {
      getSnapshot: () => {
        calls += 1;
        return agents;
      },
      calls: () => calls,
    };
  }

  const SCOPES: (Scope | undefined)[] = [
    { kind: 'projects', projectIds: [P1] },
    { kind: 'projects', projectIds: [P2] },
    { kind: 'all' },
    undefined,
  ];

  it('computes the fleet projection once per flush regardless of distinct scope count', () => {
    // Per-scope recompute path (no shared base): one getSnapshot per build.
    const direct = countingMonitor(AGENTS);
    const directMsgs = SCOPES.map((scope) =>
      createSnapshotMessage({ monitor: direct as any, serverCwd: '/repo', ...(scope ? { scope } : {}) }),
    );
    expect(direct.calls()).toBe(SCOPES.length);

    // Shared-base path: compute the base once, thread it into every scope build.
    const shared = countingMonitor(AGENTS);
    const base = computeSnapshotBaseAgents({ monitor: shared as any, serverCwd: '/repo' });
    expect(shared.calls()).toBe(1);
    const sharedMsgs = SCOPES.map((scope) =>
      createSnapshotMessage({
        monitor: shared as any,
        serverCwd: '/repo',
        precomputedClientAgents: base,
        ...(scope ? { scope } : {}),
      }),
    );
    // Building N scoped messages from the base adds zero further getSnapshot calls.
    expect(shared.calls()).toBe(1);

    // Byte-identical scoped outputs, before (per-scope recompute) vs after (base reuse).
    for (let i = 0; i < SCOPES.length; i += 1) {
      expect(JSON.stringify(sharedMsgs[i])).toBe(JSON.stringify(directMsgs[i]));
    }
  });

  it('runs buildSnapshotProjection once per flush and stays byte-identical (getTaskSnapshot-bearing monitor)', () => {
    // A monitor that also implements getTaskSnapshot forces
    // getProjectedSnapshotAgents down the buildSnapshotProjection branch (the
    // other #1398 tests only exercise the raw-monitor path). Here a live session
    // is enriched with its task's projectId by the projection, and a second
    // task-less agent carries its own projectId — so scope filtering over the
    // projected fleet is non-trivial and the projection walk itself must be
    // scope-independent and reusable across scopes.
    // Build the fixture ONCE and share it — the direct and shared paths must see
    // byte-identical data (a fresh TaskStore would mint different task UUIDs).
    const taskStore = new TaskStore();
    const t1 = taskStore.createTask('Enriched task', '/ws/one');
    taskStore.setProjectId(t1.id, P1);
    taskStore.addSession(t1.id, {
      tmuxSession: 'sess-1',
      agentType: 'claude-code',
      cwd: '/ws/one',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    // 'sess-1' has NO projectId of its own — the projection must enrich it from t1.
    const liveStates = [
      agent({ agentId: 'sess-1', taskId: t1.id }),
      agent({ agentId: 'lone', taskId: 't-lone', projectId: P2 }),
    ];
    function projectingMonitor(): { getSnapshot: () => any[]; getTaskSnapshot: () => any[]; calls: () => number } {
      let calls = 0;
      return {
        getSnapshot: () => {
          calls += 1;
          return liveStates;
        },
        getTaskSnapshot: () => taskStore.getAllTasks(),
        calls: () => calls,
      };
    }

    const direct = projectingMonitor();
    const directMsgs = SCOPES.map((scope) =>
      createSnapshotMessage({ monitor: direct as any, serverCwd: '/repo', ...(scope ? { scope } : {}) }),
    );
    expect(direct.calls()).toBe(SCOPES.length);
    // Projection actually enriched the live session with its task's projectId.
    expect(directMsgs[0].agents.find((a) => a.agentId === 'sess-1')?.projectId).toBe(P1);

    const shared = projectingMonitor();
    const base = computeSnapshotBaseAgents({ monitor: shared as any, serverCwd: '/repo' });
    const sharedMsgs = SCOPES.map((scope) =>
      createSnapshotMessage({
        monitor: shared as any,
        serverCwd: '/repo',
        precomputedClientAgents: base,
        ...(scope ? { scope } : {}),
      }),
    );
    expect(shared.calls()).toBe(1);
    for (let i = 0; i < SCOPES.length; i += 1) {
      expect(JSON.stringify(sharedMsgs[i])).toBe(JSON.stringify(directMsgs[i]));
    }
  });

  it('stays byte-identical with a relation store (scoped childRollup + taskRelations)', () => {
    const agents = [
      agent({ agentId: 'a-parent', taskId: 'parent', projectId: P1 }),
      agent({ agentId: 'a-cin', taskId: 'child-in', projectId: P1 }),
      agent({ agentId: 'a-cout', taskId: 'child-out', projectId: P2 }),
    ];
    const relations: TaskRelation[] = [
      { ...rel('r-cin', 'child-in', 'parent'), type: 'spawned_by' },
      { ...rel('r-cout', 'child-out', 'parent'), type: 'spawned_by' },
    ];
    const store = { listRelations: () => relations, getPendingSignal: () => undefined } as any;

    const direct = countingMonitor(agents);
    const directMsgs = SCOPES.map((scope) =>
      createSnapshotMessage({ monitor: direct as any, serverCwd: '/repo', relationTaskStore: store, ...(scope ? { scope } : {}) }),
    );

    const shared = countingMonitor(agents);
    const base = computeSnapshotBaseAgents({ monitor: shared as any, serverCwd: '/repo', relationTaskStore: store });
    const sharedMsgs = SCOPES.map((scope) =>
      createSnapshotMessage({
        monitor: shared as any,
        serverCwd: '/repo',
        relationTaskStore: store,
        precomputedClientAgents: base,
        ...(scope ? { scope } : {}),
      }),
    );
    expect(shared.calls()).toBe(1);
    for (let i = 0; i < SCOPES.length; i += 1) {
      expect(JSON.stringify(sharedMsgs[i])).toBe(JSON.stringify(directMsgs[i]));
    }
  });
});

function rel(id: string, sourceTaskId: string, targetTaskId: string): TaskRelation {
  return {
    id,
    sourceTaskId,
    targetTaskId,
    type: 'related_to',
    confidence: 1,
    source: 'manual',
    evidence: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lifecycle: 'active',
  };
}
