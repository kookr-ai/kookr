import { describe, expect, it, vi } from 'vitest';
import { sendDirectAgentInput } from './agent-input.js';

describe('sendDirectAgentInput', () => {
  it('sends direct reply input and logs it', async () => {
    const adapter = { sendInput: vi.fn().mockResolvedValue(undefined) };
    const interactionLog = { append: vi.fn().mockResolvedValue(undefined) };

    const result = await sendDirectAgentInput(
      { adapter, interactionLog },
      'agent-1',
      'hello',
      'direct_reply',
    );

    expect(adapter.sendInput).toHaveBeenCalledWith('agent-1', 'hello');
    expect(interactionLog.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user_input',
      agentId: 'agent-1',
      content: 'hello',
      timestamp: result.timestamp,
    }));
  });

  it('sends REST input', async () => {
    const adapter = { sendInput: vi.fn().mockResolvedValue(undefined) };

    await sendDirectAgentInput(
      { adapter },
      'agent-2',
      'ship it',
      'rest_api',
    );

    expect(adapter.sendInput).toHaveBeenCalledWith('agent-2', 'ship it');
  });
});
