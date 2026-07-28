import { describe, expect, test, vi } from 'vitest';
import type { Task } from '../../core/tasks.js';
import { createTokenAccountingProcessor } from './token-accounting-processor.js';

function mockTask(id = 'task-1', agentType: Task['agentType'] = 'claude-code'): Task {
  return {
    id,
    prompt: 'Task',
    cwd: '/repo',
    agentType,
    status: 'inProgress',
    createdAt: new Date(),
    updatedAt: new Date(),
    sessions: [{ tmuxSession: 'kookr-agent', agentType, createdAt: new Date(), cwd: '/repo' }],
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

  test('does not register Grok Build transcripts with the Claude-format TokenTracker', () => {
    // Grok writes a different transcript schema and is metered by its own
    // adapter at stop (issue #1581); registering here yields phantom all-zero
    // usage that would clobber the real counts.
    const taskStore = { findTaskBySession: vi.fn().mockReturnValue(mockTask('grok-task', 'grok-build')) };
    const tokenTracker = { register: vi.fn() };
    const processor = createTokenAccountingProcessor({
      taskLookup: taskStore,
      transcriptRegistry: tokenTracker,
    });

    processor.process({
      tmuxName: 'kookr-agent',
      event: { type: 'session_start', sessionId: 's1', transcriptPath: '/tmp/grok.jsonl' },
    });
    processor.process({
      tmuxName: 'kookr-agent',
      event: {
        type: 'subagent_stop',
        sessionId: 's1',
        agentId: 'sub-1',
        agentType: 'general-purpose',
        lastMessage: '',
        agentTranscriptPath: '/tmp/grok-sidechain.jsonl',
      },
    });

    expect(tokenTracker.register).not.toHaveBeenCalled();
  });

  test('does not register a Grok transcript even via the deferred pending-drain path', () => {
    // session_start arrives before the task is findable (returns null), so the
    // path defers; a later event drains the pending registration. The grok skip
    // must hold on that drain path too, not only on the direct registration.
    const taskStore = {
      findTaskBySession: vi.fn()
        .mockReturnValueOnce(null)
        .mockReturnValue(mockTask('grok-task', 'grok-build')),
    };
    const tokenTracker = { register: vi.fn() };
    const processor = createTokenAccountingProcessor({
      taskLookup: taskStore,
      transcriptRegistry: tokenTracker,
    });

    processor.process({
      tmuxName: 'kookr-agent',
      event: { type: 'session_start', sessionId: 's1', transcriptPath: '/tmp/grok.jsonl' },
    });
    processor.process({
      tmuxName: 'kookr-agent',
      event: { type: 'tool_use', sessionId: 's1', toolName: 'read_file', toolUseId: 'tu-1' },
    });

    expect(tokenTracker.register).not.toHaveBeenCalled();
  });
});
