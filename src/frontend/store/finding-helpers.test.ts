import { describe, expect, test } from 'vitest';
import type { AgentState } from '../../shared/protocol.js';
import { isActiveFinding } from './finding-helpers.js';

function agent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'agent-1',
    events: [],
    anomaly: {
      type: 'needs_input',
      severity: 'info',
      explanation: 'waiting',
      detectedAt: '2026-05-08T10:00:00.000Z',
    },
    taskStatus: 'inProgress',
    ...overrides,
  } as AgentState;
}

describe('isActiveFinding', () => {
  test('treats non-terminal anomalous tasks as active findings', () => {
    expect(isActiveFinding(agent({ taskStatus: 'inProgress' }))).toBe(true);
  });

  test.each(['completed', 'terminated', 'cancelled'] as const)(
    'excludes terminal task %s even when stale anomaly state remains',
    (taskStatus) => {
      expect(isActiveFinding(agent({ taskStatus }))).toBe(false);
    },
  );
});
