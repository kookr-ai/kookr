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
