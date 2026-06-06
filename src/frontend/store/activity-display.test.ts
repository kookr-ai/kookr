import { describe, expect, test } from 'vitest';
import type { AgentEvent, AgentState } from '../../shared/protocol.js';
import {
  type ActivityDisplayItem,
  buildActivityDisplayItems,
  hasProviderLaunchPrompt,
  normalizeLaunchPrompt,
  summarizeActivityDisplayItems,
} from './activity-display.js';

function agent(events: AgentEvent[], description = 'Launch prompt'): Pick<AgentState, 'agentId' | 'events' | 'description' | 'cwd'> {
  return {
    agentId: 'kookr-test',
    events,
    description,
    cwd: '/repo',
  };
}

function tool(seq: number): AgentEvent {
  return { type: 'tool_use', sessionId: 's1', toolName: 'Bash', toolInput: { command: 'npm test' }, eventSeq: seq };
}

function agentEventSeq(item: ActivityDisplayItem): number | undefined {
  return item.kind === 'agent_event' ? item.event.eventSeq : undefined;
}

describe('activity display projection', () => {
  test('normalizes only outer whitespace and CRLF', () => {
    expect(normalizeLaunchPrompt('\r\nHello\r\nworld\r\n')).toBe('Hello\nworld');
    expect(normalizeLaunchPrompt('Hello')).not.toBe(normalizeLaunchPrompt('hello'));
  });

  test('adds a display-only launch placeholder when raw launch prompt is absent', () => {
    const displayItems = buildActivityDisplayItems(agent([tool(51), tool(52)]));

    expect(displayItems[0]).toMatchObject({
      kind: 'launch_placeholder',
      agentId: 'kookr-test',
      prompt: 'Launch prompt',
      cwd: '/repo',
    });
  });

  test('suppresses placeholder when complete-prefix provider launch prompt is visible', () => {
    const events: AgentEvent[] = [
      { type: 'session_start', sessionId: 's1', eventSeq: 1 },
      { type: 'user_prompt', sessionId: 's1', prompt: 'Launch prompt', eventSeq: 2 },
      tool(3),
    ];

    const displayItems = buildActivityDisplayItems(agent(events));

    expect(displayItems.map((item) => item.kind)).toEqual(['agent_event', 'agent_event', 'agent_event']);
    expect(hasProviderLaunchPrompt(events, 'Launch prompt')).toBe(true);
  });

  test('suppresses placeholder for trim and CRLF-only provider prompt differences', () => {
    const events: AgentEvent[] = [
      { type: 'session_start', sessionId: 's1', eventSeq: 1 },
      { type: 'user_prompt', sessionId: 's1', prompt: '\r\nLaunch\r\nprompt\r\n', eventSeq: 2 },
      tool(3),
    ];

    const displayItems = buildActivityDisplayItems(agent(events, 'Launch\nprompt'));

    expect(displayItems.map((item) => item.kind)).toEqual(['agent_event', 'agent_event', 'agent_event']);
  });

  test('canonicalizes complete-prefix events by eventSeq before detecting launch prompt', () => {
    const events: AgentEvent[] = [
      tool(3),
      { type: 'user_prompt', sessionId: 's1', prompt: 'Launch prompt', eventSeq: 2 },
      { type: 'session_start', sessionId: 's1', eventSeq: 1 },
    ];

    const displayItems = buildActivityDisplayItems(agent(events));

    expect(displayItems.map(agentEventSeq)).toEqual([1, 2, 3]);
    expect(displayItems.every((item) => item.kind === 'agent_event')).toBe(true);
  });

  test('keeps placeholder for capped window starting at later same-text prompt', () => {
    const events: AgentEvent[] = [
      { type: 'user_prompt', sessionId: 's1', prompt: 'Launch prompt', eventSeq: 57 },
    ];

    const displayItems = buildActivityDisplayItems(agent(events));

    expect(displayItems.map((item) => item.kind)).toEqual(['launch_placeholder', 'agent_event']);
    expect(summarizeActivityDisplayItems(displayItems).filter((item) => item.type === 'user_message')).toHaveLength(2);
  });

  test('keeps placeholder when provider launch prompt differs from display prompt', () => {
    const events: AgentEvent[] = [
      { type: 'session_start', sessionId: 's1', eventSeq: 1 },
      { type: 'user_prompt', sessionId: 's1', prompt: '[Kookr launch warning]\n\nLaunch prompt', eventSeq: 2 },
    ];

    const displayItems = buildActivityDisplayItems(agent(events));

    expect(displayItems.map((item) => item.kind)).toEqual(['agent_event', 'launch_placeholder', 'agent_event']);
  });

  test('preserves multiple provider prompts with same text', () => {
    const events: AgentEvent[] = [
      { type: 'session_start', sessionId: 's1', eventSeq: 1 },
      { type: 'user_prompt', sessionId: 's1', prompt: 'Launch prompt', eventSeq: 2 },
      tool(3),
      { type: 'user_prompt', sessionId: 's1', prompt: 'Launch prompt', eventSeq: 4 },
    ];

    const displayItems = buildActivityDisplayItems(agent(events));

    expect(summarizeActivityDisplayItems(displayItems).filter((item) => item.type === 'user_message')).toHaveLength(2);
  });
});
