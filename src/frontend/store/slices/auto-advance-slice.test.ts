import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import {
  autoAdvanceQueue,
  engagedWithFinding,
  describeTickReason,
  describeSwitchCause,
  evaluateAutoAdvance,
  attachAutoAdvanceSubscribers,
  __resetAutoAdvanceForTests,
} from './auto-advance-slice.js';
import { createKookrStore } from '../useStore.js';
import type { AgentState } from '../../../shared/contracts/agent-state.js';
import type { ProjectSummary } from '../../../shared/contracts/project-summary.js';
import type { ProjectSidebarPrefs } from '../project-sidebar-prefs.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<AgentState> & { agentId: string; projectId: string }): AgentState {
  return {
    agentId: overrides.agentId,
    events: [],
    anomaly: null,
    projectId: overrides.projectId,
    taskStatus: 'inProgress',
    ...overrides,
  } as AgentState;
}

function makeFinding(agentId: string, projectId: string): AgentState {
  return makeAgent({
    agentId,
    projectId,
    anomaly: {
      agentId,
      type: 'idle',
      severity: 'warning',
      explanation: '',
      detectedAt: new Date(),
    },
    taskStatus: 'inProgress',
  });
}

function makeProject(project: string): ProjectSummary {
  return {
    project,
    displayName: project,
    color: 0,
    activeAgents: 0,
    findingCount: 0,
    todayPrCount: 0,
    weekPrCount: 0,
    openPrs: 0,
    recentTasks: [],
  };
}

function makePrefs(pinned: string[] = [], ordered: string[] = []): ProjectSidebarPrefs {
  return { version: 1, pinned, ordered, hidden: [] } as ProjectSidebarPrefs;
}

// ---------------------------------------------------------------------------
// autoAdvanceQueue
// ---------------------------------------------------------------------------

