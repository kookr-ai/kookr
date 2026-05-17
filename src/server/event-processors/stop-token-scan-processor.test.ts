import { describe, expect, test, vi } from 'vitest';
import type { TokenUsage } from '../../core/types.js';
import { createStopTokenScanProcessor } from './stop-token-scan-processor.js';

const usage: TokenUsage = {
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 2,
  cacheWriteTokens: 1,
  costUsd: 0.01,
};

describe('StopTokenScanProcessor', () => {
  test('updates token usage and records token activity only for non-terminal sessions', async () => {
    const tokenUsageWriter = { updateTokenUsage: vi.fn() };
    const tokenScanner = {
      scanTask: vi.fn().mockResolvedValue(true),
      getUsage: vi.fn().mockReturnValue(usage),
    };
    const tokenActivityRecorder = { recordTokenActivity: vi.fn() };
    const broadcastSnapshot = vi.fn();
    const publishTaskProjection = vi.fn();
    const processor = createStopTokenScanProcessor({
      tokenUsageWriter,
      tokenScanner,
      tokenActivityRecorder,
      broadcastSnapshot,
      publishTaskProjection,
    });

    processor.process({
      id: 'task-1',
      sessions: [
        { tmuxSession: 'running-session', lastStatus: 'running' },
        { tmuxSession: 'completed-session', lastStatus: 'completed' },
        { tmuxSession: 'aborted-session', lastStatus: 'aborted' },
      ],
    });

    await vi.waitFor(() => expect(broadcastSnapshot).toHaveBeenCalledTimes(1));
    expect(tokenUsageWriter.updateTokenUsage).toHaveBeenCalledWith('task-1', usage);
    expect(tokenActivityRecorder.recordTokenActivity).toHaveBeenCalledTimes(1);
    expect(tokenActivityRecorder.recordTokenActivity).toHaveBeenCalledWith('running-session');
    expect(publishTaskProjection).toHaveBeenCalledTimes(1);
    expect(publishTaskProjection).toHaveBeenCalledWith('task-1');
  });

  test('does not broadcast when scan reports unchanged usage', async () => {
    const tokenUsageWriter = { updateTokenUsage: vi.fn() };
    const tokenActivityRecorder = { recordTokenActivity: vi.fn() };
    const broadcastSnapshot = vi.fn();
    const publishTaskProjection = vi.fn();
    const processor = createStopTokenScanProcessor({
      tokenUsageWriter,
      tokenScanner: {
        scanTask: vi.fn().mockResolvedValue(false),
        getUsage: vi.fn(),
      },
      tokenActivityRecorder,
      broadcastSnapshot,
      publishTaskProjection,
    });

    processor.process({ id: 'task-1', sessions: [] });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(tokenUsageWriter.updateTokenUsage).not.toHaveBeenCalled();
    expect(tokenActivityRecorder.recordTokenActivity).not.toHaveBeenCalled();
    expect(broadcastSnapshot).not.toHaveBeenCalled();
    expect(publishTaskProjection).not.toHaveBeenCalled();
  });
});
