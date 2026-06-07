import { describe, expect, test } from 'vitest';
import type { AgentEvent } from './types.js';
import { deriveLatestCompletionSignal } from './completion-signal.js';

function stop(lastMessage = 'Done.', eventSeq = 3): AgentEvent {
  return { type: 'stop', sessionId: 's1', lastMessage, eventSeq };
}

function userPrompt(eventSeq = 2): AgentEvent {
  return { type: 'user_prompt', sessionId: 's1', prompt: 'continue', eventSeq };
}

function signal(events: AgentEvent[]) {
  return deriveLatestCompletionSignal({
    taskId: 'task-1',
    agentId: 'agent-1',
    taskStatus: 'inProgress',
    events,
  });
}

describe('deriveLatestCompletionSignal', () => {
  test('projects a signal for an in-progress completed turn', () => {
    const result = signal([
      { type: 'session_start', sessionId: 's1', eventSeq: 1 },
      { type: 'tool_use', sessionId: 's1', toolName: 'Bash', eventSeq: 2 },
      stop('Implemented the requested change.', 3),
    ]);

    expect(result?.id).toHaveLength(16);
  });

  test('omits terminal tasks', () => {
    expect(deriveLatestCompletionSignal({
      taskId: 'task-1',
      agentId: 'agent-1',
      taskStatus: 'completed',
      events: [stop()],
    })).toBeUndefined();
  });

  test('omits non-completed turn states', () => {
    expect(signal([{ type: 'tool_use', sessionId: 's1', toolName: 'Bash', eventSeq: 1 }])).toBeUndefined();
    expect(signal([{ type: 'permission_request', sessionId: 's1', toolName: 'Bash', eventSeq: 1 }])).toBeUndefined();
    expect(signal([{ type: 'tool_use', sessionId: 's1', toolName: 'AskUserQuestion', eventSeq: 1 }])).toBeUndefined();
  });

  test('omits empty final messages', () => {
    expect(signal([stop('   ', 1)])).toBeUndefined();
  });

  test('trailing overlays do not change the signal identity', () => {
    const base = signal([userPrompt(1), stop('PR opened.', 2)]);
    const withOverlay = signal([
      userPrompt(1),
      stop('PR opened.', 2),
      { type: 'notification', sessionId: 's1', notificationType: 'idle_prompt', message: 'waiting', eventSeq: 3 },
    ]);

    expect(withOverlay?.id).toBe(base?.id);
  });

  test('snapshot replay of the same Stop event keeps the same id', () => {
    const first = signal([userPrompt(1), stop('All done.', 2)]);
    const duplicate = signal([userPrompt(1), stop('All done.', 2)]);

    expect(duplicate?.id).toBe(first?.id);
  });

  test('a later Stop event with the same final message produces a new id', () => {
    const first = signal([userPrompt(1), stop('All done.', 2)]);
    const laterStop = signal([userPrompt(1), stop('All done.', 2), stop('All done.', 3)]);

    expect(laterStop?.id).not.toBe(first?.id);
  });

  test('a follow-up turn with the same final message produces a new id', () => {
    const first = signal([userPrompt(1), stop('All done.', 2)]);
    const second = signal([userPrompt(1), stop('All done.', 2), userPrompt(3), stop('All done.', 4)]);

    expect(second?.id).not.toBe(first?.id);
  });
});
