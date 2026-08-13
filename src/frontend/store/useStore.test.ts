import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createKookrStore, type KookrStore } from './useStore.js';
import { __resetDndForTests, disableDnd, enableDnd } from '../hooks/useDnd.js';
import type { AgentState } from '../../shared/protocol.js';
import { getBugReportAlerts, resetBugReportRecorderForTests } from '../bug-report-recorder.js';
import {
  __resetSelectionTransitionRecorderForTests,
  getSelectionTransitionDiagnostics,
} from '../selection-transition-recorder.js';
import {
  clearDebugTimeline,
  getDebugTimelineEntries,
  setDebugTimelineEnabledForTests,
} from '../debug-timeline.js';

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
    resetBugReportRecorderForTests();
    __resetSelectionTransitionRecorderForTests();
    setDebugTimelineEnabledForTests(null);
    clearDebugTimeline();
    store = createKookrStore();
  });

  afterEach(() => {
    disableDnd();
    __resetDndForTests();
    setDebugTimelineEnabledForTests(null);
    clearDebugTimeline();
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

  test('debug timeline records store mutations and finding lifecycle through the store setter', () => {
    setDebugTimelineEnabledForTests(true);
    store = createKookrStore();

    store.getState().handleSnapshot([{ agentId: 'agent-1', events: [], anomaly: null }]);
    store.getState().handleUpdate('agent-1', {
      agentId: 'agent-1',
      events: [],
      anomaly: {
        agentId: 'agent-1',
        type: 'needs_input',
        severity: 'warning',
        explanation: 'Sensitive customer context',
        detectedAt: new Date('2026-06-05T00:00:00.000Z'),
      },
    });

    const entries = getDebugTimelineEntries();
    expect(entries.some((entry) => entry.kind === 'store' && entry.tags.includes('agents'))).toBe(true);
    expect(entries.some((entry) => entry.kind === 'finding-lifecycle' && entry.summary.includes('created needs_input'))).toBe(true);
    expect(JSON.stringify(entries)).not.toContain('Sensitive customer context');
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
        dataDirectory: {
          path: '/tmp/kookr-data',
          diskFreeBytes: 8_000_000_000,
          diskTotalBytes: 100_000_000_000,
          diskFreePercent: 8,
        },
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

  test('handleOpsHealth stores smoke-tick, resourceWatchdog, capacity residual, pipeline starvation, launch deps, and schedules projections', () => {
    expect(store.getState().prodSmokeTick).toBeNull();
    expect(store.getState().resourceWatchdog).toBeNull();
    expect(store.getState().capacityResidual).toBeNull();
    expect(store.getState().pipelineStarvation).toBeNull();
    expect(store.getState().launchDependencies).toBeNull();
    expect(store.getState().schedules).toBeNull();
    expect(store.getState().lessonYield).toBeNull();

    store.getState().handleOpsHealth({
      prodSmokeTick: { consecutiveFailures: 2, status: 'alert', failingChecks: ['health'] },
      resourceWatchdog: { enabled: false, lastDecision: 'disabled' },
      capacityResidual: { finishedAwaitingAck: 7, oldestFinishedAwaitingAckAgeMs: 9e6 },
      pipelineStarvation: {
        schemaVersion: 'pipeline-starvation.v1',
        repos: {
          'kookr-ai/kookr': {
            repo: 'kookr-ai/kookr',
            consecutiveBlockedEmpty: 2,
            effectiveScoutCooldownMs: 1_800_000,
          },
        },
      },
      launchDependencies: {
        totalDegradedTasks: 8,
        totalFindings: 9,
        dependencies: [
          { dependency: 'kb', degradedTaskCount: 8, categories: ['provider_api'] },
        ],
      },
      schedules: {
        schedulesPausedByFailure: [
          { id: 's1', name: 'orchestrator', consecutiveFailures: 30 },
        ],
      },
      lessonYield: {
        windowDays: 1,
        yieldRate: 0.75,
        decided: 3,
        completedInWindow: 4,
        buckets: { wroteLesson: 2, explicitSkip: 1, searchOnly: 0, noKbActivity: 1 },
      },
    });

    expect(store.getState().prodSmokeTick).toEqual({
      consecutiveFailures: 2,
      status: 'alert',
      failingChecks: ['health'],
    });
    expect(store.getState().resourceWatchdog).toEqual({
      enabled: false,
      lastDecision: 'disabled',
    });
    expect(store.getState().capacityResidual).toEqual({
      finishedAwaitingAck: 7,
      oldestFinishedAwaitingAckAgeMs: 9e6,
    });
    expect(store.getState().pipelineStarvation?.repos['kookr-ai/kookr']?.consecutiveBlockedEmpty).toBe(2);
    expect(store.getState().launchDependencies).toEqual({
      totalDegradedTasks: 8,
      totalFindings: 9,
      dependencies: [
        { dependency: 'kb', degradedTaskCount: 8, categories: ['provider_api'] },
      ],
    });
    expect(store.getState().schedules).toEqual({
      schedulesPausedByFailure: [
        { id: 's1', name: 'orchestrator', consecutiveFailures: 30 },
      ],
    });
    expect(store.getState().lessonYield).toEqual({
      windowDays: 1,
      yieldRate: 0.75,
      decided: 3,
      completedInWindow: 4,
      buckets: { wroteLesson: 2, explicitSkip: 1, searchOnly: 0, noKbActivity: 1 },
    });

    // Partial update: only smoke — watchdog + capacity residual + starvation + launch deps + schedules left alone.
    store.getState().handleOpsHealth({
      prodSmokeTick: { consecutiveFailures: 0, status: 'ok' },
    });
    expect(store.getState().prodSmokeTick?.consecutiveFailures).toBe(0);
    expect(store.getState().resourceWatchdog?.enabled).toBe(false);
    expect(store.getState().capacityResidual?.finishedAwaitingAck).toBe(7);
    expect(store.getState().pipelineStarvation?.repos['kookr-ai/kookr']?.consecutiveBlockedEmpty).toBe(2);
    expect(store.getState().launchDependencies?.totalDegradedTasks).toBe(8);
    expect(store.getState().schedules?.schedulesPausedByFailure).toHaveLength(1);
    expect(store.getState().lessonYield?.yieldRate).toBe(0.75);
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

  test('handleDelta upserts, removes, and merges aggregates (#1754 Stage 2)', () => {
    store.getState().handleSnapshot([
      { agentId: 'agent-1', taskId: 't1', events: [], anomaly: null },
      { agentId: 'agent-2', taskId: 't2', events: [], anomaly: null },
    ]);

    store.getState().handleDelta({
      agents: {
        upserts: [
          { agentId: 'agent-1', taskId: 't1', events: [], anomaly: null, taskName: 'renamed' },
          { agentId: 'agent-3', taskId: 't3', events: [], anomaly: null, taskName: 'new' },
        ],
        removed: ['agent-2:t2'],
      },
      aggregates: { totalSpendUsd: 12.5, maxActiveTasks: 4 },
      taskRelations: [],
    });

    const agents = store.getState().agents;
    expect(agents.map((a) => a.agentId).sort()).toEqual(['agent-1', 'agent-3']);
    expect(agents.find((a) => a.agentId === 'agent-1')?.taskName).toBe('renamed');
    expect(store.getState().totalSpendUsd).toBe(12.5);
    expect(store.getState().maxActiveTasks).toBe(4);
    expect(store.getState().taskRelations).toEqual([]);
  });

  test('handleAlert stores alert for agent', () => {
    store.getState().handleSnapshot([
      { agentId: 'agent-1', events: [], anomaly: null },
    ]);

    store.getState().handleAlert('agent-1', 'Agent is stuck in a loop');

    expect(store.getState().alerts).toHaveLength(1);
    expect(store.getState().alerts[0].agentId).toBe('agent-1');
    expect(store.getState().alerts[0].summary).toBe('Agent is stuck in a loop');
    expect(getBugReportAlerts()[0]).toMatchObject({
      agentId: 'agent-1',
      summaryCategory: 'general',
    });
  });

  test('dismissAlert does not remove reportable alert history', () => {
    store.getState().handleAlert('agent-1', 'Malformed WebSocket message', 'error', 'payload failed schema validation');

    store.getState().dismissAlert(0);

    expect(store.getState().alerts).toHaveLength(0);
    expect(getBugReportAlerts()).toHaveLength(1);
    expect(getBugReportAlerts()[0].summaryCategory).toBe('malformed_websocket');
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
      expect(getBugReportAlerts()).toHaveLength(1);
      expect(getBugReportAlerts()[0].summary).toBe('Error: stuck loop');
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

  describe('handleAlert focus guard (F20)', () => {
    function seedTwoAgents() {
      store.getState().handleSnapshot([
        { agentId: 'agent-focused', events: [], anomaly: null },
        { agentId: 'agent-other', events: [], anomaly: null },
      ]);
      store.getState().selectAgent('agent-focused');
    }

    test('suppresses toast from a different agent while composing in the reply input', () => {
      seedTwoAgents();
      store.getState().setFocusZone('response-input');

      store.getState().handleAlert('agent-other', 'Agent is stuck in a loop');

      expect(store.getState().alerts).toHaveLength(0);
      // Still recorded for the bug-report history — only the popup is dropped.
      expect(getBugReportAlerts()).toHaveLength(1);
    });

    test('suppresses toast from a different agent while composing in the terminal', () => {
      seedTwoAgents();
      store.getState().setFocusZone('terminal');

      store.getState().handleAlert('agent-other', 'Error: repeated failure', 'error');

      expect(store.getState().alerts).toHaveLength(0);
    });

    test('shows toast from the focused agent while composing', () => {
      seedTwoAgents();
      store.getState().setFocusZone('response-input');

      store.getState().handleAlert('agent-focused', 'Needs your input');

      expect(store.getState().alerts).toHaveLength(1);
      expect(store.getState().alerts[0].agentId).toBe('agent-focused');
    });

    test('shows toast from another agent when not composing', () => {
      seedTwoAgents();
      expect(store.getState().focusZone).toBe('none');

      store.getState().handleAlert('agent-other', 'Agent is stuck in a loop');

      expect(store.getState().alerts).toHaveLength(1);
    });

    test('shows non-agent alerts (empty / workspace ids) even while composing', () => {
      seedTwoAgents();
      store.getState().setFocusZone('response-input');

      store.getState().handleAlert('', 'Message not sent — connection lost.', 'error');
      store.getState().handleAlert('workspace', 'Sweep complete');

      expect(store.getState().alerts).toHaveLength(2);
    });
  });

  test('selectAgent updates selectedAgentId', () => {
    expect(store.getState().selectedAgentId).toBeNull();

    store.getState().selectAgent('agent-1');
    expect(store.getState().selectedAgentId).toBe('agent-1');

    store.getState().selectAgent('agent-2');
    expect(store.getState().selectedAgentId).toBe('agent-2');
  });

  test('selectAgent records bounded selection transition diagnostics', () => {
    store.getState().handleSnapshot([
      { agentId: 'agent-1', taskId: 'task-1', events: [], anomaly: null, taskStatus: 'inProgress' },
      { agentId: 'agent-2', taskId: 'task-2', events: [], anomaly: null, taskStatus: 'inProgress' },
    ]);

    store.getState().selectAgent('agent-1');
    store.getState().selectAgent('agent-2');

    expect(getSelectionTransitionDiagnostics().transitions.at(-1)).toMatchObject({
      fromTaskId: 'task-1',
      toTaskId: 'task-2',
      fromSessionId: 'agent-1',
      toSessionId: 'agent-2',
      source: 'selectAgent',
    });
  });

  test('nextTask records navigation-specific selection transition diagnostics', () => {
    store.getState().handleSnapshot([
      { agentId: 'agent-1', taskId: 'task-1', events: [], anomaly: null, taskStatus: 'inProgress' },
      { agentId: 'agent-2', taskId: 'task-2', events: [], anomaly: null, taskStatus: 'inProgress' },
    ]);

    store.getState().selectAgent('agent-1');
    store.getState().nextTask();

    expect(getSelectionTransitionDiagnostics().transitions.at(-1)).toMatchObject({
      fromTaskId: 'task-1',
      toTaskId: 'task-2',
      source: 'nextTask',
      reason: 'cycle_routable_tasks',
    });
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

  test('selectAgent persists the selected task for reload restore', () => {
    store.getState().handleSnapshot([
      {
        agentId: 'agent-1',
        taskId: 'task-1',
        events: [],
        anomaly: null,
      },
    ]);

    store.getState().selectAgent('agent-1');

    expect(JSON.parse(localStore.get('kookr-selected-task') ?? 'null')).toMatchObject({
      taskId: 'task-1',
      agentId: 'agent-1',
    });

    store.getState().selectAgent(null);

    expect(localStore.has('kookr-selected-task')).toBe(false);
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

  test('detail pane mode persists and keeps terminal focus mode compatible', () => {
    expect(store.getState().terminalFocusMode).toBe(false);
    expect(store.getState().detailPaneMode).toBe('split');

    store.getState().setNarrowTab('activity');
    store.getState().setDetailPaneMode('right');

    expect(store.getState().terminalFocusMode).toBe(true);
    expect(store.getState().detailPaneMode).toBe('right');
    expect(store.getState().narrowTab).toBe('terminal');
    expect(localStore.get('kookr-detail-panel-mode')).toBe('right');

    const freshStore = createKookrStore();
    expect(freshStore.getState().terminalFocusMode).toBe(true);
    expect(freshStore.getState().detailPaneMode).toBe('right');

    freshStore.getState().toggleTerminalFocusMode();
    expect(freshStore.getState().terminalFocusMode).toBe(false);
    expect(freshStore.getState().detailPaneMode).toBe('split');
    expect(localStore.has('kookr-detail-panel-mode')).toBe(false);
  });

  test('left detail pane mode persists without enabling terminal focus mode', () => {
    store.getState().setDetailPaneMode('left');

    expect(store.getState().detailPaneMode).toBe('left');
    expect(store.getState().terminalFocusMode).toBe(false);
    expect(localStore.get('kookr-detail-panel-mode')).toBe('left');

    const freshStore = createKookrStore();
    expect(freshStore.getState().detailPaneMode).toBe('left');
    expect(freshStore.getState().terminalFocusMode).toBe(false);
  });

  test('legacy terminal focus preference migrates to right detail pane mode', () => {
    localStore.set('kookr-terminal-focus-mode', '1');

    const freshStore = createKookrStore();

    expect(freshStore.getState().detailPaneMode).toBe('right');
    expect(freshStore.getState().terminalFocusMode).toBe(true);
    expect(localStore.get('kookr-detail-panel-mode')).toBe('right');
    expect(localStore.has('kookr-terminal-focus-mode')).toBe(false);
  });

  test('saving detail pane mode clears stale legacy terminal focus preference', () => {
    localStore.set('kookr-terminal-focus-mode', '1');

    store.getState().setDetailPaneMode('split');

    expect(store.getState().detailPaneMode).toBe('split');
    expect(localStore.has('kookr-detail-panel-mode')).toBe(false);
    expect(localStore.has('kookr-terminal-focus-mode')).toBe(false);
  });

  test('invalid persisted detail pane mode falls back to split', () => {
    localStore.set('kookr-detail-panel-mode', 'sideways');
    localStore.set('kookr-terminal-focus-mode', '1');

    const freshStore = createKookrStore();

    expect(freshStore.getState().detailPaneMode).toBe('split');
    expect(freshStore.getState().terminalFocusMode).toBe(false);
    expect(localStore.has('kookr-detail-panel-mode')).toBe(false);
    expect(localStore.get('kookr-terminal-focus-mode')).toBe('1');
  });

  test('detail pane mode still toggles when localStorage persistence fails', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('quota exceeded'); },
      removeItem: () => { throw new Error('blocked'); },
      clear: () => {},
    });
    const freshStore = createKookrStore();

    freshStore.getState().setTerminalFocusMode(true);
    expect(freshStore.getState().detailPaneMode).toBe('right');
    expect(freshStore.getState().terminalFocusMode).toBe(true);
    expect(freshStore.getState().narrowTab).toBe('terminal');

    freshStore.getState().toggleTerminalFocusMode();
    expect(freshStore.getState().detailPaneMode).toBe('split');
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

  test('selectedProject defaults to null when localStorage getItem fails', () => {
    vi.spyOn(globalThis.localStorage, 'getItem').mockImplementation((key: string) => {
      if (key === 'kookr-selected-project') {
        throw new DOMException('blocked', 'SecurityError');
      }
      return localStore.get(key) ?? null;
    });

    const freshStore = createKookrStore();

    expect(freshStore.getState().selectedProject).toBeNull();
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

  test('handleUpdate applies task-scoped updates only to the matching sibling row', () => {
    store.getState().handleSnapshot([
      { agentId: 'shared-session', taskId: 'task-a', taskName: 'Task A', taskStatus: 'inProgress', events: [], anomaly: null },
      { agentId: 'shared-session', taskId: 'task-b', taskName: 'Task B', taskStatus: 'inProgress', events: [], anomaly: null },
    ]);

    store.getState().handleUpdate('shared-session', {
      agentId: 'shared-session',
      taskId: 'task-b',
      taskName: 'Task B updated',
      taskStatus: 'completed',
      events: [],
      anomaly: null,
    });

    expect(store.getState().agents.find((agent) => agent.taskId === 'task-a')).toMatchObject({
      taskName: 'Task A',
      taskStatus: 'inProgress',
    });
    expect(store.getState().agents.find((agent) => agent.taskId === 'task-b')).toMatchObject({
      taskName: 'Task B updated',
      taskStatus: 'completed',
    });
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

  test('handleSnapshot clears selection when selected sibling task disappears', () => {
    store.getState().handleSnapshot([
      { agentId: 'shared-session', taskId: 'task-a', taskStatus: 'inProgress', events: [], anomaly: null },
      { agentId: 'shared-session', taskId: 'task-b', taskStatus: 'inProgress', events: [], anomaly: null },
    ]);
    store.getState().selectAgent('shared-session', 'task-a');

    store.getState().handleSnapshot([
      { agentId: 'shared-session', taskId: 'task-b', taskStatus: 'inProgress', events: [], anomaly: null },
    ]);

    expect(store.getState().selectedAgentId).toBeNull();
    expect(store.getState().selectedTaskId).toBeNull();
  });

  test('handleSnapshot does not merge sibling task activity by session id', () => {
    store.getState().handleSnapshot([
      { agentId: 'shared-session', taskId: 'task-a', taskStatus: 'inProgress', events: [{ type: 'output', text: 'task a' }], anomaly: null },
    ]);

    store.getState().handleSnapshot([
      { agentId: 'shared-session', taskId: 'task-b', taskStatus: 'inProgress', events: [], anomaly: null },
    ]);

    expect(store.getState().agents).toHaveLength(1);
    expect(store.getState().agents[0].taskId).toBe('task-b');
    expect(store.getState().agents[0].events).toEqual([]);
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

  test('handleSnapshot restores the persisted selected task on first hydration', () => {
    localStore.set('kookr-selected-task', JSON.stringify({
      taskId: 'task-2',
      agentId: 'old-session-for-task-2',
      selectedAt: 123,
    }));
    const freshStore = createKookrStore();

    freshStore.getState().handleSnapshot([
      { agentId: 'agent-1', taskId: 'task-1', events: [], anomaly: null },
      { agentId: 'agent-2', taskId: 'task-2', events: [], anomaly: null },
    ]);

    expect(freshStore.getState().selectedAgentId).toBe('agent-2');
    expect(freshStore.getState().selectedAgentSource).toBe('manual');
    expect(freshStore.getState().alerts).toHaveLength(0);
    expect(JSON.parse(localStore.get('kookr-selected-task') ?? 'null')).toMatchObject({
      taskId: 'task-2',
      agentId: 'agent-2',
    });
  });

  test('handleSnapshot restores persisted agent-only selection on first hydration', () => {
    localStore.set('kookr-selected-task', JSON.stringify({
      taskId: null,
      agentId: 'agent-1',
      selectedAt: 123,
    }));
    const freshStore = createKookrStore();

    freshStore.getState().handleSnapshot([
      { agentId: 'agent-1', events: [], anomaly: null },
    ]);

    expect(freshStore.getState().selectedAgentId).toBe('agent-1');
    expect(freshStore.getState().selectedAgentSource).toBe('manual');
    expect(freshStore.getState().alerts).toHaveLength(0);
    expect(JSON.parse(localStore.get('kookr-selected-task') ?? 'null')).toMatchObject({
      taskId: null,
      agentId: 'agent-1',
    });
  });

  test('handleSnapshot clears stale persisted selection with a visible fallback alert', () => {
    localStore.set('kookr-selected-task', JSON.stringify({
      taskId: 'task-missing',
      agentId: 'agent-missing',
      selectedAt: 123,
    }));
    const freshStore = createKookrStore();

    freshStore.getState().handleSnapshot([
      { agentId: 'agent-live', taskId: 'task-live', events: [], anomaly: null },
    ]);

    expect(freshStore.getState().selectedAgentId).toBeNull();
    expect(localStore.has('kookr-selected-task')).toBe(false);
    expect(freshStore.getState().alerts).toHaveLength(1);
    expect(freshStore.getState().alerts[0]).toMatchObject({
      agentId: 'workspace',
      summary: 'Previously watched task finished or was removed.',
      severity: 'info',
    });
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

  describe('advanceEmptyEnter (empty-Enter navigation cursor)', () => {
    const finding = (agentId: string, severity: 'critical' | 'warning' | 'info' = 'warning') => ({
      agentId,
      events: [],
      anomaly: { agentId, type: 'needs_input' as const, severity, explanation: 'Waiting', detectedAt: new Date() },
    });
    const healthy = (agentId: string) => ({ agentId, events: [], anomaly: null });

    test('cycles among findings (never lands on a healthy task) while findings exist', () => {
      store.getState().handleSnapshot([finding('f-1', 'critical'), finding('f-2', 'warning'), healthy('h-1')]);
      store.getState().selectAgent('f-1');

      store.getState().advanceEmptyEnter();

      expect(store.getState().selectedAgentId).toBe('f-2');
    });

    test('cycles back to the first finding from the last (never deselects while findings exist)', () => {
      // f-1 (critical) sorts ahead of f-2 (warning). Selecting the last finding
      // and advancing must wrap to the first — NOT deselect to null, which would
      // violate the "cycle findings while any exist" contract.
      store.getState().handleSnapshot([finding('f-1', 'critical'), finding('f-2', 'warning')]);
      store.getState().selectAgent('f-2');

      store.getState().advanceEmptyEnter();

      expect(store.getState().selectedAgentId).toBe('f-1');
    });

    test('stays on the sole finding when it is already selected', () => {
      store.getState().handleSnapshot([finding('f-1'), healthy('h-1'), healthy('h-2')]);
      store.getState().selectAgent('f-1');

      store.getState().advanceEmptyEnter();

      expect(store.getState().selectedAgentId).toBe('f-1');
    });

    test('jumps from a healthy task to a finding when one exists', () => {
      store.getState().handleSnapshot([healthy('h-1'), finding('f-1')]);
      store.getState().selectAgent('h-1');

      store.getState().advanceEmptyEnter();

      expect(store.getState().selectedAgentId).toBe('f-1');
    });

    test('with no findings, cycles through healthy tasks', () => {
      store.getState().handleSnapshot([healthy('h-1'), healthy('h-2')]);
      store.getState().selectAgent('h-1');

      store.getState().advanceEmptyEnter();

      expect(store.getState().selectedAgentId).toBe('h-2');
    });

    test('with nothing selected, advances into the highest-priority finding', () => {
      store.getState().handleSnapshot([healthy('h-1'), finding('f-1', 'critical')]);
      store.getState().selectAgent(null);

      store.getState().advanceEmptyEnter();

      expect(store.getState().selectedAgentId).toBe('f-1');
    });

    test('with nothing selected and no findings, advances into a healthy task', () => {
      store.getState().handleSnapshot([healthy('h-1'), healthy('h-2')]);
      store.getState().selectAgent(null);

      store.getState().advanceEmptyEnter();

      expect(store.getState().selectedAgentId).toBe('h-1');
    });
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
        openContributionAttempts: 0,
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

  test('nextBottleneck selects and persists the target project', () => {
    store.getState().handleProjectSummaries([
      { project: 'proj-a', displayName: 'Project A', color: 1, activeAgents: 1, findingCount: 1, todayPrCount: 0, weekPrCount: 0, openContributionAttempts: 0, recentTasks: [] },
      { project: 'proj-b', displayName: 'Project B', color: 2, activeAgents: 1, findingCount: 1, todayPrCount: 0, weekPrCount: 0, openContributionAttempts: 0, recentTasks: [] },
    ]);
    store.getState().handleSnapshot([
      {
        agentId: 'agent-A',
        events: [],
        anomaly: { agentId: 'agent-A', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
        projectId: 'proj-a',
      },
      {
        agentId: 'agent-B',
        events: [],
        anomaly: { agentId: 'agent-B', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
        projectId: 'proj-b',
      },
    ]);

    store.getState().selectProject('proj-a');
    expect(store.getState().selectedAgentId).toBe('agent-A');
    store.setState({ selectedAgentSource: 'auto-advance' });

    store.getState().nextBottleneck();

    expect(store.getState().selectedAgentId).toBe('agent-B');
    expect(store.getState().selectedAgentSource).toBe('manual');
    expect(store.getState().selectedProject).toBe('proj-b');
    expect(localStore.get('kookr-selected-project')).toBe('proj-b');
  });

  test('nextBottleneck selects the target project when localStorage persistence fails', () => {
    store.getState().handleProjectSummaries([
      { project: 'proj-a', displayName: 'Project A', color: 1, activeAgents: 1, findingCount: 1, todayPrCount: 0, weekPrCount: 0, openContributionAttempts: 0, recentTasks: [] },
      { project: 'proj-b', displayName: 'Project B', color: 2, activeAgents: 1, findingCount: 1, todayPrCount: 0, weekPrCount: 0, openContributionAttempts: 0, recentTasks: [] },
    ]);
    store.getState().handleSnapshot([
      {
        agentId: 'agent-A',
        events: [],
        anomaly: { agentId: 'agent-A', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
        projectId: 'proj-a',
      },
      {
        agentId: 'agent-B',
        events: [],
        anomaly: { agentId: 'agent-B', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
        projectId: 'proj-b',
      },
    ]);
    store.getState().selectProject('proj-a');
    vi.spyOn(globalThis.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    store.getState().nextBottleneck();

    expect(store.getState().selectedAgentId).toBe('agent-B');
    expect(store.getState().selectedProject).toBe('proj-b');
  });

  test('nextBottleneck falls back to All Projects when the target project is hidden', () => {
    store.getState().handleProjectSummaries([
      { project: 'proj-a', displayName: 'Project A', color: 1, activeAgents: 1, findingCount: 1, todayPrCount: 0, weekPrCount: 0, openContributionAttempts: 0, recentTasks: [] },
      { project: 'proj-b', displayName: 'Project B', color: 2, activeAgents: 1, findingCount: 1, todayPrCount: 0, weekPrCount: 0, openContributionAttempts: 0, recentTasks: [] },
    ]);
    store.getState().hideSidebarProject('proj-b');
    store.getState().handleSnapshot([
      {
        agentId: 'agent-A',
        events: [],
        anomaly: { agentId: 'agent-A', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
        projectId: 'proj-a',
      },
      {
        agentId: 'agent-B',
        events: [],
        anomaly: { agentId: 'agent-B', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
        projectId: 'proj-b',
      },
    ]);
    store.getState().selectProject('proj-a');

    store.getState().nextBottleneck();

    expect(store.getState().selectedAgentId).toBe('agent-B');
    expect(store.getState().selectedProject).toBeNull();
    expect(localStore.get('kookr-selected-project')).toBeUndefined();
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
        openContributionAttempts: 0,
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
        openContributionAttempts: 0,
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
    expect(store.getState().selectedProject).toBe('project-a');
    expect(localStore.get('kookr-selected-project')).toBe('project-a');

    store.getState().nextTask();
    expect(store.getState().selectedAgentId).toBe('normal-a');
    expect(store.getState().selectedProject).toBe('project-a');
    expect(localStore.get('kookr-selected-project')).toBe('project-a');

    store.getState().nextTask();
    expect(store.getState().selectedAgentId).toBe('healthy-b');
    expect(store.getState().selectedProject).toBe('project-b');
    expect(localStore.get('kookr-selected-project')).toBe('project-b');

    store.getState().previousTask();
    expect(store.getState().selectedAgentId).toBe('normal-a');
    expect(store.getState().selectedProject).toBe('project-a');
    expect(localStore.get('kookr-selected-project')).toBe('project-a');
  });

  test('nextTask selects and persists the target project', () => {
    store.getState().handleProjectSummaries([
      { project: 'proj-a', displayName: 'Project A', color: 1, activeAgents: 1, findingCount: 1, todayPrCount: 0, weekPrCount: 0, openContributionAttempts: 0, recentTasks: [] },
      { project: 'proj-b', displayName: 'Project B', color: 2, activeAgents: 1, findingCount: 0, todayPrCount: 0, weekPrCount: 0, openContributionAttempts: 0, recentTasks: [] },
    ]);
    store.getState().handleSnapshot([
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
        projectId: 'proj-a',
      },
      { agentId: 'healthy-1', events: [], anomaly: null, projectId: 'proj-b' },
    ]);

    store.getState().selectAgent('finding-1');
    store.setState({ selectedAgentSource: 'auto-advance' });
    store.getState().nextTask();

    expect(store.getState().selectedAgentId).toBe('healthy-1');
    expect(store.getState().selectedAgentSource).toBe('manual');
    expect(store.getState().selectedProject).toBe('proj-b');
    expect(localStore.get('kookr-selected-project')).toBe('proj-b');
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

  test('previousTask selects and persists the target project', () => {
    store.getState().handleProjectSummaries([
      { project: 'proj-a', displayName: 'Project A', color: 1, activeAgents: 1, findingCount: 1, todayPrCount: 0, weekPrCount: 0, openContributionAttempts: 0, recentTasks: [] },
      { project: 'proj-b', displayName: 'Project B', color: 2, activeAgents: 1, findingCount: 0, todayPrCount: 0, weekPrCount: 0, openContributionAttempts: 0, recentTasks: [] },
    ]);
    store.getState().handleSnapshot([
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
        projectId: 'proj-a',
      },
      { agentId: 'healthy-1', events: [], anomaly: null, projectId: 'proj-b' },
    ]);

    store.getState().selectAgent('finding-1');
    store.setState({ selectedAgentSource: 'auto-advance' });
    store.getState().previousTask();

    expect(store.getState().selectedAgentId).toBe('healthy-1');
    expect(store.getState().selectedAgentSource).toBe('manual');
    expect(store.getState().selectedProject).toBe('proj-b');
    expect(localStore.get('kookr-selected-project')).toBe('proj-b');
  });

  test('nextTask skips tasks in terminal statuses (completed/terminated/cancelled)', () => {
    store.getState().handleSnapshot([
      { agentId: 'completed-1', events: [], anomaly: null, taskStatus: 'completed' },
      { agentId: 'healthy-1', events: [], anomaly: null, taskStatus: 'inProgress' },
      { agentId: 'terminated-1', events: [], anomaly: null, taskStatus: 'terminated' },
      { agentId: 'cancelled-1', events: [], anomaly: null, taskStatus: 'cancelled' },
      { agentId: 'healthy-2', events: [], anomaly: null, taskStatus: 'inProgress' },
    ]);

    store.getState().nextTask();
    expect(store.getState().selectedAgentId).toBe('healthy-1');

    store.getState().nextTask();
    expect(store.getState().selectedAgentId).toBe('healthy-2');

    store.getState().nextTask();
    expect(store.getState().selectedAgentId).toBe('healthy-1');
  });

  test('nextTask skips pending tasks', () => {
    store.getState().handleSnapshot([
      { agentId: 'pending-1', events: [], anomaly: null, taskStatus: 'pending' },
      { agentId: 'healthy-1', events: [], anomaly: null, taskStatus: 'inProgress' },
    ]);

    store.getState().nextTask();
    expect(store.getState().selectedAgentId).toBe('healthy-1');

    store.getState().nextTask();
    expect(store.getState().selectedAgentId).toBe('healthy-1');
  });

  test('nextTask skips snoozed tasks', () => {
    store.getState().handleSnapshot([
      { agentId: 'snoozed-1', events: [], anomaly: null, taskStatus: 'inProgress', snoozedUntil: Date.now() + 60_000 },
      { agentId: 'healthy-1', events: [], anomaly: null, taskStatus: 'inProgress' },
    ]);

    store.getState().nextTask();
    expect(store.getState().selectedAgentId).toBe('healthy-1');

    store.getState().nextTask();
    expect(store.getState().selectedAgentId).toBe('healthy-1');
  });

  test('nextTask and previousTask navigate sibling rows with the same session id', () => {
    store.getState().handleSnapshot([
      { agentId: 'shared-session', taskId: 'task-a', events: [], anomaly: null, taskStatus: 'inProgress' },
      { agentId: 'shared-session', taskId: 'task-b', events: [], anomaly: null, taskStatus: 'inProgress' },
    ]);
    store.getState().selectAgent('shared-session', 'task-a');

    store.getState().nextTask();
    expect(store.getState().selectedAgentId).toBe('shared-session');
    expect(store.getState().selectedTaskId).toBe('task-b');

    store.getState().previousTask();
    expect(store.getState().selectedAgentId).toBe('shared-session');
    expect(store.getState().selectedTaskId).toBe('task-a');
  });

  test('nextTask from a completed task advances to the first active candidate', () => {
    store.getState().handleSnapshot([
      { agentId: 'completed-1', events: [], anomaly: null, taskStatus: 'completed' },
      {
        agentId: 'finding-1',
        events: [],
        anomaly: { agentId: 'finding-1', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
        taskStatus: 'inProgress',
      },
      { agentId: 'healthy-1', events: [], anomaly: null, taskStatus: 'inProgress' },
    ]);

    store.getState().selectAgent('completed-1');
    store.getState().nextTask();

    expect(store.getState().selectedAgentId).toBe('finding-1');
  });

  test('selectNextTaskAfterCompletion prefers active findings over healthy tasks', () => {
    store.getState().handleSnapshot([
      { agentId: 'completed-session', taskId: 'task-done', events: [], anomaly: null, taskStatus: 'inProgress' },
      { agentId: 'healthy-1', taskId: 'task-healthy', events: [], anomaly: null, taskStatus: 'inProgress' },
      {
        agentId: 'finding-1',
        taskId: 'task-finding',
        events: [],
        anomaly: { agentId: 'finding-1', type: 'needs_input', severity: 'warning', explanation: 'Waiting', detectedAt: new Date() },
        taskStatus: 'inProgress',
      },
    ]);
    store.getState().selectAgent('completed-session');

    store.getState().selectNextTaskAfterCompletion('completed-session', 'task-done');

    expect(store.getState().selectedAgentId).toBe('finding-1');
  });

  test('selectNextTaskAfterCompletion clears selection when no routable tasks remain', () => {
    store.getState().handleSnapshot([
      { agentId: 'completed-session', taskId: 'task-done', events: [], anomaly: null, taskStatus: 'inProgress' },
      { agentId: 'pending-1', taskId: 'task-pending', events: [], anomaly: null, taskStatus: 'pending' },
    ]);
    store.getState().selectAgent('completed-session');

    store.getState().selectNextTaskAfterCompletion('completed-session', 'task-done');

    expect(store.getState().selectedAgentId).toBeNull();
  });

  test('selectNextTaskAfterCompletion skips sibling sessions for the completed task', () => {
    store.getState().handleSnapshot([
      { agentId: 'completed-session-1', taskId: 'task-done', events: [], anomaly: null, taskStatus: 'inProgress' },
      { agentId: 'completed-session-2', taskId: 'task-done', events: [], anomaly: null, taskStatus: 'inProgress' },
      { agentId: 'healthy-1', taskId: 'task-next', events: [], anomaly: null, taskStatus: 'inProgress' },
    ]);
    store.getState().selectAgent('completed-session-1');

    store.getState().selectNextTaskAfterCompletion('completed-session-1', 'task-done');

    expect(store.getState().selectedAgentId).toBe('healthy-1');
  });

  test('selectNextTaskAfterCompletion advances to a sibling row with a different task id', () => {
    store.getState().handleSnapshot([
      { agentId: 'shared-session', taskId: 'task-done', events: [], anomaly: null, taskStatus: 'inProgress' },
      { agentId: 'shared-session', taskId: 'task-next', events: [], anomaly: null, taskStatus: 'inProgress' },
    ]);
    store.getState().selectAgent('shared-session', 'task-done');

    store.getState().selectNextTaskAfterCompletion('shared-session', 'task-done');

    expect(store.getState().selectedAgentId).toBe('shared-session');
    expect(store.getState().selectedTaskId).toBe('task-next');
  });

  test('selectNextTaskAfterCompletion ignores stale completion when focus moved to a sibling task', () => {
    store.getState().handleSnapshot([
      { agentId: 'shared-session', taskId: 'task-done', events: [], anomaly: null, taskStatus: 'inProgress' },
      { agentId: 'shared-session', taskId: 'task-next', events: [], anomaly: null, taskStatus: 'inProgress' },
      { agentId: 'healthy-1', taskId: 'task-healthy', events: [], anomaly: null, taskStatus: 'inProgress' },
    ]);
    store.getState().selectAgent('shared-session', 'task-next');

    store.getState().selectNextTaskAfterCompletion('shared-session', 'task-done');

    expect(store.getState().selectedAgentId).toBe('shared-session');
    expect(store.getState().selectedTaskId).toBe('task-next');
  });

  test('previousTask skips tasks in terminal statuses', () => {
    store.getState().handleSnapshot([
      { agentId: 'completed-1', events: [], anomaly: null, taskStatus: 'completed' },
      { agentId: 'healthy-1', events: [], anomaly: null, taskStatus: 'inProgress' },
      { agentId: 'healthy-2', events: [], anomaly: null, taskStatus: 'inProgress' },
    ]);

    store.getState().previousTask();
    expect(store.getState().selectedAgentId).toBe('healthy-2');

    store.getState().previousTask();
    expect(store.getState().selectedAgentId).toBe('healthy-1');

    store.getState().previousTask();
    expect(store.getState().selectedAgentId).toBe('healthy-2');
  });

  test('nextBottleneck skips findings attached to terminal-status tasks', () => {
    store.getState().handleSnapshot([
      {
        agentId: 'finding-on-completed',
        events: [],
        anomaly: {
          agentId: 'finding-on-completed',
          type: 'repeated_error',
          severity: 'critical',
          explanation: 'Stuck',
          detectedAt: new Date(),
        },
        taskStatus: 'completed',
      },
      {
        agentId: 'finding-active',
        events: [],
        anomaly: {
          agentId: 'finding-active',
          type: 'needs_input',
          severity: 'warning',
          explanation: 'Waiting',
          detectedAt: new Date(),
        },
        taskStatus: 'inProgress',
      },
    ]);

    store.getState().nextBottleneck();
    expect(store.getState().selectedAgentId).toBe('finding-active');
  });

  test('nextBottleneck clears selection when every finding is on a terminal-status task', () => {
    // Negative assertion for the terminal-status filter: with no active
    // findings, nextBottleneck must not land on the excluded finding-on-
    // completed task. Without the filter, priority ordering alone could
    // make the positive test above pass even if the filter regressed.
    store.getState().handleSnapshot([
      {
        agentId: 'finding-on-completed',
        events: [],
        anomaly: {
          agentId: 'finding-on-completed',
          type: 'repeated_error',
          severity: 'critical',
          explanation: 'Stuck',
          detectedAt: new Date(),
        },
        taskStatus: 'completed',
      },
    ]);

    store.getState().selectAgent('finding-on-completed');
    store.getState().nextBottleneck();

    expect(store.getState().selectedAgentId).toBeNull();
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
        openContributionAttempts: 0,
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
        openContributionAttempts: 0,
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
        openContributionAttempts: 0,
        recentTasks: [],
      },
    ]);

    store.getState().selectProject('github.com/example/repo');
    store.getState().hideSidebarProject('github.com/example/repo');

    expect(store.getState().selectedProject).toBeNull();
    expect(localStore.has('kookr-selected-project')).toBe(false);
    expect(store.getState().visibleProjectSummaries).toEqual([]);
  });

  test('hideSidebarProject clears selected project when localStorage removal fails', () => {
    store.getState().handleProjectSummaries([
      {
        project: 'github.com/example/repo',
        displayName: 'example/repo',
        color: 1,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openContributionAttempts: 0,
        recentTasks: [],
      },
    ]);
    store.getState().selectProject('github.com/example/repo');
    vi.spyOn(globalThis.localStorage, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    store.getState().hideSidebarProject('github.com/example/repo');

    expect(store.getState().selectedProject).toBeNull();
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
        openContributionAttempts: 0,
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
        openContributionAttempts: 0,
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
        openContributionAttempts: 0,
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
        openContributionAttempts: 0,
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
        openContributionAttempts: 0,
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
        openContributionAttempts: 0,
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
        openContributionAttempts: 0,
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
        openContributionAttempts: 0,
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
        openContributionAttempts: 0,
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
        openContributionAttempts: 0,
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

  test('resetProjectSidebar clears selection when localStorage removal fails', () => {
    store.getState().handleProjectSummaries([
      {
        project: 'github.com/a',
        displayName: 'owner/a',
        color: 1,
        activeAgents: 0,
        findingCount: 0,
        todayPrCount: 0,
        weekPrCount: 0,
        openContributionAttempts: 0,
        recentTasks: [],
      },
    ]);
    store.getState().selectProject('github.com/a');
    vi.spyOn(globalThis.localStorage, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    store.getState().resetProjectSidebar();

    expect(store.getState().selectedProject).toBeNull();
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

  test('bypassAllPermissions defaults to false', () => {
    expect(store.getState().bypassAllPermissions).toBe(false);
  });

  test('handleSnapshot sets and clears bypassAllPermissions from current snapshot', () => {
    store.getState().handleSnapshot([], '/cwd', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, true);
    expect(store.getState().bypassAllPermissions).toBe(true);

    store.getState().handleSnapshot([], '/cwd');
    expect(store.getState().bypassAllPermissions).toBe(false);
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

  test('handleSweepComplete reports workspace-unavailable sweeps as errors', () => {
    store.getState().setSweepRunning(true);
    store.getState().handleSweepComplete({
      runId: '',
      startedAt: '2026-06-21T05:00:00.000Z',
      finishedAt: '2026-06-21T05:00:00.000Z',
      projects: [{
        kind: 'skipped',
        projectId: '',
        reason: 'workspace_unavailable',
        missingDeps: ['attemptRepository'],
      }],
    });

    expect(store.getState().sweepRunning).toBe(false);
    const alerts = store.getState().alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('error');
    expect(alerts[0].summary).toContain('Sweep unavailable');
    expect(alerts[0].summary).not.toContain('attemptRepository');
  });

  test('handleSweepProgress tracks live cursor and terminal counts', () => {
    store.getState().handleSweepProgress({
      type: 'workspaceSweepProgress',
      runId: 'run-1',
      startedAt: '2026-06-21T05:00:00.000Z',
      index: 1,
      total: 2,
      projectId: 'github.com/acme/a',
      status: 'running',
      counts: { done: 0, skipped: 0, failed: 0 },
    });

    expect(store.getState().sweepRunning).toBe(true);
    expect(store.getState().sweepProgress?.projectId).toBe('github.com/acme/a');
    expect(store.getState().sweepProgress?.counts).toEqual({ done: 0, skipped: 0, failed: 0 });

    store.getState().handleSweepProgress({
      type: 'workspaceSweepProgress',
      runId: 'run-1',
      startedAt: '2026-06-21T05:00:00.000Z',
      index: 1,
      total: 2,
      projectId: 'github.com/acme/a',
      status: 'done',
      counts: { done: 1, skipped: 0, failed: 0 },
      result: { kind: 'ok', projectId: 'github.com/acme/a', summaries: [], elapsedMs: 1 },
    });
    store.getState().handleSweepProgress({
      type: 'workspaceSweepProgress',
      runId: 'run-1',
      startedAt: '2026-06-21T05:00:00.000Z',
      index: 2,
      total: 2,
      projectId: 'github.com/acme/b',
      status: 'failed',
      counts: { done: 1, skipped: 0, failed: 1 },
      result: { kind: 'failed', projectId: 'github.com/acme/b', code: 'error', message: 'boom', elapsedMs: 1 },
    });

    expect(store.getState().sweepProgress?.counts).toEqual({ done: 1, skipped: 0, failed: 1 });

    store.getState().handleSweepComplete({
      runId: 'run-1',
      startedAt: '2026-06-21T05:00:00.000Z',
      finishedAt: '2026-06-21T05:00:02.000Z',
      projects: [],
    });

    expect(store.getState().sweepRunning).toBe(false);
    expect(store.getState().sweepProgress).toBeNull();
  });

  test('handleSweepComplete stores the disk-aware report and opens the panel', () => {
    const report = {
      runId: 'run-1',
      generatedAt: '2026-06-21T05:00:02.000Z',
      thresholdDays: 14,
      rows: [],
      buckets: {
        removed: { count: 2, footprintBytesUpperBound: 0, unknownFootprintCount: 2 },
        removal_failed: { count: 0, footprintBytesUpperBound: 0, unknownFootprintCount: 0 },
        probably_safe: { count: 1, footprintBytesUpperBound: 4096, unknownFootprintCount: 0 },
        needs_call: { count: 0, footprintBytesUpperBound: 0, unknownFootprintCount: 0 },
        blocked: { count: 0, footprintBytesUpperBound: 0, unknownFootprintCount: 0 },
      },
      notAnalyzed: [],
    };
    store.getState().handleSweepComplete({
      runId: 'run-1',
      startedAt: '2026-06-21T05:00:00.000Z',
      finishedAt: '2026-06-21T05:00:02.000Z',
      projects: [],
      report,
    });

    expect(store.getState().sweepReport).toEqual(report);
    expect(store.getState().sweepReportOpen).toBe(true);
    expect(store.getState().lastSweepRunId).toBe('run-1');

    store.getState().closeSweepReport();
    expect(store.getState().sweepReportOpen).toBe(false);
    // report is retained so the panel is re-openable for the run's lifetime
    expect(store.getState().sweepReport).toEqual(report);
    store.getState().openSweepReport();
    expect(store.getState().sweepReportOpen).toBe(true);
  });

  test('handleSweepComplete without a report leaves report state untouched (old-server skew)', () => {
    store.getState().handleSweepComplete({
      runId: 'run-x',
      startedAt: '2026-06-21T05:00:00.000Z',
      finishedAt: '2026-06-21T05:00:02.000Z',
      projects: [{ kind: 'ok', projectId: 'p', summaries: [], elapsedMs: 1 }],
    });
    expect(store.getState().sweepReport).toBeNull();
    expect(store.getState().sweepReportOpen).toBe(false);
  });

  test('handleSweepReport applies a reconstructed report and opens the panel', () => {
    const report = {
      runId: 'run-9',
      generatedAt: '2026-06-21T05:00:02.000Z',
      thresholdDays: 14,
      rows: [],
      buckets: {
        removed: { count: 1, footprintBytesUpperBound: 0, unknownFootprintCount: 1 },
        removal_failed: { count: 0, footprintBytesUpperBound: 0, unknownFootprintCount: 0 },
        probably_safe: { count: 0, footprintBytesUpperBound: 0, unknownFootprintCount: 0 },
        needs_call: { count: 0, footprintBytesUpperBound: 0, unknownFootprintCount: 0 },
        blocked: { count: 0, footprintBytesUpperBound: 0, unknownFootprintCount: 0 },
      },
      notAnalyzed: [],
      reconstructedFromLedger: true,
    };
    store.getState().handleSweepReport({ runId: 'run-9', report });
    expect(store.getState().sweepReport?.reconstructedFromLedger).toBe(true);
    expect(store.getState().sweepReportOpen).toBe(true);

    // An empty reconstruction (unknown runId) surfaces an alert, not a panel.
    store.getState().closeSweepReport();
    store.getState().handleSweepReport({ runId: 'nope' });
    expect(store.getState().sweepReportOpen).toBe(false);
    expect(store.getState().alerts.at(-1)?.summary).toContain('No sweep report');
  });

  test('handleSnapshot hydrates in-flight sweep progress for reconnects', () => {
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
      true,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        runId: 'run-snapshot',
        startedAt: '2026-06-21T05:00:00.000Z',
        index: 2,
        total: 4,
        projectId: 'github.com/acme/repo',
        status: 'running',
        counts: { done: 1, skipped: 1, failed: 0 },
      },
    );

    expect(store.getState().sweepRunning).toBe(true);
    expect(store.getState().sweepProgress).toMatchObject({
      runId: 'run-snapshot',
      index: 2,
      total: 4,
      projectId: 'github.com/acme/repo',
      status: 'running',
      counts: { done: 1, skipped: 1, failed: 0 },
      projectStatuses: { 'github.com/acme/repo': 'running' },
    });
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

describe('bulk-remove progress reducer (RFC PR 3)', () => {
  function reportWithProbablySafe() {
    const row = (worktreePath: string, footprintBytes: number | null, hasSensitiveIgnored = false) => ({
      projectId: 'github.com/acme/project',
      worktreePath,
      branch: `feat/${worktreePath.slice(-1)}`,
      classification: 'unique_commits' as const,
      reasonCode: 'has_unique_commits',
      bucket: 'probably_safe' as const,
      footprintBytes,
      lastTouchedMs: 0,
      reason: 'stale',
      hasSensitiveIgnored,
      fingerprint: `fp-${worktreePath.slice(-1)}`,
    });
    return {
      runId: 'run-1',
      generatedAt: '2026-06-10T00:00:00Z',
      thresholdDays: 14,
      rows: [row('/wt/a', 1000), row('/wt/b', null, true)],
      buckets: {
        removed: { count: 0, footprintBytesUpperBound: 0, unknownFootprintCount: 0 },
        removal_failed: { count: 0, footprintBytesUpperBound: 0, unknownFootprintCount: 0 },
        probably_safe: { count: 2, footprintBytesUpperBound: 1000, unknownFootprintCount: 1 },
        needs_call: { count: 0, footprintBytesUpperBound: 0, unknownFootprintCount: 0 },
        blocked: { count: 0, footprintBytesUpperBound: 0, unknownFootprintCount: 0 },
      },
      notAnalyzed: [],
    };
  }

  test('drops removed rows live and ends the run on the last row', () => {
    const store = createKookrStore();
    store.setState({ sweepReport: reportWithProbablySafe() });
    store.getState().startBulkRemove();
    expect(store.getState().bulkRemoveRunning).toBe(true);

    const base = { runId: 'bulk-1', total: 2, projectId: 'github.com/acme/project' };
    store.getState().handleBulkRemoveProgress({ type: 'workspaceBulkRemoveProgress', ...base, index: 1, worktreePath: '/wt/a', status: 'running' });
    store.getState().handleBulkRemoveProgress({ type: 'workspaceBulkRemoveProgress', ...base, index: 1, worktreePath: '/wt/a', status: 'done' });

    // The removed row left the report and the bucket recounted.
    let report = store.getState().sweepReport!;
    expect(report.rows.map((r) => r.worktreePath)).toEqual(['/wt/b']);
    expect(report.buckets.probably_safe.count).toBe(1);
    expect(report.buckets.probably_safe.footprintBytesUpperBound).toBe(0);
    expect(store.getState().bulkRemoveRunning).toBe(true);

    store.getState().handleBulkRemoveProgress({ type: 'workspaceBulkRemoveProgress', ...base, index: 2, worktreePath: '/wt/b', status: 'running' });
    store.getState().handleBulkRemoveProgress({ type: 'workspaceBulkRemoveProgress', ...base, index: 2, worktreePath: '/wt/b', status: 'skipped' });

    // Skipped row stays; run ends after the final row.
    report = store.getState().sweepReport!;
    expect(report.rows.map((r) => r.worktreePath)).toEqual(['/wt/b']);
    expect(store.getState().bulkRemoveRunning).toBe(false);
    expect(store.getState().bulkRemoveProgress).toMatchObject({ done: 1, skipped: 1 });
  });

  test('a synthetic 0/0 terminal event clears an optimistically-set running flag', () => {
    const store = createKookrStore();
    store.getState().startBulkRemove();
    expect(store.getState().bulkRemoveRunning).toBe(true);

    // The server emits this on an early/error exit so the client never sticks.
    store.getState().handleBulkRemoveProgress({
      type: 'workspaceBulkRemoveProgress',
      runId: 'bulk-empty',
      index: 0,
      total: 0,
      projectId: '',
      worktreePath: '',
      status: 'skipped',
    });

    expect(store.getState().bulkRemoveRunning).toBe(false);
  });
});
