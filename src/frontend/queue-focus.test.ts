import { describe, expect, test } from 'vitest';
import type { AgentState } from '../shared/protocol.js';
import { activeFindingIndex, queueFocusTarget } from './queue-focus.js';

function finding(id: string, patch: Partial<AgentState> = {}): AgentState {
  return {
    agentId: id,
    projectId: 'project-a',
    events: [],
    anomaly: { kind: 'blocked' } as unknown as AgentState['anomaly'],
    taskStatus: 'inProgress',
    taskId: `task-${id}`,
    ...patch,
  };
}

describe('activeFindingIndex', () => {
  const findings = [finding('a'), finding('b'), finding('c')];

  test('returns the index of the selected anomaly finding', () => {
    expect(activeFindingIndex(findings, 'b', true)).toBe(1);
  });

  test('returns -1 when the current selection is not an anomaly', () => {
    expect(activeFindingIndex(findings, 'b', false)).toBe(-1);
  });

  test('returns -1 when the selected id is not among the findings', () => {
    expect(activeFindingIndex(findings, 'missing', true)).toBe(-1);
  });
});

describe('queueFocusTarget', () => {
  const findings = [finding('a'), finding('b'), finding('c')];

  test('focuses the actively selected finding when one is selected', () => {
    expect(queueFocusTarget(findings, 'c', true)?.agentId).toBe('c');
  });

  test('falls back to the first finding when nothing is actively selected', () => {
    expect(queueFocusTarget(findings, null, false)?.agentId).toBe('a');
  });

  test('falls back to the first finding when the selection is off the list', () => {
    expect(queueFocusTarget(findings, 'missing', true)?.agentId).toBe('a');
  });

  test('returns null when there are no findings', () => {
    expect(queueFocusTarget([], 'a', true)).toBeNull();
  });
});
