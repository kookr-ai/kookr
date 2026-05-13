import { describe, expect, test } from 'vitest';
import type { AgentState } from '../shared/protocol.js';
import { buildAgentBuckets } from './agent-buckets.js';

function agent(id: string, projectId: string, patch: Partial<AgentState> = {}): AgentState {
  return {
    agentId: id,
    projectId,
    events: [],
    anomaly: null,
    taskStatus: 'inProgress',
    ...patch,
  };
}

describe('agent buckets', () => {
  test('keeps active task count global when a project is selected', () => {
    const buckets = buildAgentBuckets([
      agent('project-a-running', 'project-a'),
      agent('project-b-running', 'project-b'),
      agent('project-b-pending', 'project-b', { taskStatus: 'pending' }),
    ], 'project-a');

    expect(buckets.healthy.map((a) => a.agentId)).toEqual(['project-a-running']);
    expect(buckets.filteredAgents.map((a) => a.agentId)).toEqual(['project-a-running']);
    expect(buckets.activeTaskCount).toBe(3);
  });
});
