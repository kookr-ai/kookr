import { describe, expect, test } from 'vitest';
import type { AgentEvent, AgentState } from '../../shared/protocol.js';
import { mergeActivityAgent } from './activity-history.js';

function agent(events: AgentEvent[], description = 'Launch prompt'): AgentState {
  return {
    agentId: 'kookr-test',
    events,
    anomaly: null,
    description,
    cwd: '/repo',
  };
}

function tool(seq: number): AgentEvent {
  return { type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'npm test' }, eventSeq: seq } as AgentEvent;
}

describe('activity history merging', () => {
  test('does not synthesize launch prompt into stored raw activity', () => {
    const merged = mergeActivityAgent(undefined, agent([tool(51), tool(52)]));

    expect(merged.events).toEqual([tool(51), tool(52)]);
  });

  test('preserves older browser history while appending the non-overlapping tail', () => {
    const previous = agent([
      { type: 'user_prompt', sessionId: 's1', prompt: 'Launch prompt' },
      tool(1),
      tool(2),
      tool(3),
    ]);
    const incoming = agent([tool(2), tool(3), tool(4)]);

    const merged = mergeActivityAgent(previous, incoming);

    expect(merged.events.map((event) => (event as AgentEvent & { eventSeq?: number }).eventSeq ?? 0))
      .toEqual([0, 1, 2, 3, 4]);
  });

  test('monotonic eventSeq keeps repeated identical hook events distinct', () => {
    const previous = agent([tool(1), tool(2), tool(3)]);
    const incoming = agent([tool(2), tool(3), tool(4)]);

    const merged = mergeActivityAgent(previous, incoming);

    expect(merged.events.filter((event) => event.type === 'tool_use')).toHaveLength(4);
  });

  test('incoming eventSeq superset replaces stale browser history', () => {
    const previous = agent([tool(3), tool(4)]);
    const incoming = agent([
      { type: 'session_start', sessionId: 's1', eventSeq: 1 },
      { type: 'user_prompt', sessionId: 's1', prompt: 'Launch prompt', eventSeq: 2 },
      tool(3),
      tool(4),
      tool(5),
    ]);

    const merged = mergeActivityAgent(previous, incoming);

    expect(merged.events.map((event) => event.eventSeq)).toEqual([1, 2, 3, 4, 5]);
  });

  test('JSON subsequence fallback handles legacy events without eventSeq', () => {
    const a: AgentEvent = { type: 'tool_use', sessionId: 's1', toolName: 'Read', toolInput: { file_path: '/a' } };
    const b: AgentEvent = { type: 'tool_use', sessionId: 's1', toolName: 'Read', toolInput: { file_path: '/b' } };
    const c: AgentEvent = { type: 'tool_use', sessionId: 's1', toolName: 'Read', toolInput: { file_path: '/c' } };
    const previous = agent([a, b]);
    const incoming = agent([{ type: 'session_start', sessionId: 's1' }, a, b, c]);

    const merged = mergeActivityAgent(previous, incoming);

    expect(merged.events).toEqual([{ type: 'session_start', sessionId: 's1' }, a, b, c]);
  });

  test('preserves activityMeta when a snapshot omits it', () => {
    const previous = {
      ...agent([tool(1)]),
      activityMeta: {
        totalEventsSeen: 4,
        parentEventCount: 2,
        childEventCount: 1,
        foreignEventCount: 0,
        unknownParentageCount: 0,
        malformedRecordCount: 1,
        droppedRecordCount: 0,
        duplicateRecordCount: 0,
      },
    };
    const incoming = agent([tool(2)]);

    const merged = mergeActivityAgent(previous, incoming);

    expect(merged.activityMeta).toEqual(previous.activityMeta);
  });
});
