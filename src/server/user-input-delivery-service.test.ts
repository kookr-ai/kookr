import { describe, expect, it, vi } from 'vitest';
import { UserInputDeliveryService } from './user-input-delivery-service.js';

describe('UserInputDeliveryService', () => {
  it('records a queued delivery when terminal input is accepted', async () => {
    const sendInput = vi.fn(async () => undefined);
    const append = vi.fn(async () => undefined);
    const service = new UserInputDeliveryService({
      adapter: { sendInput },
      interactionLog: { append } as any,
      idGenerator: () => 'delivery-1',
      now: () => new Date('2026-06-06T10:00:00.000Z'),
    });

    const delivery = await service.submitMessage('s1', 'continue', 'respond');

    expect(sendInput).toHaveBeenCalledWith('s1', 'continue');
    expect(append).toHaveBeenCalledWith({
      type: 'user_input',
      agentId: 's1',
      content: 'continue',
      timestamp: '2026-06-06T10:00:00.000Z',
    });
    expect(delivery).toMatchObject({
      deliveryId: 'delivery-1',
      sessionId: 's1',
      deliverySeq: 1,
      text: 'continue',
      status: 'queued',
      ptyAcceptedAt: '2026-06-06T10:00:00.000Z',
    });
    expect(service.getSnapshot('s1')).toEqual([delivery]);
  });

  it('marks delivery failed when terminal input is rejected', async () => {
    const sendInput = vi.fn(async () => {
      throw new Error('session closed');
    });
    const service = new UserInputDeliveryService({
      adapter: { sendInput },
      idGenerator: () => 'delivery-1',
      now: () => new Date('2026-06-06T10:00:00.000Z'),
    });

    await expect(service.submitMessage('s1', 'continue', 'directReply')).rejects.toThrow('session closed');

    expect(service.getSnapshot('s1')[0]).toMatchObject({
      deliveryId: 'delivery-1',
      source: 'directReply',
      status: 'failed',
      error: 'session closed',
    });
  });

  it('marks accepted delivery submitted on exact provider prompt match', async () => {
    const service = new UserInputDeliveryService({
      adapter: { sendInput: vi.fn(async () => undefined) },
      idGenerator: () => 'delivery-1',
      now: () => new Date('2026-06-06T10:00:00.000Z'),
    });
    await service.submitMessage('s1', 'continue\n', 'respond');

    service.observeProviderUserPrompt('s1', 'continue', 'hook-1');

    expect(service.getSnapshot('s1')[0]).toMatchObject({
      status: 'submitted_by_agent',
      submittedHookLineId: 'hook-1',
    });
  });

  it('ignores provider prompts observed at or before delivery creation', async () => {
    const service = new UserInputDeliveryService({
      adapter: { sendInput: vi.fn(async () => undefined) },
      idGenerator: () => 'delivery-1',
      now: () => new Date('2026-06-06T10:00:00.000Z'),
    });
    await service.submitMessage('s1', 'continue', 'respond');

    service.observeProviderUserPrompt('s1', 'continue', 'stale-hook', Date.parse('2026-06-06T10:00:00.000Z'));

    const delivery = service.getSnapshot('s1')[0];
    expect(delivery).toMatchObject({ status: 'queued' });
    expect(delivery).not.toHaveProperty('submittedHookLineId');
  });

  it('keeps accepted delivery queued when provider prompt does not match exactly', async () => {
    const service = new UserInputDeliveryService({
      adapter: { sendInput: vi.fn(async () => undefined) },
      idGenerator: () => 'delivery-1',
      now: () => new Date('2026-06-06T10:00:00.000Z'),
    });
    await service.submitMessage('s1', 'continue', 'respond');

    service.observeProviderUserPrompt('s1', 'different', 'hook-1');

    const delivery = service.getSnapshot('s1')[0];
    expect(delivery).toMatchObject({ status: 'queued' });
    expect(delivery).not.toHaveProperty('submittedHookLineId');
  });

  it('finalizes queued deliveries when a session ends before submit hook', async () => {
    const service = new UserInputDeliveryService({
      adapter: { sendInput: vi.fn(async () => undefined) },
      idGenerator: () => 'delivery-1',
      now: () => new Date('2026-06-06T10:00:00.000Z'),
    });
    await service.submitMessage('s1', 'continue', 'respond');

    service.finalizeSession('s1');

    expect(service.getSnapshot('s1')[0]).toMatchObject({
      status: 'failed',
      terminalReason: 'session_ended_before_submit_hook',
    });
  });

  it('does not overwrite session-end finalization when terminal write resolves later', async () => {
    let resolveSendInput!: () => void;
    const sendInput = vi.fn(() => new Promise<void>((resolve) => {
      resolveSendInput = resolve;
    }));
    const service = new UserInputDeliveryService({
      adapter: { sendInput },
      idGenerator: () => 'delivery-1',
      now: () => new Date('2026-06-06T10:00:00.000Z'),
    });

    const submit = service.submitMessage('s1', 'continue', 'respond');
    service.finalizeSession('s1');
    resolveSendInput();
    await submit;

    expect(service.getSnapshot('s1')[0]).toMatchObject({
      status: 'failed',
      terminalReason: 'session_ended_before_submit_hook',
    });
  });
});
