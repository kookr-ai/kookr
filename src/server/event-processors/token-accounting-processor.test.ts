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

  describe('following a subagent from its start', () => {
    const PARENT = '/srv/claude/projects/-repo/5e55.jsonl';
    const GUESSED = '/srv/claude/projects/-repo/5e55/subagents/agent-a1b2.jsonl';

    function build(task: Task | null = mockTask('parent-task')) {
      const tokenTracker = { register: vi.fn(), unregister: vi.fn() };
      const processor = createTokenAccountingProcessor({
        taskLookup: { findTaskBySession: vi.fn().mockReturnValue(task) },
        transcriptRegistry: tokenTracker,
      });
      const start = (overrides: { agentId?: string; transcriptPath?: string } = {}) => processor.process({
        tmuxName: 'kookr-agent',
        event: {
          type: 'subagent_start',
          sessionId: 's1',
          agentId: 'a1b2',
          agentType: 'general-purpose',
          transcriptPath: PARENT,
          ...overrides,
        },
      });
      const stop = (agentTranscriptPath: string | undefined, agentId = 'a1b2') => processor.process({
        tmuxName: 'kookr-agent',
        event: { type: 'subagent_stop', sessionId: 's1', agentId, agentType: 'general-purpose', lastMessage: '', agentTranscriptPath },
      });
      return { tokenTracker, start, stop };
    }

    test('registers the subagent transcript when the subagent starts', () => {
      const { tokenTracker, start } = build();
      start();
      expect(tokenTracker.register).toHaveBeenCalledWith(GUESSED, 'parent-task');
    });

    test('the stop report for the same path changes nothing', () => {
      const { tokenTracker, start, stop } = build();
      start();
      stop(GUESSED);
      expect(tokenTracker.unregister).not.toHaveBeenCalled();
      // Registered again with the same path: the tracker ignores a path it already has.
      expect(tokenTracker.register.mock.calls).toEqual([[GUESSED, 'parent-task'], [GUESSED, 'parent-task']]);
    });

    test('a wrong guess is dropped once the real path is reported', () => {
      const { tokenTracker, start, stop } = build();
      const real = '/srv/claude/projects/-repo/5e55/subagents/workflows/wf_1/agent-a1b2.jsonl';
      start();
      stop(real);
      expect(tokenTracker.unregister).toHaveBeenCalledWith(GUESSED);
      expect(tokenTracker.register).toHaveBeenLastCalledWith(real, 'parent-task');
    });

    test('a start without a parent transcript, or with an unsafe id, registers nothing', () => {
      const { tokenTracker, start } = build();
      start({ transcriptPath: undefined });
      start({ agentId: '../../etc/passwd' });
      expect(tokenTracker.register).not.toHaveBeenCalled();
    });

    test('does nothing for an agent whose task is unknown, or a Grok Build task', () => {
      const unknown = build(null);
      unknown.start();
      expect(unknown.tokenTracker.register).not.toHaveBeenCalled();

      const grok = build(mockTask('grok-task', 'grok-build'));
      grok.start();
      expect(grok.tokenTracker.register).not.toHaveBeenCalled();
    });

    test('a stop with no path report leaves the guessed registration in place', () => {
      const { tokenTracker, start, stop } = build();
      start();
      stop(undefined);
      expect(tokenTracker.unregister).not.toHaveBeenCalled();
      expect(tokenTracker.register).toHaveBeenCalledTimes(1);
    });
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
