import { describe, expect, it, vi } from 'vitest';
import { sendDirectAgentInput } from './agent-input.js';

describe('sendDirectAgentInput', () => {
  it('sends direct reply input and logs it', async () => {
    const adapter = { sendInput: vi.fn().mockResolvedValue(undefined) };
    const interactionLog = { append: vi.fn().mockResolvedValue(undefined) };
    const autonomyOrchestrator = {
      onDirectReply: vi.fn(),
      onRestInput: vi.fn(),
    };

    const result = await sendDirectAgentInput(
      { adapter, interactionLog, autonomyOrchestrator },
      'agent-1',
      'hello',
      'direct_reply',
    );

    expect(autonomyOrchestrator.onDirectReply).toHaveBeenCalledWith('agent-1');
    expect(autonomyOrchestrator.onRestInput).not.toHaveBeenCalled();
    expect(adapter.sendInput).toHaveBeenCalledWith('agent-1', 'hello');
    expect(interactionLog.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user_input',
      agentId: 'agent-1',
      content: 'hello',
      timestamp: result.timestamp,
    }));
  });

  it('sends REST input and uses the REST autonomy hook', async () => {
    const adapter = { sendInput: vi.fn().mockResolvedValue(undefined) };
    const autonomyOrchestrator = {
      onDirectReply: vi.fn(),
      onRestInput: vi.fn(),
    };

    await sendDirectAgentInput(
      { adapter, autonomyOrchestrator },
      'agent-2',
      'ship it',
      'rest_api',
    );

    expect(autonomyOrchestrator.onRestInput).toHaveBeenCalledWith('agent-2');
    expect(autonomyOrchestrator.onDirectReply).not.toHaveBeenCalled();
    expect(adapter.sendInput).toHaveBeenCalledWith('agent-2', 'ship it');
  });
});
