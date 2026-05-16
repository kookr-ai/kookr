import { afterEach, describe, expect, test, vi } from 'vitest';
import { createCheckpointStopProcessor } from './checkpoint-stop-processor.js';

describe('CheckpointStopProcessor', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test('sends cycler input actions through the input sender', async () => {
    const inputSender = { sendInput: vi.fn().mockResolvedValue(undefined) };
    const checkpointCycler = {
      onStop: vi.fn().mockReturnValue({ kind: 'send_input', tmuxName: 'agent-1', text: '/compact' }),
    };
    const processor = createCheckpointStopProcessor({ inputSender, checkpointCycler });

    processor.process('agent-1');

    expect(checkpointCycler.onStop).toHaveBeenCalledWith('agent-1');
    expect(inputSender.sendInput).toHaveBeenCalledWith('agent-1', '/compact');
  });

  test('does not call the cycler when checkpoint cycling is disabled', () => {
    vi.stubEnv('KOOKR_CHECKPOINT_CYCLE_DISABLED', '1');
    const inputSender = { sendInput: vi.fn().mockResolvedValue(undefined) };
    const checkpointCycler = { onStop: vi.fn().mockReturnValue({ kind: 'noop' }) };
    const processor = createCheckpointStopProcessor({ inputSender, checkpointCycler });

    processor.process('agent-1');

    expect(checkpointCycler.onStop).not.toHaveBeenCalled();
    expect(inputSender.sendInput).not.toHaveBeenCalled();
  });
});
