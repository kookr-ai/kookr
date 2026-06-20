import { describe, expect, it } from 'vitest';
import type { AgentState } from '../shared/protocol.js';
import { DashboardSelectionController } from './dashboard-selection-controller.js';

function agent(agentId: string, taskId: string, anomaly = false): AgentState {
  return {
    agentId,
    taskId,
    events: [],
    anomaly: anomaly ? { type: 'needs_input', agentId, severity: 'info', explanation: 'waiting', detectedAt: new Date() } : null,
    taskStatus: 'inProgress',
  };
}

describe('DashboardSelectionController', () => {
  it('advances only when connection selection still matches and consumes duplicate intents', () => {
    const controller = new DashboardSelectionController({
      getAgents: () => [agent('s1', 't1', true), agent('s2', 't2')],
    });
    controller.registerConnection('c1');
    const selected = controller.updateSelection({
      connectionId: 'c1',
      selectedTaskId: 't1',
      selectedSessionId: 's1',
    });

    const first = controller.advanceIfSelectionStill({
      connectionId: 'c1',
      taskId: 't1',
      sessionId: 's1',
      selectionVersion: selected.selectionVersion,
      intentId: 'intent-1',
    });
    expect(first).toMatchObject({
      kind: 'advanced',
      state: { selectedTaskId: 't2', selectedSessionId: 's2', selectionVersion: selected.selectionVersion + 1 },
    });

    expect(controller.advanceIfSelectionStill({
      connectionId: 'c1',
      taskId: 't1',
      sessionId: 's1',
      selectionVersion: selected.selectionVersion,
      intentId: 'intent-1',
    })).toEqual({ kind: 'rejected', reason: 'duplicate-intent' });
  });

  it('advances along the frontend-provided candidate order and reports diagnostics', () => {
    const controller = new DashboardSelectionController({
      getAgents: () => [agent('s1', 't1', true), agent('s2', 't2'), agent('s3', 't3')],
    });
    controller.registerConnection('c1');
    const selected = controller.updateSelection({ connectionId: 'c1', selectedTaskId: 't1', selectedSessionId: 's1' });

    const advanced = controller.advanceIfSelectionStill({
      connectionId: 'c1',
      taskId: 't1',
      sessionId: 's1',
      selectionVersion: selected.selectionVersion,
      intentId: 'intent-1',
      orderedCandidateSessionIds: ['s1', 's3', 's2'],
    });

    expect(advanced).toEqual({
      kind: 'advanced',
      state: {
        connectionId: 'c1',
        selectedTaskId: 't3',
        selectedSessionId: 's3',
        selectionVersion: selected.selectionVersion + 1,
      },
      diagnostics: {
        source: 'frontend-order',
        candidateCount: 3,
        routableCount: 3,
        excludedCount: 0,
        currentInOrder: true,
        selectedSessionId: 's3',
      },
    });
  });

  it('skips non-routable candidates supplied by a stale client view', () => {
    const pending = { ...agent('s2', 't2'), taskStatus: 'pending' as const };
    const controller = new DashboardSelectionController({
      getAgents: () => [agent('s1', 't1', true), pending, agent('s3', 't3')],
    });
    controller.registerConnection('c1');
    const selected = controller.updateSelection({ connectionId: 'c1', selectedTaskId: 't1', selectedSessionId: 's1' });

    const advanced = controller.advanceIfSelectionStill({
      connectionId: 'c1',
      taskId: 't1',
      sessionId: 's1',
      selectionVersion: selected.selectionVersion,
      intentId: 'intent-1',
      orderedCandidateSessionIds: ['s1', 's2', 's3'],
    });

    expect(advanced).toEqual({
      kind: 'advanced',
      state: {
        connectionId: 'c1',
        selectedTaskId: 't3',
        selectedSessionId: 's3',
        selectionVersion: selected.selectionVersion + 1,
      },
      diagnostics: {
        source: 'frontend-order',
        candidateCount: 3,
        routableCount: 2,
        excludedCount: 1,
        currentInOrder: true,
        selectedSessionId: 's3',
      },
    });
  });

  it('rejects stale selection versions without advancing', () => {
    const controller = new DashboardSelectionController({ getAgents: () => [agent('s1', 't1'), agent('s2', 't2')] });
    controller.registerConnection('c1');
    const selected = controller.updateSelection({ connectionId: 'c1', selectedTaskId: 't1', selectedSessionId: 's1' });
    controller.updateSelection({ connectionId: 'c1', selectedTaskId: 't2', selectedSessionId: 's2' });

    expect(controller.advanceIfSelectionStill({
      connectionId: 'c1',
      taskId: 't1',
      sessionId: 's1',
      selectionVersion: selected.selectionVersion,
      intentId: 'intent-1',
    })).toEqual({ kind: 'rejected', reason: 'stale-selection' });
  });
});
