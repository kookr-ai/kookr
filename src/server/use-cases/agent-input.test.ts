import { describe, expect, it, vi } from 'vitest';
import { InputSubmitAbortedError } from '../../adapters/composer-input.js';
import type { SendInputOptions } from '../../core/ports/agent-interaction-port.js';
import { AgentInputRefusedError, sendDirectAgentInput } from './agent-input.js';

describe('sendDirectAgentInput — choice-dialog guard (issue #3513)', () => {
  // At a permission prompt / AskUserQuestion menu the pasted text is discarded
  // and the trailing Enter selects the highlighted option.
  it('refuses up front while the agent is on a choice dialog and never types', async () => {
    const adapter = { sendInput: vi.fn().mockResolvedValue(undefined) };
    const interactionLog = { append: vi.fn().mockResolvedValue(undefined) };

    const attempt = sendDirectAgentInput(
      { adapter, interactionLog, isAwaitingChoice: () => true },
      'agent-1',
      'please continue',
    );

    await expect(attempt).rejects.toBeInstanceOf(AgentInputRefusedError);
    await expect(attempt).rejects.toMatchObject({ code: 'awaiting_choice' });
    expect(adapter.sendInput).not.toHaveBeenCalled();
    expect(interactionLog.append).not.toHaveBeenCalled();
  });

  it('passes a beforeSubmit re-check that vetoes Enter if a dialog appears mid-typing', async () => {
    let awaiting = false;
    let vetoed: boolean | undefined;
    const adapter = {
      sendInput: vi.fn(async (_id: string, _text: string, opts?: SendInputOptions) => {
        awaiting = true; // a menu pops up while the text is being typed
        vetoed = !(await opts?.beforeSubmit?.());
        if (vetoed) throw new InputSubmitAbortedError('agent-1');
      }),
    };

    await expect(sendDirectAgentInput({ adapter, isAwaitingChoice: () => awaiting }, 'agent-1', 'go on'))
      .rejects.toBeInstanceOf(AgentInputRefusedError);
    expect(vetoed).toBe(true);
  });

  it('delivers when the agent is not on a choice dialog (idle or busy mid-turn)', async () => {
    const adapter = { sendInput: vi.fn().mockResolvedValue(undefined) };

    await sendDirectAgentInput({ adapter, isAwaitingChoice: () => false }, 'agent-1', 'next slice please');

    expect(adapter.sendInput).toHaveBeenCalledWith(
      'agent-1',
      'next slice please',
      expect.objectContaining({ beforeSubmit: expect.any(Function) }),
    );
  });
});

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

  it('threads an attributed actor into the logged event (issue #1526 Phase B)', async () => {
    const adapter = { sendInput: vi.fn().mockResolvedValue(undefined) };
    const interactionLog = { append: vi.fn().mockResolvedValue(undefined) };

    await sendDirectAgentInput(
      { adapter, interactionLog },
      'agent-1',
      'nudge it',
      'lucy-supervisor',
    );

    expect(interactionLog.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user_input',
      agentId: 'agent-1',
      content: 'nudge it',
      actor: 'lucy-supervisor',
    }));
  });

  it('omits the actor field entirely when none is supplied', async () => {
    const adapter = { sendInput: vi.fn().mockResolvedValue(undefined) };
    const interactionLog = { append: vi.fn().mockResolvedValue(undefined) };

    await sendDirectAgentInput({ adapter, interactionLog }, 'agent-1', 'hi');

    const [event] = interactionLog.append.mock.calls[0] as [Record<string, unknown>];
    expect(event).not.toHaveProperty('actor');
  });
});
