import { describe, expect, test } from 'vitest';
import { computeAbortActiveTaskIds } from './abort-active-tasks.js';
import type { AgentState } from '../shared/protocol.js';

function agent(overrides: Partial<AgentState>): AgentState {
  return {
    agentId: overrides.agentId ?? 'agent',
    taskId: overrides.taskId ?? 'task',
    description: 'x',
    events: [],
    anomaly: null,
    taskStatus: 'inProgress',
    cwd: '/tmp',
    ...overrides,
  } as AgentState;
}

describe('computeAbortActiveTaskIds', () => {
  test('returns active (non-terminal) task IDs in order', () => {
    const ids = computeAbortActiveTaskIds(
      [
        agent({ agentId: 'a1', taskId: 't1', taskStatus: 'inProgress' }),
        agent({ agentId: 'a2', taskId: 't2', taskStatus: 'pending' }),
      ],
      new Set(),
    );
    expect(ids).toEqual(['t1', 't2']);
  });

  test('excludes terminal tasks (completed / cancelled / terminated)', () => {
    const ids = computeAbortActiveTaskIds(
      [
        agent({ agentId: 'a1', taskId: 't1', taskStatus: 'inProgress' }),
        agent({ agentId: 'a2', taskId: 't2', taskStatus: 'completed' }),
        agent({ agentId: 'a3', taskId: 't3', taskStatus: 'cancelled' }),
        agent({ agentId: 'a4', taskId: 't4', taskStatus: 'terminated' }),
      ],
      new Set(),
    );
    expect(ids).toEqual(['t1']);
  });

  test('dedupes a multi-session task so it aborts once', () => {
    const ids = computeAbortActiveTaskIds(
      [
        agent({ agentId: 'a1', taskId: 'shared-task', taskStatus: 'inProgress' }),
        agent({ agentId: 'a2', taskId: 'shared-task', taskStatus: 'inProgress' }),
      ],
      new Set(),
    );
    expect(ids).toEqual(['shared-task']);
  });

  test('excludes tasks already queued for a destructive action', () => {
    const ids = computeAbortActiveTaskIds(
      [
        agent({ agentId: 'a1', taskId: 't1', taskStatus: 'inProgress' }),
        agent({ agentId: 'a2', taskId: 't2', taskStatus: 'inProgress' }),
      ],
      new Set(['t2']),
    );
    expect(ids).toEqual(['t1']);
  });

  test('skips agents without a taskId', () => {
    const ids = computeAbortActiveTaskIds(
      [
        agent({ agentId: 'a1', taskId: undefined, taskStatus: 'inProgress' }),
        agent({ agentId: 'a2', taskId: 't2', taskStatus: 'inProgress' }),
      ],
      new Set(),
    );
    expect(ids).toEqual(['t2']);
  });

  test('treats undefined taskStatus as active (not yet reported)', () => {
    const ids = computeAbortActiveTaskIds(
      [agent({ agentId: 'a1', taskId: 't1', taskStatus: undefined })],
      new Set(),
    );
    expect(ids).toEqual(['t1']);
  });
});
