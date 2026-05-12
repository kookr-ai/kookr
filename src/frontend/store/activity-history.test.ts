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
  test('restores the persisted launch prompt when a windowed snapshot no longer contains it', () => {
    const merged = mergeActivityAgent(undefined, agent([tool(51), tool(52)]));

    expect(merged.events[0]).toMatchObject({
      type: 'user_prompt',
      prompt: 'Launch prompt',
      sessionId: 'kookr-test',
      cwd: '/repo',
    });
    expect(merged.events.slice(1)).toEqual([tool(51), tool(52)]);
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
});
