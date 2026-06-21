import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentState } from '../shared/protocol.js';
import type { KookrStore } from './store/store-types.js';
import {
  __resetSelectionTransitionRecorderForTests,
  getSelectionTransitionDiagnostics,
  recordSelectionTransitionFromStore,
  withSelectionTransitionSource,
} from './selection-transition-recorder.js';
import { track } from './telemetry.js';

vi.mock('./telemetry.js', () => ({
  track: vi.fn(),
}));

function agent(id: string, overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: id,
    taskId: `task-${id}`,
    taskStatus: 'inProgress',
    projectId: 'project-1',
    priority: 'normal',
    events: [],
    anomaly: {
      agentId: id,
      type: 'needs_input',
      severity: 'warning',
      explanation: 'Waiting',
      detectedAt: new Date('2026-06-20T00:00:00.000Z'),
    },
    ...overrides,
  };
}

function state(selectedAgentId: string | null, agents: AgentState[] = [agent('a'), agent('b')]): KookrStore {
  return {
    selectedAgentId,
    agents,
    selectedProject: 'project-1',
    autoAdvanceEnabled: false,
    selectedAgentSource: 'manual',
    lastTickReason: null,
    dashboardSelection: { selectedTaskId: null, selectedSessionId: null, selectionVersion: 7 },
    coordinator: { chips: [{ taskId: 'task-a', kind: 'blocking_child' }] },
    projectSummaries: [{ project: 'project-1', activeCount: 2, totalCount: 2 }],
    projectSidebarPrefs: { ordered: [], pinned: [], hidden: [] },
  } as unknown as KookrStore;
}

describe('selection transition recorder', () => {
  beforeEach(() => {
    __resetSelectionTransitionRecorderForTests();
    vi.mocked(track).mockClear();
  });

  test('records bounded selection snapshots without emitting telemetry for ordinary changes', () => {
    const base = Date.now();
    withSelectionTransitionSource({ source: 'selectAgent', reason: 'manual_select' }, () => {
      recordSelectionTransitionFromStore(state(null), state('a'), ['selectedAgentId'], base);
    });

    const diagnostics = getSelectionTransitionDiagnostics();
    expect(diagnostics.transitions).toHaveLength(1);
    expect(diagnostics.transitions[0]).toMatchObject({
      fromTaskId: null,
      toTaskId: 'task-a',
      fromSessionId: null,
      toSessionId: 'a',
      source: 'selectAgent',
      reason: 'manual_select',
      dashboardSelectionVersion: 7,
    });
    expect(diagnostics.transitions[0].toTask).toMatchObject({
      taskId: 'task-a',
      anomalyType: 'needs_input',
      coordinatorChip: true,
    });
    expect(diagnostics.transitions[0].routingCandidates.length).toBeGreaterThan(0);
    expect(track).not.toHaveBeenCalled();
  });

  test('detects A/B flicker and emits one compact rate-limited telemetry event', () => {
    const base = Date.now();
    const switches: Array<[string, string]> = [['a', 'b'], ['b', 'a'], ['a', 'b'], ['b', 'a']];

    switches.forEach(([from, to], index) => {
      withSelectionTransitionSource({ source: index % 2 === 0 ? 'handleDashboardSelection' : 'selectedAgentUpdateAfterServerState' }, () => {
        recordSelectionTransitionFromStore(state(from), state(to), ['selectedAgentId'], base + index * 1000);
      });
    });

    expect(track).toHaveBeenCalledTimes(1);
    const telemetryEvent = vi.mocked(track).mock.calls[0][0];
    expect(telemetryEvent).toMatchObject({
      type: 'selection_flicker_incident',
      switchCount: 3,
      taskIdCount: 2,
      sessionIdCount: 2,
      sourceCounts: {
        handleDashboardSelection: 2,
        selectedAgentUpdateAfterServerState: 1,
      },
    });
    expect(telemetryEvent.pairKey).toMatch(/^pair-/);
    expect(telemetryEvent).not.toHaveProperty('taskIds');
    expect(telemetryEvent).not.toHaveProperty('sessionIds');
    expect(telemetryEvent).not.toHaveProperty('firstTaskStates');
    expect(telemetryEvent).not.toHaveProperty('lastTaskStates');
    expect(JSON.stringify(telemetryEvent)).not.toContain('project-1');
    expect(JSON.stringify(telemetryEvent)).not.toContain('task-a');
    expect(JSON.stringify(telemetryEvent)).not.toContain('"a"');
    expect(getSelectionTransitionDiagnostics().flickerIncidents).toHaveLength(1);
  });

  test('keeps only the latest 100 transitions', () => {
    const base = Date.now();
    for (let index = 0; index < 105; index += 1) {
      recordSelectionTransitionFromStore(
        state(index % 2 === 0 ? null : 'a'),
        state(index % 2 === 0 ? 'a' : null),
        ['selectedAgentId'],
        base + index,
      );
    }

    const diagnostics = getSelectionTransitionDiagnostics();
    expect(diagnostics.transitions).toHaveLength(100);
    expect(diagnostics.transitions[0].atMs).toBe(base + 5);
  });

  test('prunes stale rate-limit pairs', () => {
    const base = Date.now();
    const emitFlicker = (startMs: number) => {
      [['a', 'b'], ['b', 'a'], ['a', 'b']].forEach(([from, to], index) => {
        recordSelectionTransitionFromStore(state(from), state(to), ['selectedAgentId'], startMs + index * 1000);
      });
    };

    emitFlicker(base);
    emitFlicker(base + 10_000);
    expect(track).toHaveBeenCalledTimes(1);

    recordSelectionTransitionFromStore(
      state(null),
      state('a'),
      ['selectedAgentId'],
      base + 5 * 60 * 1000 + 1,
    );
    emitFlicker(base + 5 * 60 * 1000 + 2);

    expect(track).toHaveBeenCalledTimes(2);
  });
});
