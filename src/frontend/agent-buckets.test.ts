import { describe, expect, test } from 'vitest';
import type { AgentState } from '../shared/protocol.js';
import { TIME_TO_UNBLOCK_WINDOW_MS } from '../shared/contracts/time-to-unblock.js';
import { buildAgentBuckets, countCompletedInWindow } from './agent-buckets.js';

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

  test('large fleet: healthy order is startedAt ascending then id (parse-once path)', () => {
    const fleet: AgentState[] = [];
    // Reverse insertion so array order ≠ sort order; mix valid / missing / invalid times.
    for (let i = 49; i >= 0; i -= 1) {
      fleet.push(agent(`healthy-${String(i).padStart(2, '0')}`, 'project-a', {
        startedAt: `2026-06-20T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`,
      }));
    }
    fleet.push(agent('no-start', 'project-a')); // unknown time → last among same priority
    fleet.push(agent('bad-start', 'project-a', { startedAt: 'not-a-date' }));
    fleet.push(agent('completed-old', 'project-a', {
      taskStatus: 'completed',
      finishedAt: '2026-06-19T12:00:00.000Z',
    }));
    fleet.push(agent('completed-new', 'project-a', {
      taskStatus: 'completed',
      finishedAt: '2026-06-21T12:00:00.000Z',
    }));
    fleet.push(agent('completed-fallback', 'project-a', {
      taskStatus: 'completed',
      startedAt: '2026-06-20T08:00:00.000Z',
    }));

    const buckets = buildAgentBuckets(fleet, null);

    // startedAt ascending by index; unknown/invalid times sort last, tie-break by id
    // ('bad-start' < 'no-start').
    expect(buckets.healthy.map((a) => a.agentId)).toEqual([
      ...Array.from({ length: 50 }, (_, i) => `healthy-${String(i).padStart(2, '0')}`),
      'bad-start',
      'no-start',
    ]);
    expect(buckets.completed.map((a) => a.agentId)).toEqual([
      'completed-new',
      'completed-fallback',
      'completed-old',
    ]);
    // Re-run is stable (parse-once maps rebuilt identically each call).
    const again = buildAgentBuckets(fleet, null);
    expect(again.healthy.map((a) => a.agentId)).toEqual(buckets.healthy.map((a) => a.agentId));
    expect(again.completed.map((a) => a.agentId)).toEqual(buckets.completed.map((a) => a.agentId));
  });
});

describe('countCompletedInWindow (issue #2618)', () => {
  const NOW = Date.parse('2026-08-18T18:00:00.000Z');

  function iso(offsetMs: number): string {
    return new Date(NOW + offsetMs).toISOString();
  }

  test('counts three terminal agents finished inside the 24-hour window', () => {
    const agents = [
      agent('a', 'p', { taskStatus: 'completed', finishedAt: iso(-1 * 60 * 60 * 1000) }),
      agent('b', 'p', { taskStatus: 'cancelled', finishedAt: iso(-8 * 60 * 60 * 1000) }),
      agent('c', 'p', { taskStatus: 'terminated', finishedAt: iso(-23 * 60 * 60 * 1000) }),
    ];
    expect(countCompletedInWindow(agents, NOW)).toBe(3);
  });

  test('includes finishes exactly at now and exactly at the window cutoff', () => {
    const agents = [
      agent('now', 'p', { taskStatus: 'completed', finishedAt: iso(0) }),
      agent('cutoff', 'p', { taskStatus: 'completed', finishedAt: iso(-TIME_TO_UNBLOCK_WINDOW_MS) }),
      agent('just-outside', 'p', { taskStatus: 'completed', finishedAt: iso(-TIME_TO_UNBLOCK_WINDOW_MS - 1) }),
    ];
    expect(countCompletedInWindow(agents, NOW)).toBe(2);
  });

  test('returns 0 for a non-finite now or a negative window', () => {
    const agents = [
      agent('a', 'p', { taskStatus: 'completed', finishedAt: iso(-60_000) }),
    ];
    expect(countCompletedInWindow(agents, Number.NaN)).toBe(0);
    expect(countCompletedInWindow(agents, NOW, -1)).toBe(0);
  });

  test('ignores agents that finished before the window or are still running', () => {
    const agents = [
      agent('old', 'p', { taskStatus: 'completed', finishedAt: iso(-25 * 60 * 60 * 1000) }),
      agent('running', 'p', { taskStatus: 'inProgress', finishedAt: iso(-10 * 60 * 1000) }),
      agent('fresh', 'p', { taskStatus: 'completed', finishedAt: iso(-10 * 60 * 1000) }),
    ];
    expect(countCompletedInWindow(agents, NOW)).toBe(1);
  });

  test('does not treat startedAt as a finish time', () => {
    const agents = [
      agent('no-finish', 'p', { taskStatus: 'completed', startedAt: iso(-10 * 60 * 1000) }),
      agent('bad-finish', 'p', { taskStatus: 'completed', finishedAt: 'not-a-date' }),
      agent('future', 'p', { taskStatus: 'completed', finishedAt: iso(60_000) }),
    ];
    expect(countCompletedInWindow(agents, NOW)).toBe(0);
  });
});
