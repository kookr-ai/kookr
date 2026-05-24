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

  test('floats chip-bearing tasks to the top of the selected project', () => {
    const buckets = buildAgentBuckets([
      agent('agent-a', 'project-a', { taskId: 'task-a' }),
      agent('agent-b', 'project-a', { taskId: 'task-b' }),
      agent('agent-c', 'project-b', { taskId: 'task-c' }),
    ], 'project-a', {
      outputs: [],
      chips: [{
        taskId: 'task-b',
        detectorId: 'stale',
        agentType: 'claude-code',
        action: 'nudge',
        verb: 'Nudge',
        evidenceGlyph: 'clock',
        evidenceCount: 1,
        title: 'Stale',
      }],
      findings: [],
      chains: {},
    });

    expect(buckets.filteredAgents.map((a) => a.agentId)).toEqual(['agent-b', 'agent-a']);
    expect(buckets.healthy.map((a) => a.agentId)).toEqual(['agent-b', 'agent-a']);
  });

  test('orders findings by severity before task priority', () => {
    const buckets = buildAgentBuckets([
      agent('warning-high', 'project-a', {
        priority: 'high',
        anomaly: { agentId: 'warning-high', type: 'needs_input', severity: 'warning', explanation: 'wait', detectedAt: new Date() },
      }),
      agent('critical-normal', 'project-a', {
        anomaly: { agentId: 'critical-normal', type: 'repeated_error', severity: 'critical', explanation: 'stuck', detectedAt: new Date() },
      }),
    ], null);

    expect(buckets.findings.map((a) => a.agentId)).toEqual(['critical-normal', 'warning-high']);
  });

  test('orders same-severity findings and healthy rows by task priority then project rank', () => {
    const projectRanks = new Map([
      ['project-b', 0],
      ['project-a', 1],
    ]);
    const buckets = buildAgentBuckets([
      agent('normal-b', 'project-b', {
        anomaly: { agentId: 'normal-b', type: 'needs_input', severity: 'warning', explanation: 'wait', detectedAt: new Date() },
      }),
      agent('high-a', 'project-a', {
        priority: 'high',
        anomaly: { agentId: 'high-a', type: 'needs_input', severity: 'warning', explanation: 'wait', detectedAt: new Date() },
      }),
      agent('healthy-a', 'project-a'),
      agent('healthy-b', 'project-b'),
    ], null, undefined, projectRanks);

    expect(buckets.findings.map((a) => a.agentId)).toEqual(['high-a', 'normal-b']);
    expect(buckets.healthy.map((a) => a.agentId)).toEqual(['healthy-b', 'healthy-a']);
  });
});
