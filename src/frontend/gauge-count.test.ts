import { describe, test, expect } from 'vitest';
import { healthyDotClass } from './presentation.js';
import type { AgentState, AgentEvent } from '../shared/protocol.js';

/**
 * The CapacityGauge receives pre-filtered "healthy" agents (no anomaly, not snoozed)
 * and counts those with healthyDotClass === 'running'. This test verifies that
 * the gauge's count logic correctly distinguishes running from done agents,
 * and that the App.tsx healthy filter excludes anomalous agents.
 */

function countRunning(agents: AgentState[]): number {
  return agents.filter((a) => healthyDotClass(a.events) === 'running').length;
}

function filterHealthy(agents: AgentState[]): AgentState[] {
  return agents.filter((a) => a.anomaly === null && !a.snoozedUntil);
}

function makeAgent(id: string, events: AgentEvent[], overrides?: Partial<AgentState>): AgentState {
  return { agentId: id, events, anomaly: null, ...overrides };
}

describe('gauge running count', () => {
  test('counts agents whose last event is not stop', () => {
    const agents: AgentState[] = [
      makeAgent('a1', [{ type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: {} }]),
      makeAgent('a2', [{ type: 'tool_use', sessionId: 's2', toolName: 'Read', toolInput: {} }]),
    ];
    expect(countRunning(agents)).toBe(2);
  });

  test('excludes agents whose last event is stop', () => {
    const agents: AgentState[] = [
      makeAgent('a1', [{ type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: {} }]),
      makeAgent('a2', [{ type: 'stop', sessionId: 's2', lastMessage: 'Done' }]),
    ];
    expect(countRunning(agents)).toBe(1);
  });

  test('counts agents with no events as running', () => {
    const agents: AgentState[] = [makeAgent('a1', [])];
    expect(countRunning(agents)).toBe(1);
  });
});

describe('healthy filter excludes anomalous agents from gauge input', () => {
  test('excludes agents with permission_blocked anomaly', () => {
    const agents: AgentState[] = [
      makeAgent('a1', [{ type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: {} }]),
      makeAgent('a2', [{ type: 'permission_request', sessionId: 's2', toolName: 'Bash' }], {
        anomaly: {
          agentId: 'a2',
          type: 'permission_blocked',
          severity: 'warning',
          explanation: 'Blocked on Bash',
          detectedAt: new Date(),
        },
      }),
    ];
    const healthy = filterHealthy(agents);
    expect(healthy).toHaveLength(1);
    expect(healthy[0].agentId).toBe('a1');
    expect(countRunning(healthy)).toBe(1);
  });

  test('excludes agents with needs_input anomaly', () => {
    const agents: AgentState[] = [
      makeAgent('a1', [{ type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: {} }]),
      makeAgent('a2', [{ type: 'tool_use', sessionId: 's2', toolName: 'AskUserQuestion', toolInput: {} }], {
        anomaly: {
          agentId: 'a2',
          type: 'needs_input',
          severity: 'warning',
          explanation: 'Agent asked a question',
          detectedAt: new Date(),
        },
      }),
    ];
    const healthy = filterHealthy(agents);
    expect(healthy).toHaveLength(1);
    expect(countRunning(healthy)).toBe(1);
  });

  test('excludes snoozed agents', () => {
    const agents: AgentState[] = [
      makeAgent('a1', [{ type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: {} }]),
      makeAgent('a2', [{ type: 'tool_use', sessionId: 's2', toolName: 'Read', toolInput: {} }], {
        snoozedUntil: Date.now() + 60_000,
      }),
    ];
    const healthy = filterHealthy(agents);
    expect(healthy).toHaveLength(1);
    expect(countRunning(healthy)).toBe(1);
  });

  test('excludes agents with repeated_error anomaly', () => {
    const agents: AgentState[] = [
      makeAgent('a1', [{ type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: {} }]),
      makeAgent('a2', [{ type: 'error', sessionId: 's2', message: 'fail' }], {
        anomaly: {
          agentId: 'a2',
          type: 'repeated_error',
          severity: 'warning',
          explanation: 'Same error 3 times',
          detectedAt: new Date(),
        },
      }),
    ];
    const healthy = filterHealthy(agents);
    expect(healthy).toHaveLength(1);
    expect(countRunning(healthy)).toBe(1);
  });
});
