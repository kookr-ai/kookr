import { describe, expect, test, vi } from 'vitest';
import type { Task } from '../../core/tasks.js';
import { createTokenAccountingProcessor } from './token-accounting-processor.js';

function mockTask(id = 'task-1'): Task {
  return {
    id,
    prompt: 'Task',
    cwd: '/repo',
    agentType: 'claude-code',
    status: 'inProgress',
    createdAt: new Date(),
    updatedAt: new Date(),
    sessions: [{ tmuxSession: 'kookr-agent', agentType: 'claude-code', createdAt: new Date(), cwd: '/repo' }],
  } as Task;
}

describe('TokenAccountingProcessor', () => {
  test('defers session_start transcript registration until the task is findable', () => {
    const taskStore = {
      findTaskBySession: vi.fn()
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce(mockTask()),
    };
    const tokenTracker = { register: vi.fn() };
    const processor = createTokenAccountingProcessor({
      taskLookup: taskStore,
      transcriptRegistry: tokenTracker,
    });

    processor.process({
      tmuxName: 'kookr-agent',
      event: { type: 'session_start', sessionId: 's1', transcriptPath: '/tmp/transcript.jsonl' },
    });

    expect(tokenTracker.register).not.toHaveBeenCalled();

    processor.process({
      tmuxName: 'kookr-agent',
      event: { type: 'tool_use', sessionId: 's1', toolName: 'Read', toolUseId: 'tu-1' },
    });

    expect(tokenTracker.register).toHaveBeenCalledTimes(1);
    expect(tokenTracker.register).toHaveBeenCalledWith('/tmp/transcript.jsonl', 'task-1');

    processor.process({
      tmuxName: 'kookr-agent',
      event: { type: 'tool_result', sessionId: 's1', toolName: 'Read', toolUseId: 'tu-1' },
    });

    expect(tokenTracker.register).toHaveBeenCalledTimes(1);
  });

  test('registers subagent transcript paths against the parent task', () => {
    const taskStore = { findTaskBySession: vi.fn().mockReturnValue(mockTask('parent-task')) };
    const tokenTracker = { register: vi.fn() };
    const processor = createTokenAccountingProcessor({
      taskLookup: taskStore,
      transcriptRegistry: tokenTracker,
    });

    processor.process({
      tmuxName: 'kookr-agent',
      event: {
        type: 'subagent_stop',
        sessionId: 's1',
        agentId: 'reviewer-1',
        agentType: 'reviewer',
        lastMessage: '',
        agentTranscriptPath: '/tmp/sidechain.jsonl',
      },
    });

    expect(tokenTracker.register).toHaveBeenCalledWith('/tmp/sidechain.jsonl', 'parent-task');
  });
});
