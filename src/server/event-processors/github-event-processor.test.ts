import { describe, expect, test, vi } from 'vitest';
import { createGitHubEventProcessor } from './github-event-processor.js';

describe('GitHubEventProcessor', () => {
  test('uses recent post-state events when scanner is active and task is in progress', () => {
    const githubScanner = {
      isActive: vi.fn().mockReturnValue(true),
      processEventsImmediate: vi.fn().mockResolvedValue(undefined),
    };
    const taskLookup = {
      findTaskBySession: vi.fn().mockReturnValue({ id: 'task-1', status: 'inProgress' }),
    };
    const processor = createGitHubEventProcessor({ githubScanner, taskLookup });

    const events = Array.from({ length: 25 }, (_, i) => ({
      type: 'tool_use' as const,
      sessionId: 's1',
      toolName: `Tool${i}`,
    }));
    processor.process({
      tmuxName: 'agent-1',
      event: events[0],
      postState: { agentId: 'agent-1', anomaly: null, events },
    });

    expect(githubScanner.processEventsImmediate).toHaveBeenCalledWith(
      'agent-1',
      events.slice(-20),
      'task-1',
    );
  });

  test('skips inactive scanner before looking up the task', () => {
    const githubScanner = {
      isActive: vi.fn().mockReturnValue(false),
      processEventsImmediate: vi.fn().mockResolvedValue(undefined),
    };
    const taskLookup = { findTaskBySession: vi.fn() };
    const processor = createGitHubEventProcessor({
      githubScanner,
      taskLookup,
    });

    processor.process({
      tmuxName: 'agent-1',
      event: { type: 'tool_use', sessionId: 's1', toolName: 'Read' },
      postState: undefined,
    });

    expect(taskLookup.findTaskBySession).not.toHaveBeenCalled();
    expect(githubScanner.processEventsImmediate).not.toHaveBeenCalled();
  });

  test('skips non-running tasks when the scanner is active', () => {
    const githubScanner = {
      isActive: vi.fn().mockReturnValue(true),
      processEventsImmediate: vi.fn().mockResolvedValue(undefined),
    };
    const processor = createGitHubEventProcessor({
      githubScanner,
      taskLookup: { findTaskBySession: vi.fn().mockReturnValue({ id: 'task-1', status: 'completed' }) },
    });

    processor.process({
      tmuxName: 'agent-1',
      event: { type: 'tool_use', sessionId: 's1', toolName: 'Read' },
      postState: undefined,
    });

    expect(githubScanner.processEventsImmediate).not.toHaveBeenCalled();
  });
});
