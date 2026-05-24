import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createKookrStore, type KookrStore } from './useStore.js';
import { __resetDndForTests, disableDnd, enableDnd } from '../hooks/useDnd.js';
import type { AgentState } from '../../shared/protocol.js';

describe('Kookr Zustand Store', () => {
  let store: ReturnType<typeof createKookrStore>;
  let localStore: Map<string, string>;

  beforeEach(() => {
    localStore = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => localStore.get(key) ?? null,
      setItem: (key: string, value: string) => localStore.set(key, value),
      removeItem: (key: string) => localStore.delete(key),
      clear: () => localStore.clear(),
    });
    __resetDndForTests();
    store = createKookrStore();
  });

  afterEach(() => {
    disableDnd();
    __resetDndForTests();
  });

  test('handleSnapshot populates agents', () => {
    const agents: AgentState[] = [
      {
        agentId: 'agent-1',
        events: [],
        anomaly: null,
      },
      {
        agentId: 'agent-2',
        events: [],
        anomaly: {
          agentId: 'agent-2',
          type: 'repeated_error',
          severity: 'critical',
          explanation: 'Stuck',
          detectedAt: new Date(),
        },
      },
    ];

    store.getState().handleSnapshot(agents, '/home/user/project');

    expect(store.getState().agents).toHaveLength(2);
    expect(store.getState().agents[0].agentId).toBe('agent-1');
    expect(store.getState().agents[1].agentId).toBe('agent-2');
  });

  test('handleSnapshot stores serverCwd', () => {
    store.getState().handleSnapshot([], '/home/user/project');

    expect(store.getState().serverCwd).toBe('/home/user/project');
  });

  test('serverCwd defaults to empty string', () => {
    expect(store.getState().serverCwd).toBe('');
  });

  test('handleResourceStatus stores latest resource snapshot and receive time', () => {
    store.getState().handleResourceStatus({
      source: { kind: 'server-host' },
      sampledAt: '2026-05-13T00:00:00.000Z',
      sampleGapMs: null,
      timerDriftMs: null,
      host: {
        cpuUsagePercent: 42,
        memoryUsedPercent: 68,
        memoryFreeBytes: 4_000_000_000,
        memoryTotalBytes: 12_000_000_000,
      },
      server: {
        eventLoopDelayP95Ms: 21,
        processRssBytes: 160_000_000,
        processHeapUsedBytes: 70_000_000,
        processHeapTotalBytes: 100_000_000,
      },
      unavailable: [],
    }, 123);

    expect(store.getState().resourceStatus?.host.cpuUsagePercent).toBe(42);
    expect(store.getState().resourceStatusReceivedAtMs).toBe(123);
  });

  test('handleUpdate updates single agent', () => {
    // First, set initial state
    store.getState().handleSnapshot([
      { agentId: 'agent-1', events: [], anomaly: null },
      { agentId: 'agent-2', events: [], anomaly: null },
    ]);

    // Then update agent-1
    const updatedState: AgentState = {
      agentId: 'agent-1',
      events: [{ type: 'stop', sessionId: 's1', lastMessage: 'help' }],
      anomaly: {
        agentId: 'agent-1',
        type: 'needs_input',
        severity: 'info',
        explanation: 'Waiting for input',
        detectedAt: new Date(),
      },
    };

    store.getState().handleUpdate('agent-1', updatedState);

    const agent1 = store.getState().agents.find((a) => a.agentId === 'agent-1');
    expect(agent1!.anomaly).not.toBeNull();
    expect(agent1!.anomaly!.type).toBe('needs_input');

    // agent-2 unchanged
    const agent2 = store.getState().agents.find((a) => a.agentId === 'agent-2');
    expect(agent2!.anomaly).toBeNull();
  });

  test('handleAlert stores alert for agent', () => {
    store.getState().handleSnapshot([
      { agentId: 'agent-1', events: [], anomaly: null },
    ]);

    store.getState().handleAlert('agent-1', 'Agent is stuck in a loop');

    expect(store.getState().alerts).toHaveLength(1);
    expect(store.getState().alerts[0].agentId).toBe('agent-1');
    expect(store.getState().alerts[0].summary).toBe('Agent is stuck in a loop');
  });

  test('handleAlert stores optional details for recovery guidance', () => {
    store.getState().handleAlert('agent-1', 'Error: launch failed', 'error', 'Run `pnpm run doctor`.');

    expect(store.getState().alerts[0].details).toBe('Run `pnpm run doctor`.');
  });

  test('handleAlert defaults to info severity for non-error messages', () => {
    store.getState().handleAlert('agent-1', 'PR merged');

    expect(store.getState().alerts[0].severity).toBe('info');
  });

  test('handleAlert defaults to error severity for Error: prefix', () => {
    store.getState().handleAlert('agent-1', 'Error: something failed');

    expect(store.getState().alerts[0].severity).toBe('error');
  });

  test('handleAlert accepts explicit severity', () => {
    store.getState().handleAlert('agent-1', 'CI failed', 'error');

    expect(store.getState().alerts[0].severity).toBe('error');
  });

  test('handleAlert explicit severity overrides prefix heuristic', () => {
    store.getState().handleAlert('agent-1', 'Error: recoverable warning', 'info');

    expect(store.getState().alerts[0].severity).toBe('info');
  });

  test('handleAlert is suppressed while Do Not Disturb is on', () => {
    enableDnd();
    try {
      store.getState().handleAlert('agent-1', 'Error: stuck loop');
      expect(store.getState().alerts).toHaveLength(0);
    } finally {
      disableDnd();
    }
  });

  test('handleAlert resumes after Do Not Disturb is turned off', () => {
    enableDnd();
    store.getState().handleAlert('agent-1', 'silenced');
    disableDnd();
    store.getState().handleAlert('agent-1', 'audible');

    expect(store.getState().alerts).toHaveLength(1);
    expect(store.getState().alerts[0].summary).toBe('audible');
  });

  test('selectAgent updates selectedAgentId', () => {
    expect(store.getState().selectedAgentId).toBeNull();

    store.getState().selectAgent('agent-1');
    expect(store.getState().selectedAgentId).toBe('agent-1');

    store.getState().selectAgent('agent-2');
    expect(store.getState().selectedAgentId).toBe('agent-2');
  });

  test('selectAgent resets leftPane and narrowTab to activity', () => {
    store.getState().setLeftPane('github');
    store.getState().setNarrowTab('terminal');
    expect(store.getState().leftPane).toBe('github');
    expect(store.getState().narrowTab).toBe('terminal');

    store.getState().selectAgent('agent-1');
    expect(store.getState().leftPane).toBe('activity');
    expect(store.getState().narrowTab).toBe('activity');
  });

  test('setLeftPane and setNarrowTab update panel state', () => {
    expect(store.getState().leftPane).toBe('activity');
    expect(store.getState().narrowTab).toBe('activity');

    store.getState().setLeftPane('github');
    expect(store.getState().leftPane).toBe('github');

    store.getState().setNarrowTab('terminal');
    expect(store.getState().narrowTab).toBe('terminal');

    store.getState().setNarrowTab('github');
    expect(store.getState().narrowTab).toBe('github');
  });

  test('terminal focus mode persists and moves narrow detail view to terminal', () => {
    expect(store.getState().terminalFocusMode).toBe(false);

    store.getState().setNarrowTab('activity');
    store.getState().setTerminalFocusMode(true);

    expect(store.getState().terminalFocusMode).toBe(true);
    expect(store.getState().narrowTab).toBe('terminal');
    expect(localStore.get('kookr-terminal-focus-mode')).toBe('1');

    const freshStore = createKookrStore();
    expect(freshStore.getState().terminalFocusMode).toBe(true);

    freshStore.getState().toggleTerminalFocusMode();
    expect(freshStore.getState().terminalFocusMode).toBe(false);
    expect(localStore.has('kookr-terminal-focus-mode')).toBe(false);
  });

  test('terminal focus mode still toggles when localStorage persistence fails', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('quota exceeded'); },
      removeItem: () => { throw new Error('blocked'); },
      clear: () => {},
    });
    const freshStore = createKookrStore();

    freshStore.getState().setTerminalFocusMode(true);
    expect(freshStore.getState().terminalFocusMode).toBe(true);
    expect(freshStore.getState().narrowTab).toBe('terminal');

    freshStore.getState().toggleTerminalFocusMode();
    expect(freshStore.getState().terminalFocusMode).toBe(false);
  });

  test('setRelaunchTask stores task data for dialog pre-fill', () => {
    store.getState().setRelaunchTask({
      prompt: 'Fix the auth bug',
      cwd: '/home/user/project',
      criteria: 'Tests pass',
    });

    const task = store.getState().relaunchTask;
    expect(task).not.toBeNull();
    expect(task!.prompt).toBe('Fix the auth bug');
    expect(task!.cwd).toBe('/home/user/project');
    expect(task!.criteria).toBe('Tests pass');
  });

  test('setRelaunchTask stores playbook context for relaunch', () => {
    store.getState().setRelaunchTask({
      prompt: 'Analyze owner/repo',
      cwd: '/home/user/project',
      playbookId: 'analyze.md',
      playbookParameterValues: { repo: 'owner/repo', count: '10' },
    });

    const task = store.getState().relaunchTask;
    expect(task).not.toBeNull();
    expect(task!.playbookId).toBe('analyze.md');
    expect(task!.playbookParameterValues).toEqual({ repo: 'owner/repo', count: '10' });
  });

  test('clearRelaunchTask clears the stored task', () => {
    store.getState().setRelaunchTask({
      prompt: 'Fix bug',
      cwd: '/cwd',
    });
    store.getState().clearRelaunchTask();

    expect(store.getState().relaunchTask).toBeNull();
  });

  test('loads selectedProject from localStorage on store creation', () => {
    localStore.set('kookr-selected-project', 'github.com/example/repo');

    const freshStore = createKookrStore();
    expect(freshStore.getState().selectedProject).toBe('github.com/example/repo');
  });

  test('handleSnapshot preserves task metadata fields', () => {
    const agents: AgentState[] = [
      {
        agentId: 'agent-1',
        events: [],
        anomaly: null,
        taskName: 'Fix auth token refresh',
        cwd: '/home/user/webapp',
        agentType: 'claude-code',
        startedAt: '2026-03-24T10:00:00.000Z',
      },
    ];

    store.getState().handleSnapshot(agents);

    const a = store.getState().agents[0];
    expect(a.taskName).toBe('Fix auth token refresh');
    expect(a.cwd).toBe('/home/user/webapp');
    expect(a.agentType).toBe('claude-code');
    expect(a.startedAt).toBe('2026-03-24T10:00:00.000Z');
  });

  test('handleUpdate preserves task metadata fields', () => {
    store.getState().handleSnapshot([
      {
        agentId: 'agent-1',
        events: [],
        anomaly: null,
        taskName: 'Fix bug',
        cwd: '/cwd',
        agentType: 'claude-code',
        startedAt: '2026-03-24T10:00:00.000Z',
      },
    ]);

    const updated: AgentState = {
      agentId: 'agent-1',
      events: [{ type: 'stop', sessionId: 's1', lastMessage: 'help' }],
      anomaly: {
        agentId: 'agent-1',
        type: 'needs_input',
        severity: 'info',
        explanation: 'Waiting',
        detectedAt: new Date(),
      },
      taskName: 'Fix bug',
      cwd: '/cwd',
      agentType: 'claude-code',
      startedAt: '2026-03-24T10:00:00.000Z',
    };

    store.getState().handleUpdate('agent-1', updated);

    const a = store.getState().agents[0];
    expect(a.taskName).toBe('Fix bug');
    expect(a.startedAt).toBe('2026-03-24T10:00:00.000Z');
  });

  test('handleUpdate moves selection to the next finding when selected task completes', () => {
    store.getState().handleSnapshot([
      {
        agentId: 'agent-done',
        taskId: 'task-done',
        taskStatus: 'inProgress',
        events: [],
        anomaly: null,
      },
      {
        agentId: 'agent-needs-input',
        taskId: 'task-needs-input',
        taskStatus: 'inProgress',
        events: [],
        anomaly: {
          agentId: 'agent-needs-input',
          type: 'needs_input',
          severity: 'warning',
          explanation: 'Waiting',
          detectedAt: new Date(),
        },
      },
    ]);
    store.getState().selectAgent('agent-done');

    store.getState().handleUpdate('agent-done', {
      agentId: 'agent-done',
      taskId: 'task-done',
      taskStatus: 'completed',
      events: [],
      anomaly: null,
    });

    expect(store.getState().selectedAgentId).toBe('agent-needs-input');
  });

  test('handleUpdate clears selection when selected task completes with no remaining findings', () => {
    store.getState().handleSnapshot([
      {
        agentId: 'agent-done',
        taskId: 'task-done',
        taskStatus: 'inProgress',
        events: [],
        anomaly: null,
      },
      {
        agentId: 'agent-healthy',
        taskId: 'task-healthy',
        taskStatus: 'inProgress',
        events: [],
        anomaly: null,
      },
    ]);
    store.getState().selectAgent('agent-done');

    store.getState().handleUpdate('agent-done', {
      agentId: 'agent-done',
      taskId: 'task-done',
      taskStatus: 'completed',
      events: [],
      anomaly: null,
    });

    expect(store.getState().selectedAgentId).toBeNull();
  });

  test('handleUpdate clears selection when selected task is cancelled', () => {
    store.getState().handleSnapshot([
      {
        agentId: 'agent-cancelled',
        taskId: 'task-cancelled',
        taskStatus: 'inProgress',
        events: [],
        anomaly: null,
      },
    ]);
    store.getState().selectAgent('agent-cancelled');

    store.getState().handleUpdate('agent-cancelled', {
      agentId: 'agent-cancelled',
      taskId: 'task-cancelled',
      taskStatus: 'cancelled',
      events: [],
      anomaly: null,
    });

    expect(store.getState().selectedAgentId).toBeNull();
  });

  test('handleUpdate keeps selected terminated task visible for acknowledgement', () => {
    store.getState().handleSnapshot([
      {
        agentId: 'agent-terminated',
        taskId: 'task-terminated',
        taskStatus: 'inProgress',
        events: [],
        anomaly: null,
      },
    ]);
    store.getState().selectAgent('agent-terminated');

    store.getState().handleUpdate('agent-terminated', {
      agentId: 'agent-terminated',
      taskId: 'task-terminated',
      taskStatus: 'terminated',
      events: [],
      anomaly: null,
    });

    expect(store.getState().selectedAgentId).toBe('agent-terminated');
  });

  test('handleSnapshot clears selection when selected task disappears after clear completed', () => {
    store.getState().handleSnapshot([
      {
        agentId: 'agent-cleared',
        taskId: 'task-cleared',
        taskStatus: 'completed',
        events: [],
        anomaly: null,
      },
    ]);
    store.getState().selectAgent('agent-cleared');

    store.getState().handleSnapshot([]);

    expect(store.getState().selectedAgentId).toBeNull();
  });

  test('handleSnapshot preserves explicit completed-task selection while it still exists', () => {
    const completedAgent: AgentState = {
      agentId: 'agent-completed',
      taskId: 'task-completed',
      taskStatus: 'completed',
      events: [],
      anomaly: null,
    };
    store.getState().handleSnapshot([completedAgent]);
    store.getState().selectAgent('agent-completed');

    store.getState().handleSnapshot([{ ...completedAgent, taskName: 'Already done' }]);

    expect(store.getState().selectedAgentId).toBe('agent-completed');
  });

  test('sentOverlay defaults to null', () => {
    expect(store.getState().sentOverlay).toBeNull();
  });

  test('showSentOverlay sets overlay with agent name', () => {
    store.getState().showSentOverlay('Fix auth token refresh');
    expect(store.getState().sentOverlay).toEqual({ agentName: 'Fix auth token refresh' });
  });

  test('clearSentOverlay clears the overlay', () => {
    store.getState().showSentOverlay('Fix bug');
    store.getState().clearSentOverlay();
    expect(store.getState().sentOverlay).toBeNull();
  });

  test('snoozeAgent optimistically sets snoozedUntil on target agent', () => {
    store.getState().handleSnapshot([
      {
        agentId: 'agent-A',
        events: [],
        anomaly: { agentId: 'agent-A', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
      },
      {
        agentId: 'agent-B',
        events: [],
        anomaly: { agentId: 'agent-B', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
      },
    ]);

    store.getState().selectAgent('agent-A');
    store.getState().snoozeAgent('agent-B', 5 * 60 * 1000);

    // agent-B should have snoozedUntil set
    const agentB = store.getState().agents.find((a) => a.agentId === 'agent-B');
    expect(agentB!.snoozedUntil).toBeGreaterThan(Date.now());

    // agent-A should NOT be affected
    const agentA = store.getState().agents.find((a) => a.agentId === 'agent-A');
    expect(agentA!.snoozedUntil).toBeUndefined();
  });

  test('snoozeAgent does not advance selection when snoozed agent is not selected', () => {
    store.getState().handleSnapshot([
      {
        agentId: 'agent-A',
        events: [],
        anomaly: { agentId: 'agent-A', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
      },
      {
        agentId: 'agent-B',
        events: [],
        anomaly: { agentId: 'agent-B', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
      },
    ]);

    store.getState().selectAgent('agent-A');
    store.getState().snoozeAgent('agent-B', 5 * 60 * 1000);

    // Selection should stay on agent-A (the non-snoozed agent)
    expect(store.getState().selectedAgentId).toBe('agent-A');
  });

  test('snoozeAgent advances selection when snoozed agent is the selected one', () => {
    store.getState().handleSnapshot([
      {
        agentId: 'agent-A',
        events: [],
        anomaly: { agentId: 'agent-A', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
      },
      {
        agentId: 'agent-B',
        events: [],
        anomaly: { agentId: 'agent-B', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
      },
    ]);

    store.getState().selectAgent('agent-A');
    store.getState().snoozeAgent('agent-A', 5 * 60 * 1000);

    // Selection should advance to agent-B (the remaining finding)
    expect(store.getState().selectedAgentId).toBe('agent-B');
  });

  test('nextBottleneck selects next urgent agent', () => {
    store.getState().handleSnapshot([
      { agentId: 'agent-1', events: [], anomaly: null },
      {
        agentId: 'agent-2',
        events: [],
        anomaly: {
          agentId: 'agent-2',
          type: 'repeated_error',
          severity: 'critical',
          explanation: 'Stuck',
          detectedAt: new Date(),
        },
      },
      {
        agentId: 'agent-3',
        events: [],
        anomaly: {
          agentId: 'agent-3',
          type: 'needs_input',
          severity: 'info',
          explanation: 'Waiting',
          detectedAt: new Date(),
        },
      },
    ]);

    store.getState().nextBottleneck();

    // Should select the most urgent (critical) agent
    expect(store.getState().selectedAgentId).toBe('agent-2');
  });

  test('nextBottleneck uses task priority when finding severity ties', () => {
    store.getState().handleSnapshot([
      {
        agentId: 'normal-finding',
        events: [],
        anomaly: {
          agentId: 'normal-finding',
          type: 'needs_input',
          severity: 'warning',
          explanation: 'Waiting',
          detectedAt: new Date(),
        },
      },
      {
        agentId: 'high-finding',
        priority: 'high',
        events: [],
        anomaly: {
          agentId: 'high-finding',
          type: 'needs_input',
          severity: 'warning',
          explanation: 'Waiting',
          detectedAt: new Date(),
        },
      },
    ]);

    store.getState().nextBottleneck();

    expect(store.getState().selectedAgentId).toBe('high-finding');
  });

  test('selectProject auto-selects using task priority ordering', () => {
    store.getState().handleProjectSummaries([
      {
        project: 'project-a',
        displayName: 'Project A',
        color: 1,
        activeAgents: 2,
        findingCount: 2,
        todayPrCount: 0,
        weekPrCount: 0,
        openPrs: 0,
        recentTasks: [],
      },
    ]);
    store.getState().handleSnapshot([
      {
        agentId: 'normal-project-finding',
        projectId: 'project-a',
        events: [],
        anomaly: { agentId: 'normal-project-finding', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
      },
      {
        agentId: 'high-project-finding',
        projectId: 'project-a',
        priority: 'high',
        events: [],
        anomaly: { agentId: 'high-project-finding', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
      },
    ]);

    store.getState().selectProject('project-a');

    expect(store.getState().selectedAgentId).toBe('high-project-finding');
  });

  test('nextBottleneck clears selection when only one finding remains', () => {
    store.getState().handleSnapshot([
      {
        agentId: 'only-finding',
        events: [],
        anomaly: {
          agentId: 'only-finding',
          type: 'repeated_error',
          severity: 'critical',
          explanation: 'Stuck',
          detectedAt: new Date(),
        },
      },
    ]);

    // Select the only finding
    store.getState().selectAgent('only-finding');
    expect(store.getState().selectedAgentId).toBe('only-finding');

    // nextBottleneck should clear selection (would cycle back to same)
    store.getState().nextBottleneck();
    expect(store.getState().selectedAgentId).toBeNull();
  });

  test('nextBottleneck clears selection when no findings exist', () => {
    store.getState().handleSnapshot([
      { agentId: 'healthy-1', events: [], anomaly: null },
    ]);

    store.getState().selectAgent('healthy-1');
    store.getState().nextBottleneck();
    expect(store.getState().selectedAgentId).toBeNull();
  });

  test('nextBottleneck disarms shortcuts', () => {
    store.getState().handleSnapshot([
      {
        agentId: 'agent-A',
        events: [],
        anomaly: { agentId: 'agent-A', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
      },
      {
        agentId: 'agent-B',
        events: [],
        anomaly: { agentId: 'agent-B', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
      },
    ]);

    // Shortcuts start armed
    expect(store.getState().shortcutsArmed).toBe(true);

    store.getState().selectAgent('agent-A');
    store.getState().nextBottleneck();

    // After switch, shortcuts should be disarmed
    expect(store.getState().shortcutsArmed).toBe(false);
    expect(store.getState().selectedAgentId).toBe('agent-B');
  });

  test('armShortcuts re-arms after nextBottleneck disarms', () => {
    store.getState().handleSnapshot([
      {
        agentId: 'agent-A',
        events: [],
        anomaly: { agentId: 'agent-A', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
      },
      {
        agentId: 'agent-B',
        events: [],
        anomaly: { agentId: 'agent-B', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
      },
    ]);

    store.getState().selectAgent('agent-A');
    store.getState().nextBottleneck();
    expect(store.getState().shortcutsArmed).toBe(false);

    store.getState().armShortcuts();
    expect(store.getState().shortcutsArmed).toBe(true);
  });

  test('nextBottleneck disarms shortcuts even when clearing selection', () => {
    store.getState().handleSnapshot([
      { agentId: 'healthy-1', events: [], anomaly: null },
    ]);

    store.getState().selectAgent('healthy-1');
    store.getState().nextBottleneck();
    expect(store.getState().selectedAgentId).toBeNull();
    expect(store.getState().shortcutsArmed).toBe(false);
  });

  test('nextTask cycles through findings then healthy in round-robin', () => {
    store.getState().handleSnapshot([
      { agentId: 'healthy-1', events: [], anomaly: null },
      {
        agentId: 'finding-1',
        events: [],
        anomaly: {
          agentId: 'finding-1',
          type: 'repeated_error',
          severity: 'critical',
          explanation: 'Stuck',
          detectedAt: new Date(),
        },
      },
      { agentId: 'healthy-2', events: [], anomaly: null },
    ]);

    // First call: no selection → selects first (finding-1, sorted by severity)
    store.getState().nextTask();
    expect(store.getState().selectedAgentId).toBe('finding-1');

    // Second call: advances to healthy-1
    store.getState().nextTask();
    expect(store.getState().selectedAgentId).toBe('healthy-1');

    // Third call: advances to healthy-2
    store.getState().nextTask();
    expect(store.getState().selectedAgentId).toBe('healthy-2');

    // Fourth call: wraps around to finding-1
    store.getState().nextTask();
    expect(store.getState().selectedAgentId).toBe('finding-1');
  });

  test('nextTask and previousTask follow priority ordering used by visible buckets', () => {
    store.getState().handleProjectSummaries([
      {
        project: 'project-a',
        displayName: 'Project A',
        color: 1,
        activeAgents: 1,
        findingCount: 1,
        todayPrCount: 0,
        weekPrCount: 0,
        openPrs: 0,
        recentTasks: [],
      },
      {
        project: 'project-b',
        displayName: 'Project B',
        color: 2,
        activeAgents: 1,
        findingCount: 1,
        todayPrCount: 0,
        weekPrCount: 0,
        openPrs: 0,
        recentTasks: [],
      },
    ]);
    store.getState().pinProjectToTop('project-b');
    store.getState().handleSnapshot([
      {
        agentId: 'normal-a',
        projectId: 'project-a',
        events: [],
        anomaly: { agentId: 'normal-a', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
      },
      {
        agentId: 'high-a',
        projectId: 'project-a',
        priority: 'high',
        events: [],
        anomaly: { agentId: 'high-a', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
      },
      {
        agentId: 'healthy-b',
        projectId: 'project-b',
        events: [],
        anomaly: null,
      },
    ]);

    store.getState().nextTask();
    expect(store.getState().selectedAgentId).toBe('high-a');

    store.getState().nextTask();
    expect(store.getState().selectedAgentId).toBe('normal-a');

    store.getState().nextTask();
    expect(store.getState().selectedAgentId).toBe('healthy-b');

    store.getState().previousTask();
    expect(store.getState().selectedAgentId).toBe('normal-a');
  });

  test('previousTask cycles backwards through findings then healthy', () => {
    store.getState().handleSnapshot([
      { agentId: 'healthy-1', events: [], anomaly: null },
      {
        agentId: 'finding-1',
        events: [],
        anomaly: {
          agentId: 'finding-1',
          type: 'repeated_error',
          severity: 'critical',
          explanation: 'Stuck',
          detectedAt: new Date(),
        },
      },
      { agentId: 'healthy-2', events: [], anomaly: null },
    ]);

    // First call: no selection → selects last (healthy-2)
    store.getState().previousTask();
    expect(store.getState().selectedAgentId).toBe('healthy-2');

    // Second call: goes to healthy-1
    store.getState().previousTask();
    expect(store.getState().selectedAgentId).toBe('healthy-1');

    // Third call: goes to finding-1
    store.getState().previousTask();
    expect(store.getState().selectedAgentId).toBe('finding-1');

    // Fourth call: wraps around to healthy-2
    store.getState().previousTask();
    expect(store.getState().selectedAgentId).toBe('healthy-2');
  });

  test('handleProjectSummaries derives visible sidebar order from persisted prefs', () => {
    localStore.set('kookr:projectSidebarPrefs', JSON.stringify({
      ordered: ['github.com/b', 'github.com/a'],
      hidden: ['github.com/a'],
    }));

    const freshStore = createKookrStore();
    freshStore.getState().handleProjectSummaries([
      {
        project: 'github.com/a',
        displayName: 'owner/a',
        color: 1,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openPrs: 0,
        recentTasks: [],
      },
      {
        project: 'github.com/b',
        displayName: 'owner/b',
        color: 2,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openPrs: 0,
        recentTasks: [],
      },
    ]);

    expect(freshStore.getState().visibleProjectSummaries.map((project) => project.project)).toEqual([
      'github.com/b',
    ]);
    expect(freshStore.getState().projectSidebarRows).toEqual([
      expect.objectContaining({ project: 'github.com/b', hidden: false, pinned: false }),
      expect.objectContaining({ project: 'github.com/a', hidden: true, pinned: false }),
    ]);
  });

  test('hideSidebarProject clears selected project and hides it from visible summaries', () => {
    store.getState().handleProjectSummaries([
      {
        project: 'github.com/example/repo',
        displayName: 'example/repo',
        color: 1,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openPrs: 0,
        recentTasks: [],
      },
    ]);

    store.getState().selectProject('github.com/example/repo');
    store.getState().hideSidebarProject('github.com/example/repo');

    expect(store.getState().selectedProject).toBeNull();
    expect(localStore.has('kookr-selected-project')).toBe(false);
    expect(store.getState().visibleProjectSummaries).toEqual([]);
  });

  test('showSidebarProject restores a hidden project to its prior order', () => {
    store.getState().handleProjectSummaries([
      {
        project: 'github.com/a',
        displayName: 'owner/a',
        color: 1,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openPrs: 0,
        recentTasks: [],
      },
      {
        project: 'github.com/b',
        displayName: 'owner/b',
        color: 2,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openPrs: 0,
        recentTasks: [],
      },
      {
        project: 'github.com/c',
        displayName: 'owner/c',
        color: 3,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openPrs: 0,
        recentTasks: [],
      },
    ]);

    store.getState().pinProjectToTop('github.com/c');
    store.getState().hideSidebarProject('github.com/b');
    store.getState().showSidebarProject('github.com/b');

    expect(store.getState().visibleProjectSummaries.map((project) => project.project)).toEqual([
      'github.com/c',
      'github.com/a',
      'github.com/b',
    ]);
    expect(store.getState().projectSidebarRows.find((row) => row.project === 'github.com/c')?.pinned).toBe(true);
  });

  test('unpinSidebarProject removes a project from the pinned section without hiding it', () => {
    store.getState().handleProjectSummaries([
      {
        project: 'github.com/a',
        displayName: 'owner/a',
        color: 1,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openPrs: 0,
        recentTasks: [],
      },
      {
        project: 'github.com/b',
        displayName: 'owner/b',
        color: 2,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openPrs: 0,
        recentTasks: [],
      },
    ]);

    store.getState().pinProjectToTop('github.com/b');
    store.getState().unpinSidebarProject('github.com/b');

    expect(store.getState().visibleProjectSummaries.map((project) => project.project)).toEqual([
      'github.com/b',
      'github.com/a',
    ]);
    expect(store.getState().projectSidebarRows.find((row) => row.project === 'github.com/b')?.pinned).toBe(false);
  });

  test('reorderSidebarProject can move an unpinned project into the pinned section', () => {
    store.getState().handleProjectSummaries([
      {
        project: 'github.com/a',
        displayName: 'owner/a',
        color: 1,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openPrs: 0,
        recentTasks: [],
      },
      {
        project: 'github.com/b',
        displayName: 'owner/b',
        color: 2,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openPrs: 0,
        recentTasks: [],
      },
      {
        project: 'github.com/c',
        displayName: 'owner/c',
        color: 3,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openPrs: 0,
        recentTasks: [],
      },
    ]);

    store.getState().pinProjectToTop('github.com/a');
    store.getState().reorderSidebarProject('github.com/c', true, 'github.com/a', 'before');

    expect(store.getState().visibleProjectSummaries.map((project) => project.project)).toEqual([
      'github.com/c',
      'github.com/a',
      'github.com/b',
    ]);
    expect(store.getState().projectSidebarRows.find((row) => row.project === 'github.com/c')?.pinned).toBe(true);
  });

  test('resetProjectSidebar restores server order and clears selection', () => {
    store.getState().handleProjectSummaries([
      {
        project: 'github.com/a',
        displayName: 'owner/a',
        color: 1,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openPrs: 0,
        recentTasks: [],
      },
      {
        project: 'github.com/b',
        displayName: 'owner/b',
        color: 2,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openPrs: 0,
        recentTasks: [],
      },
    ]);
    store.getState().pinProjectToTop('github.com/b');
    store.getState().selectProject('github.com/b');

    store.getState().resetProjectSidebar();

    expect(store.getState().selectedProject).toBeNull();
    expect(store.getState().visibleProjectSummaries.map((project) => project.project)).toEqual([
      'github.com/a',
      'github.com/b',
    ]);
  });

  // --- Workspace slice ---

  test('workspaceEnabled defaults to false', () => {
    expect(store.getState().workspaceEnabled).toBe(false);
  });

  test('handleSnapshot sets workspaceEnabled', () => {
    store.getState().handleSnapshot([], '/cwd', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, true);
    expect(store.getState().workspaceEnabled).toBe(true);
  });

  test('handleSnapshot without workspaceEnabled keeps existing value', () => {
    store.getState().handleSnapshot([], '/cwd', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, true);
    store.getState().handleSnapshot([], '/cwd');
    expect(store.getState().workspaceEnabled).toBe(true);
  });

  // --- Capacity (sticky maxActiveTasks) ---

  test('maxActiveTasks defaults to 0 (unknown until first snapshot)', () => {
    expect(store.getState().maxActiveTasks).toBe(0);
  });

  test('handleSnapshot sets maxActiveTasks', () => {
    store.getState().handleSnapshot([], '/cwd', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 7);
    expect(store.getState().maxActiveTasks).toBe(7);
  });

  test('handleSnapshot without maxActiveTasks keeps existing value (sticky)', () => {
    store.getState().handleSnapshot([], '/cwd', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 12);
    // A subsequent snapshot from a broadcast site that doesn't thread the
    // getter must not zero out the cap — the indicator depends on stickiness.
    store.getState().handleSnapshot([], '/cwd');
    expect(store.getState().maxActiveTasks).toBe(12);
  });

  test('handleSnapshot stores coordinator detector output state', () => {
    store.getState().handleSnapshot(
      [],
      '/cwd',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { outputs: [{ detectorId: 'duplicate', taskId: 'task-1', evidence: { peerTaskIds: ['task-2'] } }], chips: [], findings: [], chains: {} },
    );
    expect(store.getState().coordinator).toEqual({
      outputs: [{ detectorId: 'duplicate', taskId: 'task-1', evidence: { peerTaskIds: ['task-2'] } }],
      chips: [],
      findings: [],
      chains: {},
    });
  });

  test('handleWorkspaceView stores view and clears loading', () => {
    store.getState().setWorkspaceLoading(true);
    store.getState().handleWorkspaceView({
      projectId: 'github.com/org/repo',
      displayName: 'org/repo',
      policy: 'known_policy',
      candidates: [],
      recentAttempts: [],
      activeLeases: [],
    });
    expect(store.getState().workspaceView?.projectId).toBe('github.com/org/repo');
    expect(store.getState().workspaceLoading).toBe(false);
    expect(store.getState().workspaceError).toBeNull();
  });

  test('handleWorkspaceCleanupDetail stores detail and clears detail loading', () => {
    store.getState().setWorkspaceCleanupDetailLoading(true);
    store.getState().handleWorkspaceCleanupDetail('/wt', {
      projectId: 'github.com/org/repo',
      worktreePath: '/wt',
      branch: 'feature/test',
      classification: 'unique_commits',
      reasonCode: 'has_unique_commits',
      fingerprint: 'fresh',
      capabilities: {
        canSafeRemove: false,
        canRemovePathKeepBranch: true,
        canReviewedDiscard: true,
        requiresDirtyRecovery: false,
        defaultActionLabel: 'Review cleanup options',
        riskSummary: 'Has local-only commits.',
      },
    });
    expect(store.getState().workspaceCleanupDetail?.worktreePath).toBe('/wt');
    expect(store.getState().workspaceCleanupDetailLoading).toBe(false);
    expect(store.getState().workspaceCleanupDetailError).toBeNull();
  });

  test('setWorkspaceLoading toggles loading state', () => {
    expect(store.getState().workspaceLoading).toBe(false);
    store.getState().setWorkspaceLoading(true);
    expect(store.getState().workspaceLoading).toBe(true);
  });

  test('setWorkspaceError sets error message', () => {
    store.getState().setWorkspaceError('something broke');
    expect(store.getState().workspaceError).toBe('something broke');
  });

  test('clearWorkspaceView resets view and error', () => {
    store.getState().handleWorkspaceView({
      projectId: 'proj',
      displayName: 'proj',
      policy: 'known_policy',
      candidates: [],
      recentAttempts: [],
      activeLeases: [],
    });
    store.getState().setWorkspaceError('err');
    store.getState().clearWorkspaceView();
    expect(store.getState().workspaceView).toBeNull();
    expect(store.getState().workspaceError).toBeNull();
  });

  test('handleWorkspaceView with cleanupResult fires success alert', () => {
    store.getState().handleWorkspaceView(
      { projectId: 'p', displayName: 'p', policy: 'known_policy', candidates: [], recentAttempts: [], activeLeases: [] },
      undefined,
      { branch: 'feat/done', disposition: 'completed', pathRemoved: true, branchRemoved: true },
    );
    const alerts = store.getState().alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].summary).toContain('feat/done');
    expect(alerts[0].severity).toBe('info');
  });

  test('handleWorkspaceView with cleanupResult fires error alert for prune_failed', () => {
    store.getState().handleWorkspaceView(
      { projectId: 'p', displayName: 'p', policy: 'known_policy', candidates: [], recentAttempts: [], activeLeases: [] },
      undefined,
      { branch: 'feat/x', disposition: 'prune_failed', pathRemoved: true, branchRemoved: false, errorKind: 'prune_failed' },
    );
    const alerts = store.getState().alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('error');
  });

  test('handleWorkspaceView without cleanupResult does not fire alert', () => {
    store.getState().handleWorkspaceView(
      { projectId: 'p', displayName: 'p', policy: 'known_policy', candidates: [], recentAttempts: [], activeLeases: [] },
    );
    expect(store.getState().alerts).toHaveLength(0);
  });

  test('handleWorkspaceView with cleanupResults fires alerts for bulk cleanup', () => {
    store.getState().handleWorkspaceView(
      { projectId: 'p', displayName: 'p', policy: 'known_policy', candidates: [], recentAttempts: [], activeLeases: [] },
      undefined,
      undefined,
      [
        { branch: 'feat/a', disposition: 'completed', pathRemoved: true, branchRemoved: true },
        { branch: 'feat/b', disposition: 'path_removed_branch_retained', pathRemoved: true, branchRemoved: false, retainedReason: 'user_requested_keep_branch' },
      ],
    );
    const alerts = store.getState().alerts;
    expect(alerts).toHaveLength(2);
    expect(alerts[0].summary).toContain('feat/a');
    expect(alerts[1].summary).toContain('feat/b');
  });

  test('handleWorkspaceView with diagnosticLaunch fires an info alert', () => {
    store.getState().handleWorkspaceView(
      { projectId: 'p', displayName: 'p', policy: 'known_policy', candidates: [], recentAttempts: [], activeLeases: [] },
      undefined,
      undefined,
      undefined,
      { worktreePath: '/wt', taskId: 'task-9', queued: false },
    );
    const alerts = store.getState().alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].summary).toContain('task-9');
    expect(alerts[0].severity).toBe('info');
  });

  describe('selectProject auto-select finding', () => {
    const anomaly = {
      agentId: 'agent-1',
      type: 'permission_blocked' as const,
      severity: 'critical' as const,
      explanation: 'Needs permission',
      detectedAt: new Date(),
    };

    function seedAgents(agents: AgentState[]) {
      store.getState().handleSnapshot(agents, '/home/user/project');
    }

    test('auto-selects sole finding when switching to project with exactly 1 finding', () => {
      seedAgents([
        { agentId: 'agent-1', events: [], anomaly, projectId: 'proj-a', taskStatus: 'running' },
        { agentId: 'agent-2', events: [], anomaly: null, projectId: 'proj-a', taskStatus: 'running' },
      ]);

      store.getState().selectProject('proj-a');

      expect(store.getState().selectedAgentId).toBe('agent-1');
    });

    test('falls back to healthy running task when project has 0 findings', () => {
      seedAgents([
        { agentId: 'agent-1', events: [], anomaly: null, projectId: 'proj-a', taskStatus: 'running' },
      ]);

      store.getState().selectProject('proj-a');

      expect(store.getState().selectedAgentId).toBe('agent-1');
    });

    test('selects highest-severity finding when project has 2+ findings', () => {
      const warningAnomaly = { ...anomaly, agentId: 'agent-1', severity: 'warning' as const };
      const criticalAnomaly = { ...anomaly, agentId: 'agent-2', severity: 'critical' as const };
      seedAgents([
        { agentId: 'agent-1', events: [], anomaly: warningAnomaly, projectId: 'proj-a', taskStatus: 'running' },
        { agentId: 'agent-2', events: [], anomaly: criticalAnomaly, projectId: 'proj-a', taskStatus: 'running' },
      ]);

      store.getState().selectProject('proj-a');

      expect(store.getState().selectedAgentId).toBe('agent-2');
    });

    test('findings take priority over healthy running tasks', () => {
      seedAgents([
        { agentId: 'agent-healthy', events: [], anomaly: null, projectId: 'proj-a', taskStatus: 'running' },
        { agentId: 'agent-finding', events: [], anomaly: { ...anomaly, agentId: 'agent-finding' }, projectId: 'proj-a', taskStatus: 'running' },
      ]);

      store.getState().selectProject('proj-a');

      expect(store.getState().selectedAgentId).toBe('agent-finding');
    });

    test('does not fall back to terminal-status tasks', () => {
      seedAgents([
        { agentId: 'agent-1', events: [], anomaly: null, projectId: 'proj-a', taskStatus: 'completed' },
      ]);

      store.getState().selectProject('proj-a');

      expect(store.getState().selectedAgentId).toBeNull();
    });

    test('does not fall back to pending tasks', () => {
      seedAgents([
        { agentId: 'agent-1', events: [], anomaly: null, projectId: 'proj-a', taskStatus: 'pending' },
      ]);

      store.getState().selectProject('proj-a');

      expect(store.getState().selectedAgentId).toBeNull();
    });

    test('does not fall back to snoozed or suppressed healthy tasks', () => {
      seedAgents([
        { agentId: 'agent-snoozed', events: [], anomaly: null, projectId: 'proj-a', taskStatus: 'running', snoozedUntil: Date.now() + 60_000 },
        { agentId: 'agent-suppressed', events: [], anomaly: null, projectId: 'proj-a', taskStatus: 'running', suppressed: true },
      ]);

      store.getState().selectProject('proj-a');

      expect(store.getState().selectedAgentId).toBeNull();
    });

    test('clears selectedAgentId when deselecting project (null)', () => {
      seedAgents([
        { agentId: 'agent-1', events: [], anomaly, projectId: 'proj-a', taskStatus: 'running' },
      ]);
      store.getState().selectProject('proj-a');
      expect(store.getState().selectedAgentId).toBe('agent-1');

      store.getState().selectProject(null);

      expect(store.getState().selectedAgentId).toBeNull();
    });

    test('skips snoozed findings', () => {
      seedAgents([
        { agentId: 'agent-1', events: [], anomaly, projectId: 'proj-a', taskStatus: 'running', snoozedUntil: Date.now() + 60_000 },
      ]);

      store.getState().selectProject('proj-a');

      expect(store.getState().selectedAgentId).toBeNull();
    });

    test('skips pending tasks', () => {
      seedAgents([
        { agentId: 'agent-1', events: [], anomaly, projectId: 'proj-a', taskStatus: 'pending' },
      ]);

      store.getState().selectProject('proj-a');

      expect(store.getState().selectedAgentId).toBeNull();
    });

    test('skips suppressed findings', () => {
      seedAgents([
        { agentId: 'agent-1', events: [], anomaly, projectId: 'proj-a', taskStatus: 'running', suppressed: true },
      ]);

      store.getState().selectProject('proj-a');

      expect(store.getState().selectedAgentId).toBeNull();
    });

    test('replaces previous selection when switching projects', () => {
      seedAgents([
        { agentId: 'agent-1', events: [], anomaly, projectId: 'proj-a', taskStatus: 'running' },
        { agentId: 'agent-2', events: [], anomaly: { ...anomaly, agentId: 'agent-2' }, projectId: 'proj-b', taskStatus: 'running' },
      ]);

      store.getState().selectProject('proj-a');
      expect(store.getState().selectedAgentId).toBe('agent-1');

      store.getState().selectProject('proj-b');
      expect(store.getState().selectedAgentId).toBe('agent-2');
    });
  });
});
