import { describe, test, expect } from 'vitest';
import { buildInteractionSlice } from './feedback-bundle.js';
import type { InteractionEvent } from './interaction-log.js';
import { aSession, aTask } from './__fixtures__/task-builders.js';

function sessions(sessionIds: string[]) {
  return sessionIds.map((tmuxSession) => aSession({ tmuxSession, cwd: '/tmp/repo', createdAt: new Date() }));
}

describe('buildInteractionSlice', () => {
  test('returns events keyed by any of the task session names', () => {
    const task = aTask({
      id: 't1',
      prompt: 'do the thing',
      cwd: '/tmp/repo',
      status: 'completed',
      sessions: sessions(['sess-a', 'sess-b']),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const events: InteractionEvent[] = [
      { type: 'user_input', agentId: 'sess-a', content: 'hi', timestamp: '2026-01-01T00:00:00Z' },
      { type: 'user_input', agentId: 'sess-b', content: 'hi b', timestamp: '2026-01-01T00:00:01Z' },
      { type: 'user_input', agentId: 'other-task', content: 'noise', timestamp: '2026-01-01T00:00:02Z' },
    ];
    const slice = buildInteractionSlice(task, events);
    expect(slice).toHaveLength(2);
    expect(slice.map((e) => 'agentId' in e ? e.agentId : '')).toEqual(['sess-a', 'sess-b']);
  });

  test('includes events that carry taskId directly', () => {
    const task = aTask({
      id: 't1',
      prompt: 'do the thing',
      cwd: '/tmp/repo',
      status: 'completed',
      sessions: sessions(['sess-a']),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const events: InteractionEvent[] = [
      { type: 'task_completed', taskId: 't1', agentId: 'sess-a', reason: 'user_marked', durationMs: 1000, timestamp: '2026-01-01T00:00:00Z' },
      { type: 'task_completed', taskId: 'other', agentId: 'other-sess', reason: 'user_marked', durationMs: 1000, timestamp: '2026-01-01T00:00:01Z' },
    ];
    const slice = buildInteractionSlice(task, events);
    expect(slice).toHaveLength(1);
    expect(slice[0].type).toBe('task_completed');
    expect('taskId' in slice[0] && slice[0].taskId).toBe('t1');
  });

  test('handles multi-session tasks (crash-recovery relaunches)', () => {
    const task = aTask({
      id: 't1',
      prompt: 'do the thing',
      cwd: '/tmp/repo',
      status: 'completed',
      sessions: sessions(['sess-1', 'sess-2', 'sess-3']),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const events: InteractionEvent[] = [
      { type: 'agent_launched', agentId: 'sess-1', taskPrompt: 'p', timestamp: '2026-01-01T00:00:00Z' },
      { type: 'agent_launched', agentId: 'sess-2', taskPrompt: 'p', timestamp: '2026-01-01T00:01:00Z' },
      { type: 'agent_launched', agentId: 'sess-3', taskPrompt: 'p', timestamp: '2026-01-01T00:02:00Z' },
      { type: 'agent_launched', agentId: 'unrelated', taskPrompt: 'p', timestamp: '2026-01-01T00:03:00Z' },
    ];
    const slice = buildInteractionSlice(task, events);
    expect(slice).toHaveLength(3);
  });

  test('returns empty slice when no events match', () => {
    const task = aTask({
      id: 't1',
      prompt: 'do the thing',
      cwd: '/tmp/repo',
      status: 'completed',
      sessions: sessions(['sess-x']),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const events: InteractionEvent[] = [
      { type: 'user_input', agentId: 'sess-y', content: 'noise', timestamp: '2026-01-01T00:00:00Z' },
    ];
    expect(buildInteractionSlice(task, events)).toHaveLength(0);
  });
});
