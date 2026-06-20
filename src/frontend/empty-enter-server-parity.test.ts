import { describe, expect, it } from 'vitest';
import type { AgentState } from '../shared/protocol.js';
import type { AnomalySeverity } from '../shared/contracts/anomalies.js';
import { buildRoutableOrder, type AgentOrderOptions } from './agent-priority-order.js';
import { selectNextRoutableSessionId } from '../shared/task-routing.js';

/**
 * Parity test for #1079: the order the frontend presents (`buildRoutableOrder`)
 * and the next task the server advances to (`selectNextRoutableSessionId` fed
 * the same ordered candidate list) must agree for representative task sets.
 */

function base(agentId: string, overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId,
    taskId: `t-${agentId}`,
    events: [],
    anomaly: null,
    taskStatus: 'inProgress',
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function finding(agentId: string, severity: AnomalySeverity, overrides: Partial<AgentState> = {}): AgentState {
  return base(agentId, {
    anomaly: { type: 'needs_input', agentId, severity, explanation: 'waiting', detectedAt: new Date() },
    ...overrides,
  });
}

function buildScenario() {
  const agents: AgentState[] = [
    finding('f_crit', 'critical'),
    finding('f_warn', 'warning'),
    base('h_chip'), // healthy, has a coordinator chip
    base('h_high', { priority: 'high' }),
    base('h_proj', { projectId: 'p1' }),
    base('h_norm'),
    // Non-routable agents the server must never advance to:
    base('pending', { taskStatus: 'pending' }),
    base('terminal', { taskStatus: 'completed' }),
    finding('snoozed', 'warning', { snoozedUntil: Date.now() + 60_000 }),
    base('suppressed', { suppressed: true }),
  ];

  const options: AgentOrderOptions = {
    chipTaskIds: new Set(['t-h_chip']),
    projectPriorityRanks: new Map([['p1', 0]]),
    originalIndex: new Map(agents.map((agent, index) => [agent.agentId, index])),
  };

  return { agents, options };
}

describe('empty-Enter server/frontend ordering parity', () => {
  it('orders findings (severity-aware) before healthy (chip, priority, project rank)', () => {
    const { agents, options } = buildScenario();
    const order = buildRoutableOrder(agents, options).map((agent) => agent.agentId);
    expect(order).toEqual(['f_crit', 'f_warn', 'h_chip', 'h_high', 'h_proj', 'h_norm']);
  });

  it('server advances along exactly the frontend order at every position', () => {
    const { agents, options } = buildScenario();
    const order = buildRoutableOrder(agents, options);
    const orderedSessionIds = order.map((agent) => agent.agentId);

    for (let i = 0; i < order.length; i += 1) {
      const expectedNext = order[(i + 1) % order.length].agentId;
      const result = selectNextRoutableSessionId({
        orderedSessionIds,
        currentSessionId: order[i].agentId,
        agents,
      });
      expect(result.next?.sessionId).toBe(expectedNext);
    }
  });

  it('excludes pending, terminal, snoozed, and suppressed tasks from the routable order', () => {
    const { agents, options } = buildScenario();
    const order = buildRoutableOrder(agents, options).map((agent) => agent.agentId);
    for (const excluded of ['pending', 'terminal', 'snoozed', 'suppressed']) {
      expect(order).not.toContain(excluded);
    }

    // Even if a stale client smuggles an excluded id into the candidate list,
    // the server re-validates against its snapshot and skips it.
    const result = selectNextRoutableSessionId({
      orderedSessionIds: ['h_norm', 'pending', 'suppressed', 'f_crit'],
      currentSessionId: 'h_norm',
      agents,
    });
    expect(result.next?.sessionId).toBe('f_crit');
    expect(result.diagnostics.excludedCount).toBe(2);
  });

  it('keeps a stable, deterministic fallback order when ranking inputs are absent', () => {
    const { agents } = buildScenario();
    // No chip/project/originalIndex context. Findings sort by severity; the
    // healthy bucket sorts by priority (h_high first) then falls through to a
    // stable id comparison, so the order is fully determined and excludes every
    // non-routable task.
    const order = buildRoutableOrder(agents, {}).map((agent) => agent.agentId);
    expect(order).toEqual(['f_crit', 'f_warn', 'h_high', 'h_chip', 'h_norm', 'h_proj']);
  });
});
