import { describe, expect, it, vi } from 'vitest';
import { sendDirectAgentInput } from './agent-input.js';

describe('sendDirectAgentInput', () => {
  it('sends input via the adapter and appends a user_input event to the log', async () => {
    const adapter = { sendInput: vi.fn().mockResolvedValue(undefined) };
    const interactionLog = { append: vi.fn().mockResolvedValue(undefined) };

    const result = await sendDirectAgentInput(
      { adapter, interactionLog },
      'agent-1',
      'hello',
    );

    expect(adapter.sendInput).toHaveBeenCalledWith('agent-1', 'hello');
    expect(interactionLog.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user_input',
      agentId: 'agent-1',
      content: 'hello',
      timestamp: result.timestamp,
    }));
  });

  it('is a no-op for the interaction log when no writer is configured', async () => {
    const adapter = { sendInput: vi.fn().mockResolvedValue(undefined) };

    await sendDirectAgentInput(
      { adapter },
      'agent-2',
      'ship it',
    );

    expect(adapter.sendInput).toHaveBeenCalledWith('agent-2', 'ship it');
  });
});
