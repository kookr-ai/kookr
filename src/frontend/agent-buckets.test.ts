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

  test('orders completed tasks by finish time newest first', () => {
    const buckets = buildAgentBuckets([
      agent('old', 'project-a', { taskStatus: 'completed', finishedAt: '2026-06-20T09:00:00.000Z' }),
      agent('new', 'project-a', { taskStatus: 'completed', finishedAt: '2026-06-20T11:00:00.000Z' }),
      agent('middle', 'project-a', { taskStatus: 'cancelled', finishedAt: '2026-06-20T10:00:00.000Z' }),
    ], null);

    expect(buckets.completed.map((a) => a.agentId)).toEqual(['new', 'middle', 'old']);
  });

  test('orders completed tasks with missing finish times by fallback recency then id', () => {
    const buckets = buildAgentBuckets([
      agent('alpha', 'project-a', { taskStatus: 'completed' }),
      agent('started-old', 'project-a', {
        taskStatus: 'completed',
        startedAt: '2026-06-20T09:00:00.000Z',
      }),
      agent('started-new', 'project-a', {
        taskStatus: 'completed',
        finishedAt: 'not-a-date',
        startedAt: '2026-06-20T12:00:00.000Z',
      }),
      agent('zulu', 'project-a', { taskStatus: 'terminated' }),
    ], null);

    expect(buckets.completed.map((a) => a.agentId)).toEqual([
      'started-new',
      'started-old',
      'zulu',
      'alpha',
    ]);
  });
});
