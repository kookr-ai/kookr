import { describe, expect, test } from 'vitest';
import type { Task } from '../core/tasks.js';
import { RuntimeAttentionMissSampler, buildRuntimeAttentionMissWindows } from './attention-miss-runtime-sampler.js';

const NOW = new Date('2026-05-19T10:00:00.000Z');

describe('RuntimeAttentionMissSampler', () => {
  test('builds stratified windows from active tasks and excludes active findings', () => {
    const tasks = [
      task({
        id: 'task-1',
        status: 'inProgress',
        createdAt: new Date('2026-05-19T09:30:00.000Z'),
        sessions: [{
          tmuxSession: 'agent-1',
          agentType: 'claude',
          cwd: '/repo',
          createdAt: new Date('2026-05-19T09:30:00.000Z'),
          lastStatus: 'running',
          lastEventAt: NOW.getTime() - 10_000,
        }],
      }),
      task({
        id: 'task-2',
        status: 'pending',
        createdAt: new Date('2026-05-19T09:58:00.000Z'),
        sessions: [],
      }),
      task({
        id: 'task-3',
        status: 'completed',
        createdAt: new Date('2026-05-19T09:00:00.000Z'),
        sessions: [],
      }),
    ];

    const windows = buildRuntimeAttentionMissWindows(
      tasks,
      (agentId) => agentId === 'agent-1',
      (agentId) => agentId === 'agent-1' ? 'recent_snoozed' : 'none',
      NOW,
    );

    expect(windows).toEqual([
      {
        taskId: 'task-1',
        agentId: 'agent-1',
        taskState: 'inProgress',
        windowStart: '2026-05-19T09:59:00.000Z',
        windowEnd: '2026-05-19T10:00:00.000Z',
        terminalActivity: 'active',
        detectorOpportunity: 'present',
        taskAgeBucket: 'established',
        recentFindingState: 'recent_snoozed',
        activeFinding: true,
      },
      {
        taskId: 'task-2',
        agentId: 'task-task-2',
        taskState: 'pending',
        windowStart: '2026-05-19T09:59:00.000Z',
        windowEnd: '2026-05-19T10:00:00.000Z',
        terminalActivity: 'none',
        detectorOpportunity: 'low',
        taskAgeBucket: 'new',
        recentFindingState: 'none',
        activeFinding: false,
      },
    ]);
  });

  test('samples runtime false-negative diagnostics from live task windows', () => {
    const sampler = new RuntimeAttentionMissSampler({
      listTasks: () => [
        task({
          id: 'task-1',
          status: 'inProgress',
          createdAt: new Date('2026-05-19T09:00:00.000Z'),
          sessions: [{
            tmuxSession: 'agent-1',
            agentType: 'codex',
            cwd: '/repo',
            createdAt: new Date('2026-05-19T09:00:00.000Z'),
            lastStatus: 'running',
            lastEventAt: NOW.getTime() - 30_000,
          }],
        }),
      ],
      hasActiveFinding: () => false,
      now: () => NOW,
    }, {
      maxSamples: 10,
      maxPerStratum: 1,
    });

    expect(sampler.sampleMissCandidates().counters).toEqual({
      eligible: 1,
      sampled: 1,
      reviewable: 1,
      unreviewable: 0,
      reviewed: 0,
      miss_confirmed: 0,
    });
  });

  test('does not count active findings as eligible false-negative windows', () => {
    const sampler = new RuntimeAttentionMissSampler({
      listTasks: () => [
        task({
          id: 'task-1',
          status: 'inProgress',
          createdAt: new Date('2026-05-19T09:00:00.000Z'),
          sessions: [{
            tmuxSession: 'agent-1',
            agentType: 'claude',
            cwd: '/repo',
            createdAt: new Date('2026-05-19T09:00:00.000Z'),
            lastStatus: 'stuck',
            lastEventAt: NOW.getTime() - 30_000,
          }],
        }),
      ],
      hasActiveFinding: () => true,
      now: () => NOW,
    }, {
      maxSamples: 10,
      maxPerStratum: 1,
    });

    expect(sampler.sampleMissCandidates().counters).toEqual({
      eligible: 0,
      sampled: 0,
      reviewable: 0,
      unreviewable: 0,
      reviewed: 0,
      miss_confirmed: 0,
    });
  });

  test('marks snoozed findings as unreviewable recent-finding windows', () => {
    const sampler = new RuntimeAttentionMissSampler({
      listTasks: () => [
        task({
          id: 'task-1',
          status: 'inProgress',
          createdAt: new Date('2026-05-19T09:00:00.000Z'),
          sessions: [{
            tmuxSession: 'agent-1',
            agentType: 'claude',
            cwd: '/repo',
            createdAt: new Date('2026-05-19T09:00:00.000Z'),
            lastStatus: 'stuck',
            lastEventAt: NOW.getTime() - 30_000,
          }],
        }),
      ],
      hasActiveFinding: () => false,
      recentFindingStateFor: () => 'recent_snoozed',
      now: () => NOW,
    }, {
      maxSamples: 10,
      maxPerStratum: 1,
    });

    expect(sampler.sampleMissCandidates().counters).toEqual({
      eligible: 1,
      sampled: 1,
      reviewable: 0,
      unreviewable: 1,
      reviewed: 0,
      miss_confirmed: 0,
    });
  });
});

function task(overrides: Partial<Task>): Task {
  return {
    id: 'task',
    prompt: 'do work',
    cwd: '/repo',
    agentType: 'claude',
    status: 'inProgress',
    sessions: [],
    createdAt: new Date('2026-05-19T09:00:00.000Z'),
    updatedAt: new Date('2026-05-19T09:00:00.000Z'),
    ...overrides,
  };
}
