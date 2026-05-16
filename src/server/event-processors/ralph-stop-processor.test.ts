import { describe, expect, test, vi } from 'vitest';
import type { Task } from '../../core/tasks.js';
import { createRalphStopProcessor } from './ralph-stop-processor.js';

function ralphTask(status: 'running' | 'completed'): Task {
  return {
    id: 'task-1',
    prompt: 'iterate',
    cwd: '/repo',
    agentType: 'claude-code',
    status: 'inProgress',
    sessions: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ralphLoop: {
      prompt: 'iterate',
      iterationCap: 5,
      currentIteration: 1,
      status,
      lastIterationStartedAt: 0,
      cumulativeIterations: 1,
    },
  };
}

describe('RalphStopProcessor', () => {
  test('finalizes completed loops and broadcasts when finalization changes state', async () => {
    const broadcastSnapshot = vi.fn();
    const ralphLoopService = {
      finalizeCompletedLoopStop: vi.fn().mockResolvedValue(true),
      handleStopEvent: vi.fn(),
    };
    const processor = createRalphStopProcessor({
      taskCostReader: { getUsage: vi.fn() },
      runningLoopHandlingEnabled: false,
      ralphStopHandler: ralphLoopService,
      broadcastSnapshot,
    });
    const event = { type: 'stop' as const, sessionId: 's1', lastMessage: 'done' };

    processor.process(ralphTask('completed'), 'agent-1', event);

    await vi.waitFor(() => expect(broadcastSnapshot).toHaveBeenCalledTimes(1));
    expect(ralphLoopService.finalizeCompletedLoopStop).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1' }),
      'agent-1',
      event,
    );
    expect(ralphLoopService.handleStopEvent).not.toHaveBeenCalled();
  });

  test('handles running loops with cumulative cost when enabled', async () => {
    const ralphLoopService = {
      finalizeCompletedLoopStop: vi.fn(),
      handleStopEvent: vi.fn().mockResolvedValue(undefined),
    };
    const processor = createRalphStopProcessor({
      taskCostReader: { getUsage: vi.fn().mockReturnValue({ costUsd: 0.42 }) },
      runningLoopHandlingEnabled: true,
      ralphStopHandler: ralphLoopService,
      broadcastSnapshot: vi.fn(),
    });
    const event = { type: 'stop' as const, sessionId: 's1', lastMessage: 'again' };

    processor.process(ralphTask('running'), 'agent-1', event);

    await vi.waitFor(() => expect(ralphLoopService.handleStopEvent).toHaveBeenCalledTimes(1));
    expect(ralphLoopService.handleStopEvent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'task-1' }),
      'agent-1',
      event,
      { cumulativeCostUsd: 0.42 },
    );
    expect(ralphLoopService.finalizeCompletedLoopStop).not.toHaveBeenCalled();
  });

  test('does not handle running loops when disabled', async () => {
    const ralphLoopService = {
      finalizeCompletedLoopStop: vi.fn(),
      handleStopEvent: vi.fn().mockResolvedValue(undefined),
    };
    const processor = createRalphStopProcessor({
      taskCostReader: { getUsage: vi.fn() },
      runningLoopHandlingEnabled: false,
      ralphStopHandler: ralphLoopService,
      broadcastSnapshot: vi.fn(),
    });

    processor.process(ralphTask('running'), 'agent-1', { type: 'stop', sessionId: 's1', lastMessage: 'again' });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ralphLoopService.handleStopEvent).not.toHaveBeenCalled();
    expect(ralphLoopService.finalizeCompletedLoopStop).not.toHaveBeenCalled();
  });
});