describe('autoAdvanceQueue', () => {
  test('pinned projects come before unpinned in their sidebar order', () => {
    const queue = autoAdvanceQueue({
      visibleProjectSummaries: [
        makeProject('org/api'),
        makeProject('org/web'),
        makeProject('org/infra'),
        makeProject('org/docs'),
        makeProject('org/scripts'),
      ],
      projectSidebarPrefs: makePrefs(['org/api', 'org/web', 'org/infra']),
      agents: [
        makeFinding('a1', 'org/web'),
        makeFinding('a2', 'org/web'),
        makeFinding('a3', 'org/infra'),
        makeFinding('a4', 'org/docs'),
        makeFinding('a5', 'org/docs'),
        makeFinding('a6', 'org/docs'),
        makeFinding('a7', 'org/scripts'),
      ],
    });
    // org/api has no findings → excluded; pinned (web, infra) before unpinned (docs, scripts).
    // org/docs has 5 findings but does NOT outrank pinned projects.
    expect(queue).toEqual(['org/web', 'org/infra', 'org/docs', 'org/scripts']);
  });

  test('excludes projects with no active findings', () => {
    const queue = autoAdvanceQueue({
      visibleProjectSummaries: [makeProject('org/a'), makeProject('org/b')],
      projectSidebarPrefs: makePrefs([], []),
      agents: [makeFinding('x', 'org/b')],
    });
    expect(queue).toEqual(['org/b']);
  });

  test('returns empty when no project has active findings', () => {
    const queue = autoAdvanceQueue({
      visibleProjectSummaries: [makeProject('org/a')],
      projectSidebarPrefs: makePrefs(),
      agents: [makeAgent({ agentId: 'x', projectId: 'org/a' })],
    });
    expect(queue).toEqual([]);
  });

  test('ignores agents whose project is not in the sidebar', () => {
    const queue = autoAdvanceQueue({
      visibleProjectSummaries: [makeProject('org/a')],
      projectSidebarPrefs: makePrefs(),
      agents: [makeFinding('x', 'org/hidden')],
    });
    expect(queue).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// engagedWithFinding
// ---------------------------------------------------------------------------

describe('engagedWithFinding', () => {
  test('false when no agent selected', () => {
    expect(engagedWithFinding({ selectedAgentId: null, selectedAgentSource: 'manual', agents: [] })).toBe(false);
  });

  test('false when selected agent is healthy (no anomaly)', () => {
    expect(engagedWithFinding({
      selectedAgentId: 'a1',
      selectedAgentSource: 'manual',
      agents: [makeAgent({ agentId: 'a1', projectId: 'p' })],
    })).toBe(false);
  });

  test('true when selected finding is manually picked', () => {
    expect(engagedWithFinding({
      selectedAgentId: 'a1',
      selectedAgentSource: 'manual',
      agents: [makeFinding('a1', 'p')],
    })).toBe(true);
  });

  test('false when finding selection came from auto-advance (cascade non-regression)', () => {
    expect(engagedWithFinding({
      selectedAgentId: 'a1',
      selectedAgentSource: 'auto-advance',
      agents: [makeFinding('a1', 'p')],
    })).toBe(false);
  });

  test('false when selected agent is snoozed', () => {
    const finding = makeFinding('a1', 'p');
    finding.snoozedUntil = Date.now() + 60_000;
    expect(engagedWithFinding({
      selectedAgentId: 'a1',
      selectedAgentSource: 'manual',
      agents: [finding],
    })).toBe(false);
  });

  test('false when selected agent is suppressed', () => {
    const finding = makeFinding('a1', 'p');
    finding.suppressed = true;
    expect(engagedWithFinding({
      selectedAgentId: 'a1',
      selectedAgentSource: 'manual',
      agents: [finding],
    })).toBe(false);
  });

  test('false when selected agent is in terminal state', () => {
    const finding = makeFinding('a1', 'p');
    finding.taskStatus = 'completed';
    expect(engagedWithFinding({
      selectedAgentId: 'a1',
      selectedAgentSource: 'manual',
      agents: [finding],
    })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Display strings
// ---------------------------------------------------------------------------

describe('describeTickReason', () => {
  test('every enum value plus null maps to a non-implementer string', () => {
    const values: Array<Parameters<typeof describeTickReason>[0]> = [
      'no_eligible_project', 'already_top', 'engaged', 'settling', 'scheduled', null,
    ];
    for (const v of values) {
      const str = describeTickReason(v);
      expect(str.length).toBeGreaterThan(3);
      // No raw enum value should leak as a display string.
      expect(str).not.toBe(v);
    }
  });
});

describe('describeSwitchCause', () => {
  test('returns human strings for both cause variants', () => {
    expect(describeSwitchCause('activation')).toMatch(/activated/);
    expect(describeSwitchCause('queue_head_changed')).toMatch(/higher-priority/);
  });
});

// ---------------------------------------------------------------------------
// evaluateAutoAdvance (tick logic) — uses createKookrStore + manual subscriber attach
// ---------------------------------------------------------------------------

describe('evaluateAutoAdvance', () => {
  let store: ReturnType<typeof createKookrStore>;

  beforeEach(() => {
    __resetAutoAdvanceForTests();
    if (typeof localStorage !== 'undefined') {
      try { localStorage.removeItem('kookr-auto-advance-mode'); } catch { /* noop */ }
    }
    store = createKookrStore();
    // Mark as hydrated so the tick subscriber doesn't gate.
    store.setState({
      agentsHydrated: true,
      projectSummariesHydrated: true,
      autoAdvanceEnabled: true,
    });
  });

  afterEach(() => {
    __resetAutoAdvanceForTests();
  });

  function setProjects(projects: ProjectSummary[], pinned: string[] = []): void {
    store.setState({
      visibleProjectSummaries: projects,
      projectSummaries: projects,
      projectSidebarPrefs: makePrefs(pinned, projects.map((p) => p.project)),
    });
  }

  test('records no_eligible_project when no project has findings', () => {
    setProjects([makeProject('org/a')]);
    const scheduleSwitch = vi.fn();
    const cancelPending = vi.fn();
    evaluateAutoAdvance(store.getState(), store, {
      settleMs: 0, now: () => 1000, scheduleSwitch, cancelPending,
    });
    expect(store.getState().lastTickReason).toBe('no_eligible_project');
    expect(scheduleSwitch).not.toHaveBeenCalled();
    expect(cancelPending).toHaveBeenCalled();
  });

  test('records already_top when current project is the queue head', () => {
    setProjects([makeProject('org/a')]);
    store.setState({
      agents: [makeFinding('x', 'org/a')],
      selectedProject: 'org/a',
    });
    const scheduleSwitch = vi.fn();
    evaluateAutoAdvance(store.getState(), store, {
      settleMs: 0, now: () => 1000, scheduleSwitch, cancelPending: vi.fn(),
    });
    expect(store.getState().lastTickReason).toBe('already_top');
    expect(scheduleSwitch).not.toHaveBeenCalled();
  });

  test('records engaged when user has a manually-selected finding', () => {
    setProjects([makeProject('org/a'), makeProject('org/b')], ['org/b']);
    const finding = makeFinding('engagedOne', 'org/a');
    const target = makeFinding('targetOne', 'org/b');
    store.setState({
      agents: [finding, target],
      selectedProject: 'org/a',
      selectedAgentId: 'engagedOne',
      selectedAgentSource: 'manual',
    });
    const scheduleSwitch = vi.fn();
    evaluateAutoAdvance(store.getState(), store, {
      settleMs: 0, now: () => 1000, scheduleSwitch, cancelPending: vi.fn(),
    });
    expect(store.getState().lastTickReason).toBe('engaged');
    expect(scheduleSwitch).not.toHaveBeenCalled();
  });

  test('schedules a switch when queue head differs and user is not engaged', () => {
    setProjects([makeProject('org/a'), makeProject('org/b')], ['org/b']);
    store.setState({
      agents: [makeFinding('x', 'org/b')],
      selectedProject: 'org/a',
    });
    const scheduleSwitch = vi.fn();
    evaluateAutoAdvance(store.getState(), store, {
      settleMs: 0, now: () => 1000, scheduleSwitch, cancelPending: vi.fn(),
    });
    expect(store.getState().lastTickReason).toBe('settling');
    expect(scheduleSwitch).toHaveBeenCalledWith('queue_head_changed');
  });

  test('cascade non-regression: auto-advance landing does NOT establish engagement', () => {
    setProjects([makeProject('org/a'), makeProject('org/b')], ['org/a', 'org/b']);
    // org/a has a finding the user manually engaged with; org/b just got one too.
    // But the user just landed on org/a via auto-advance (source = auto-advance).
    store.setState({
      agents: [makeFinding('xa', 'org/a'), makeFinding('xb', 'org/b')],
      selectedProject: 'org/a',
      selectedAgentId: 'xa',
      selectedAgentSource: 'auto-advance',
    });
    const scheduleSwitch = vi.fn();
    evaluateAutoAdvance(store.getState(), store, {
      settleMs: 0, now: () => 1000, scheduleSwitch, cancelPending: vi.fn(),
    });
    // org/a is still the top priority (pinned first), so it stays "already_top".
    // The key non-regression: this is NOT 'engaged' (cascade would have made it so).
    expect(store.getState().lastTickReason).toBe('already_top');
  });

  test('clears autoAdvanceError on the next successful tick', () => {
    setProjects([makeProject('org/a')]);
    store.setState({
      autoAdvanceError: { message: 'old error', firstSeenTs: 500 },
    });
    evaluateAutoAdvance(store.getState(), store, {
      settleMs: 0, now: () => 1000, scheduleSwitch: vi.fn(), cancelPending: vi.fn(),
    });
    expect(store.getState().autoAdvanceError).toBeNull();
  });

  test('captures errors with a stable firstSeenTs across recurrences', () => {
    setProjects([makeProject('org/a')]);
    // Force a throw by handing scheduleSwitch a function that crashes inside cancelPending.
    const ctxThrow = {
      settleMs: 0,
      now: vi.fn(() => 1000),
      scheduleSwitch: vi.fn(),
      cancelPending: vi.fn(() => { throw new Error('boom'); }),
    };
    evaluateAutoAdvance(store.getState(), store, ctxThrow);
    const first = store.getState().autoAdvanceError;
    expect(first).not.toBeNull();
    expect(first!.message).toBe('boom');
    expect(first!.firstSeenTs).toBe(1000);

    // Same error message at a later timestamp must keep firstSeenTs.
    ctxThrow.now.mockReturnValue(5000);
    evaluateAutoAdvance(store.getState(), store, ctxThrow);
    expect(store.getState().autoAdvanceError!.firstSeenTs).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Subscriber integration — uses real Zustand store + attached subscribers
// ---------------------------------------------------------------------------

describe('attachAutoAdvanceSubscribers', () => {
  let store: ReturnType<typeof createKookrStore>;

  beforeEach(() => {
    __resetAutoAdvanceForTests();
    if (typeof localStorage !== 'undefined') {
      try { localStorage.removeItem('kookr-auto-advance-mode'); } catch { /* noop */ }
    }
    store = createKookrStore();
  });

  afterEach(() => {
    __resetAutoAdvanceForTests();
  });

  function hydrateWith(opts: {
    projects: ProjectSummary[];
    pinned?: string[];
    agents?: AgentState[];
    selectedProject?: string | null;
    enabled?: boolean;
  }): void {
    store.setState({
      visibleProjectSummaries: opts.projects,
      projectSummaries: opts.projects,
      projectSidebarPrefs: makePrefs(opts.pinned ?? [], opts.projects.map((p) => p.project)),
      agents: opts.agents ?? [],
      selectedProject: opts.selectedProject ?? null,
      agentsHydrated: true,
      projectSummariesHydrated: true,
      autoAdvanceEnabled: opts.enabled ?? true,
    });
  }

  test('switch fires after settle window and lands on queue head with auto-advance source', async () => {
    // Attach with settleMs=0 so the timer fires on next microtask.
    attachAutoAdvanceSubscribers(store, { settleMs: 0 });
    hydrateWith({
      projects: [makeProject('org/a'), makeProject('org/b')],
      pinned: ['org/b'],
      agents: [makeFinding('x', 'org/b')],
      selectedProject: 'org/a',
    });

    await new Promise((r) => setTimeout(r, 5));
    expect(store.getState().selectedProject).toBe('org/b');
    expect(store.getState().selectedAgentSource).toBe('auto-advance');
    expect(store.getState().selectedAgentId).toBeNull();
    expect(store.getState().lastAutoSwitch?.to).toBe('org/b');
    expect(store.getState().lastAutoSwitch?.from).toBe('org/a');
  });

  test('toggle-off during settle cancels the pending switch', async () => {
    attachAutoAdvanceSubscribers(store, { settleMs: 50 });
    hydrateWith({
      projects: [makeProject('org/a'), makeProject('org/b')],
      pinned: ['org/b'],
      agents: [makeFinding('x', 'org/b')],
      selectedProject: 'org/a',
    });
    // Disable before the timer fires.
    store.setState({ autoAdvanceEnabled: false });
    await new Promise((r) => setTimeout(r, 80));
    expect(store.getState().selectedProject).toBe('org/a');
  });

  test('no switch when mode is off', async () => {
    attachAutoAdvanceSubscribers(store, { settleMs: 0 });
    hydrateWith({
      projects: [makeProject('org/a'), makeProject('org/b')],
      pinned: ['org/b'],
      agents: [makeFinding('x', 'org/b')],
      selectedProject: 'org/a',
      enabled: false,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(store.getState().selectedProject).toBe('org/a');
    // lastTickReason should not be set — the early-exit guard skipped the tick.
    expect(store.getState().lastTickReason).toBeNull();
  });

  test('no tick fires before hydration completes', async () => {
    attachAutoAdvanceSubscribers(store, { settleMs: 0 });
    store.setState({
      visibleProjectSummaries: [makeProject('org/a'), makeProject('org/b')],
      projectSidebarPrefs: makePrefs(['org/b']),
      agents: [makeFinding('x', 'org/b')],
      selectedProject: 'org/a',
      autoAdvanceEnabled: true,
      agentsHydrated: false,
      projectSummariesHydrated: false,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(store.getState().selectedProject).toBe('org/a');
    expect(store.getState().lastTickReason).toBeNull();
  });

  test('side-effect cleanup on auto-switch: respondAllAgentIds and panes reset', async () => {
    attachAutoAdvanceSubscribers(store, { settleMs: 0 });
    hydrateWith({
      projects: [makeProject('org/a'), makeProject('org/b')],
      pinned: ['org/b'],
      agents: [makeFinding('x', 'org/b')],
      selectedProject: 'org/a',
    });
    // Simulate state the user might have built up on org/a.
    store.setState({
      respondAllAgentIds: ['foo', 'bar'],
      leftPane: 'github',
      narrowTab: 'github',
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(store.getState().selectedProject).toBe('org/b');
    expect(store.getState().respondAllAgentIds).toBeNull();
    expect(store.getState().leftPane).toBe('activity');
    expect(store.getState().narrowTab).toBe('activity');
  });

  test('fire-time recompute: queue change between schedule and fire picks new head', async () => {
    attachAutoAdvanceSubscribers(store, { settleMs: 30 });
    hydrateWith({
      projects: [makeProject('org/a'), makeProject('org/b'), makeProject('org/c')],
      pinned: ['org/b', 'org/c'],
      agents: [makeFinding('x', 'org/c')],
      selectedProject: 'org/a',
    });
    // Mid-settle, a higher-priority finding (on org/b which is pinned first) arrives.
    store.setState({
      agents: [makeFinding('x', 'org/c'), makeFinding('y', 'org/b')],
    });
    await new Promise((r) => setTimeout(r, 60));
    // The fire-time recompute should put us on org/b, not org/c.
    expect(store.getState().selectedProject).toBe('org/b');
  });
});

// ---------------------------------------------------------------------------
// applySelection invariant — every selection write produces a consistent pair
// ---------------------------------------------------------------------------

describe('applySelection', () => {
  let store: ReturnType<typeof createKookrStore>;

  beforeEach(() => {
    __resetAutoAdvanceForTests();
    store = createKookrStore();
  });

  afterEach(() => {
    __resetAutoAdvanceForTests();
  });

  test('writes selectedAgentId and selectedAgentSource together', () => {
    store.getState().applySelection({ agentId: 'a1', source: 'manual' });
    expect(store.getState().selectedAgentId).toBe('a1');
    expect(store.getState().selectedAgentSource).toBe('manual');

    store.getState().applySelection({ agentId: null, source: 'auto-advance' });
    expect(store.getState().selectedAgentId).toBeNull();
    expect(store.getState().selectedAgentSource).toBe('auto-advance');
  });
});
