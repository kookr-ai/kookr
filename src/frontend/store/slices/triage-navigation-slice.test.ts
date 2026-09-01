import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createKookrStore } from '../useStore.js';
import type { AgentState, ProjectSummary } from '../../../shared/protocol.js';

// ---------------------------------------------------------------------------
// Fixtures — mirror the auto-advance-slice test harness: build the store via
// createKookrStore(), seed prerequisite cross-slice state with setState, drive
// the slice's actions, then assert on the resulting selection/alert state
// rather than on the withSelectionTransitionSource wrapper.
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
    openContributionAttempts: 0,
    recentTasks: [],
  };
}

// ---------------------------------------------------------------------------
// selectAgent — keep task detail and project-scoped dashboard state coherent
// ---------------------------------------------------------------------------

describe('selectAgent project synchronization', () => {
  let store: ReturnType<typeof createKookrStore>;
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map([['kookr-selected-project', 'org/a']]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    });
    store = createKookrStore();
    store.setState({
      agents: [
        makeAgent({ agentId: 'agent-a', taskId: 'task-a', projectId: 'org/a' }),
        makeAgent({ agentId: 'agent-b', taskId: 'task-b', projectId: 'org/b' }),
      ],
      visibleProjectSummaries: [makeProject('org/a'), makeProject('org/b')],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('activates and persists the selected task\'s visible project', () => {
    store.getState().selectAgent('agent-b', 'task-b');

    expect(store.getState().selectedAgentId).toBe('agent-b');
    expect(store.getState().selectedTaskId).toBe('task-b');
    expect(store.getState().selectedProject).toBe('org/b');
    expect(storage.get('kookr-selected-project')).toBe('org/b');
  });

  test('falls back to All Projects when the selected task\'s project is hidden', () => {
    store.setState({ visibleProjectSummaries: [makeProject('org/a')] });

    store.getState().selectAgent('agent-b', 'task-b');

    expect(store.getState().selectedAgentId).toBe('agent-b');
    expect(store.getState().selectedTaskId).toBe('task-b');
    expect(store.getState().selectedProject).toBeNull();
    expect(storage.has('kookr-selected-project')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleAlert — focus guard (F20)
// ---------------------------------------------------------------------------

describe('handleAlert focus guard', () => {
  let store: ReturnType<typeof createKookrStore>;

  beforeEach(() => {
    store = createKookrStore();
  });

  test('suppresses a toast from a different live agent while focus is held', () => {
    store.setState({
      agents: [makeFinding('selected', 'org/a'), makeFinding('other', 'org/a')],
      selectedAgentId: 'selected',
      focusZone: 'response-input',
    });

    store.getState().handleAlert('other', 'something happened');

    expect(store.getState().alerts).toEqual([]);
  });

  test('allows a toast from the SAME selected agent even while focus is held', () => {
    store.setState({
      agents: [makeFinding('selected', 'org/a'), makeFinding('other', 'org/a')],
      selectedAgentId: 'selected',
      focusZone: 'terminal',
    });

    store.getState().handleAlert('selected', 'progress update');

    expect(store.getState().alerts).toHaveLength(1);
    expect(store.getState().alerts[0].agentId).toBe('selected');
  });

  test('allows a non-agent toast (id not present in agents) even while focus is held', () => {
    store.setState({
      agents: [makeFinding('selected', 'org/a')],
      selectedAgentId: 'selected',
      focusZone: 'response-input',
    });

    // 'workspace' is not a live agent id — feedback for the user's own action.
    store.getState().handleAlert('workspace', 'saved');

    expect(store.getState().alerts).toHaveLength(1);
    expect(store.getState().alerts[0].agentId).toBe('workspace');
  });

  test('allows a toast from a different agent when no focus is held', () => {
    store.setState({
      agents: [makeFinding('selected', 'org/a'), makeFinding('other', 'org/a')],
      selectedAgentId: 'selected',
      focusZone: 'none',
    });

    store.getState().handleAlert('other', 'heads up');

    expect(store.getState().alerts).toHaveLength(1);
    expect(store.getState().alerts[0].agentId).toBe('other');
  });

  test('derives severity from an "Error:" summary when none is supplied', () => {
    store.getState().handleAlert('workspace', 'Error: disk full');
    expect(store.getState().alerts[0].severity).toBe('error');

    store.getState().handleAlert('workspace', 'all good');
    expect(store.getState().alerts[1].severity).toBe('info');

    // An explicit severity argument wins over the summary-derived fallback.
    store.getState().handleAlert('workspace', 'Error: looks scary', 'info');
    expect(store.getState().alerts[2].severity).toBe('info');
  });
});

// ---------------------------------------------------------------------------
// nextBottleneck — wrap-onto-self deselect vs normal cycle
// ---------------------------------------------------------------------------

describe('nextBottleneck', () => {
  let store: ReturnType<typeof createKookrStore>;

  beforeEach(() => {
    store = createKookrStore();
    store.setState({ visibleProjectSummaries: [makeProject('org/a'), makeProject('org/b')] });
  });

  test('deselects when the sole finding is already selected (wrap onto self)', () => {
    store.setState({
      agents: [makeFinding('only', 'org/a')],
      selectedAgentId: 'only',
      selectedTaskId: null,
      shortcutsArmed: true,
      focusZone: 'response-input',
    });

    store.getState().nextBottleneck();

    expect(store.getState().selectedAgentId).toBeNull();
    expect(store.getState().selectedTaskId).toBeNull();
    expect(store.getState().focusZone).toBe('none');
    expect(store.getState().shortcutsArmed).toBe(false);
  });

  test('deselects when there are no active findings at all', () => {
    store.setState({
      agents: [makeAgent({ agentId: 'healthy', projectId: 'org/a' })],
      selectedAgentId: 'healthy',
      shortcutsArmed: true,
      focusZone: 'terminal',
    });

    store.getState().nextBottleneck();

    expect(store.getState().selectedAgentId).toBeNull();
    expect(store.getState().focusZone).toBe('none');
    expect(store.getState().shortcutsArmed).toBe(false);
  });

  test('cycles across multiple findings', () => {
    store.setState({
      agents: [makeFinding('f1', 'org/a'), makeFinding('f2', 'org/b')],
      selectedAgentId: null,
      selectedTaskId: null,
    });

    // No selection → land on the first finding in priority order.
    store.getState().nextBottleneck();
    const first = store.getState().selectedAgentId;
    expect(first).not.toBeNull();
    expect(['f1', 'f2']).toContain(first);

    // Next call advances to the other finding rather than wrapping onto self.
    store.getState().nextBottleneck();
    const second = store.getState().selectedAgentId;
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(['f1', 'f2']).toContain(second);
  });
});

// ---------------------------------------------------------------------------
// advanceEmptyEnter — three-way branch
// ---------------------------------------------------------------------------

describe('advanceEmptyEnter', () => {
  let store: ReturnType<typeof createKookrStore>;

  beforeEach(() => {
    store = createKookrStore();
    store.setState({ visibleProjectSummaries: [makeProject('org/a'), makeProject('org/b')] });
  });

  test('zero findings → cycles healthy tasks via nextTask', () => {
    store.setState({
      agents: [
        makeAgent({ agentId: 'h1', projectId: 'org/a' }),
        makeAgent({ agentId: 'h2', projectId: 'org/b' }),
      ],
      selectedAgentId: null,
    });

    store.getState().advanceEmptyEnter();

    const selected = store.getState().selectedAgentId;
    expect(selected).not.toBeNull();
    expect(['h1', 'h2']).toContain(selected);
  });

  test('single finding already selected → stays put', () => {
    store.setState({
      agents: [makeFinding('only', 'org/a')],
      selectedAgentId: 'only',
      selectedTaskId: null,
      shortcutsArmed: true,
    });

    store.getState().advanceEmptyEnter();

    // No deselect, no wrap — the sole finding remains selected.
    expect(store.getState().selectedAgentId).toBe('only');
    expect(store.getState().shortcutsArmed).toBe(true);
  });

  test('multiple findings → cycles among findings via nextBottleneck', () => {
    store.setState({
      agents: [makeFinding('f1', 'org/a'), makeFinding('f2', 'org/b')],
      selectedAgentId: null,
    });

    store.getState().advanceEmptyEnter();
    const first = store.getState().selectedAgentId;
    expect(['f1', 'f2']).toContain(first);

    store.getState().advanceEmptyEnter();
    const second = store.getState().selectedAgentId;
    expect(second).not.toBe(first);
    expect(['f1', 'f2']).toContain(second);
  });
});

// ---------------------------------------------------------------------------
// selectNextTaskAfterCompletion — stale-selection & no-candidate guards
// ---------------------------------------------------------------------------

describe('selectNextTaskAfterCompletion', () => {
  let store: ReturnType<typeof createKookrStore>;

  beforeEach(() => {
    store = createKookrStore();
    store.setState({ visibleProjectSummaries: [makeProject('org/a'), makeProject('org/b')] });
  });

  test('stale selection: user moved on → keeps the newer selection', () => {
    store.setState({
      agents: [makeFinding('completed', 'org/a'), makeFinding('newer', 'org/b')],
      selectedAgentId: 'newer',
      selectedTaskId: null,
      shortcutsArmed: true,
    });

    store.getState().selectNextTaskAfterCompletion('completed', null);

    expect(store.getState().selectedAgentId).toBe('newer');
    // The early-return guard must fire. Without it, execution would fall through
    // to the advance path (which excludes 'completed', leaving 'newer' as the
    // sole candidate and re-selecting it) — masking the guard. activateNavigation-
    // Selection resets shortcutsArmed to false on that path, so asserting it stays
    // true is what actually discriminates "guard ran" from "advanced onto self".
    expect(store.getState().shortcutsArmed).toBe(true);
  });

  test('stale task: excludes the completed task and advances to another task on the same agent', () => {
    // Same agent, but the completion targets a specific task id. The exclude
    // predicate must be task-scoped (drop taskId === completedTaskId), leaving
    // the agent's other routable task as the successor.
    store.setState({
      agents: [
        makeAgent({ agentId: 'agent', projectId: 'org/a', taskId: 'done' }),
        makeAgent({ agentId: 'agent', projectId: 'org/b', taskId: 'todo' }),
      ],
      selectedAgentId: 'agent',
      selectedTaskId: 'done',
    });

    store.getState().selectNextTaskAfterCompletion('agent', 'done');

    expect(store.getState().selectedAgentId).toBe('agent');
    expect(store.getState().selectedTaskId).toBe('todo');
  });

  test('stale task: same agent but a different task is now selected → no advance', () => {
    store.setState({
      agents: [makeFinding('agent', 'org/a')],
      selectedAgentId: 'agent',
      selectedTaskId: 'task-new',
    });

    store.getState().selectNextTaskAfterCompletion('agent', 'task-old');

    expect(store.getState().selectedAgentId).toBe('agent');
    expect(store.getState().selectedTaskId).toBe('task-new');
  });

  test('no remaining candidate: clears selection and focus', () => {
    store.setState({
      agents: [makeAgent({ agentId: 'completed', projectId: 'org/a' })],
      selectedAgentId: 'completed',
      selectedTaskId: null,
      focusZone: 'terminal',
      respondAllAgentIds: ['x'],
      shortcutsArmed: true,
    });

    store.getState().selectNextTaskAfterCompletion('completed', null);

    expect(store.getState().selectedAgentId).toBeNull();
    expect(store.getState().selectedTaskId).toBeNull();
    expect(store.getState().focusZone).toBe('none');
    expect(store.getState().respondAllAgentIds).toBeNull();
    expect(store.getState().shortcutsArmed).toBe(false);
  });

  test('advances to the next routable candidate when one remains', () => {
    store.setState({
      agents: [
        makeAgent({ agentId: 'completed', projectId: 'org/a' }),
        makeAgent({ agentId: 'next', projectId: 'org/b' }),
      ],
      selectedAgentId: 'completed',
      selectedTaskId: null,
    });

    store.getState().selectNextTaskAfterCompletion('completed', null);

    expect(store.getState().selectedAgentId).toBe('next');
  });
});

// ---------------------------------------------------------------------------
// Detail-pane persistence — load / save / legacy migration (mocked localStorage)
//
// The initial detail-pane mode is read once, at slice-construction time
// (createKookrStore → createTriageNavigationSlice → loadDetailPaneMode), so the
// localStorage stub must be installed BEFORE the store is created in each test.
// ---------------------------------------------------------------------------

const DETAIL_PANE_MODE_KEY = 'kookr-detail-panel-mode';
const TERMINAL_FOCUS_KEY = 'kookr-terminal-focus-mode';

function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    impl: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value); },
      removeItem: (key: string) => { map.delete(key); },
    } as Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  };
}

describe('detail-pane persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('loads a persisted pane mode on construction', () => {
    const storage = fakeStorage({ [DETAIL_PANE_MODE_KEY]: 'left' });
    vi.stubGlobal('localStorage', storage.impl);

    const store = createKookrStore();

    expect(store.getState().detailPaneMode).toBe('left');
    expect(store.getState().terminalFocusMode).toBe(false);
  });

  test('defaults to split when nothing is persisted', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage.impl);

    const store = createKookrStore();

    expect(store.getState().detailPaneMode).toBe('split');
  });

  test('setDetailPaneMode persists non-split modes and clears the legacy key', () => {
    // Seed a VALID persisted mode so construction returns it without running
    // the legacy migration — otherwise loadDetailPaneMode would consume the
    // legacy key at construction time and this test would pass without ever
    // exercising saveDetailPaneMode's own removeItem(TERMINAL_FOCUS_KEY).
    const storage = fakeStorage({ [DETAIL_PANE_MODE_KEY]: 'split', [TERMINAL_FOCUS_KEY]: '1' });
    vi.stubGlobal('localStorage', storage.impl);
    const store = createKookrStore();
    // Precondition: the legacy key survived construction untouched.
    expect(storage.map.has(TERMINAL_FOCUS_KEY)).toBe(true);

    store.getState().setDetailPaneMode('left');

    expect(store.getState().detailPaneMode).toBe('left');
    expect(storage.map.get(DETAIL_PANE_MODE_KEY)).toBe('left');
    // saveDetailPaneMode is what drops the legacy key here.
    expect(storage.map.has(TERMINAL_FOCUS_KEY)).toBe(false);
  });

  test('setDetailPaneMode("right") enables terminal focus and switches the narrow tab', () => {
    const storage = fakeStorage();
    vi.stubGlobal('localStorage', storage.impl);
    const store = createKookrStore();

    store.getState().setDetailPaneMode('right');

    expect(store.getState().detailPaneMode).toBe('right');
    expect(store.getState().terminalFocusMode).toBe(true);
    expect(store.getState().narrowTab).toBe('terminal');
    expect(storage.map.get(DETAIL_PANE_MODE_KEY)).toBe('right');
  });

  test('setDetailPaneMode("split") removes the persisted key', () => {
    const storage = fakeStorage({ [DETAIL_PANE_MODE_KEY]: 'right' });
    vi.stubGlobal('localStorage', storage.impl);
    const store = createKookrStore();

    store.getState().setDetailPaneMode('split');

    expect(store.getState().detailPaneMode).toBe('split');
    expect(storage.map.has(DETAIL_PANE_MODE_KEY)).toBe(false);
  });

  test('migrates the legacy terminal-focus flag ("1") to the "right" pane mode', () => {
    const storage = fakeStorage({ [TERMINAL_FOCUS_KEY]: '1' });
    vi.stubGlobal('localStorage', storage.impl);

    const store = createKookrStore();

    expect(store.getState().detailPaneMode).toBe('right');
    expect(store.getState().terminalFocusMode).toBe(true);
    // The migration rewrites the new key and drops the legacy one.
    expect(storage.map.get(DETAIL_PANE_MODE_KEY)).toBe('right');
    expect(storage.map.has(TERMINAL_FOCUS_KEY)).toBe(false);
  });

  test('prunes an invalid persisted value and falls back to split', () => {
    const storage = fakeStorage({ [DETAIL_PANE_MODE_KEY]: 'bogus' });
    vi.stubGlobal('localStorage', storage.impl);
    // Silence the expected warn about the invalid stored value.
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = createKookrStore();

    expect(store.getState().detailPaneMode).toBe('split');
    expect(storage.map.has(DETAIL_PANE_MODE_KEY)).toBe(false);
  });
});
