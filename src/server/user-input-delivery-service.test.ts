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
      source: 'respond',
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

describe('UserInputDeliveryService submit-retry sweep', () => {
  const T0 = '2026-06-06T10:00:00.000Z';
  const STUCK_MESSAGE = 'pending dashboard reply';

  function makeService(opts: {
    pane?: string | (() => string);
    capturePane?: (sessionId: string) => Promise<string>;
    confirmTimeoutMs?: number;
    maxEnterRetries?: number;
  } = {}) {
    let nowMs = Date.parse(T0);
    const sendEnter = vi.fn(async () => undefined);
    const capturePane = opts.capturePane ?? vi.fn(async () => (
      typeof opts.pane === 'function' ? opts.pane() : opts.pane ?? `❯ ${STUCK_MESSAGE}`
    ));
    const service = new UserInputDeliveryService({
      adapter: { sendInput: vi.fn(async () => undefined) },
      retry: {
        sendEnter,
        capturePane,
        confirmTimeoutMs: opts.confirmTimeoutMs ?? 15_000,
        maxEnterRetries: opts.maxEnterRetries ?? 2,
      },
      now: () => new Date(nowMs),
    });
    return {
      service,
      sendEnter,
      capturePane,
      advance: (ms: number) => {
        nowMs += ms;
      },
    };
  }

  it('re-sends Enter for a delivery stuck queued past the confirm timeout', async () => {
    const { service, sendEnter, advance } = makeService();
    await service.submitMessage('s1', STUCK_MESSAGE, 'respond');

    advance(15_000);
    expect(await service.sweepUnsubmittedDeliveries()).toBe(1);

    expect(sendEnter).toHaveBeenCalledWith('s1');
    expect(service.getSnapshot('s1')[0]).toMatchObject({
      status: 'queued',
      enterRetries: 1,
    });
  });

  it('does nothing before the confirm timeout elapses', async () => {
    const { service, sendEnter, advance } = makeService();
    await service.submitMessage('s1', STUCK_MESSAGE, 'respond');

    advance(14_000);
    expect(await service.sweepUnsubmittedDeliveries()).toBe(0);
    expect(sendEnter).not.toHaveBeenCalled();
  });

  it('skips deliveries already confirmed by the provider hook', async () => {
    const { service, sendEnter, advance } = makeService();
    await service.submitMessage('s1', 'continue', 'respond');
    advance(1_000);
    service.observeProviderUserPrompt('s1', 'continue', 'hook-1', Date.parse(T0) + 1_000);

    advance(60_000);
    expect(await service.sweepUnsubmittedDeliveries()).toBe(0);
    expect(sendEnter).not.toHaveBeenCalled();
  });

  it('caps bare-Enter retries per delivery', async () => {
    const { service, sendEnter, advance } = makeService({ maxEnterRetries: 2 });
    await service.submitMessage('s1', STUCK_MESSAGE, 'respond');

    advance(15_000);
    expect(await service.sweepUnsubmittedDeliveries()).toBe(1);
    advance(15_000);
    expect(await service.sweepUnsubmittedDeliveries()).toBe(1);
    advance(15_000);
    expect(await service.sweepUnsubmittedDeliveries()).toBe(0);

    expect(sendEnter).toHaveBeenCalledTimes(2);
    expect(service.getSnapshot('s1')[0]).toMatchObject({ enterRetries: 2 });
  });

  it('never injects Enter while the pane shows a busy marker', async () => {
    const { service, sendEnter, advance } = makeService({
      pane: `Generating... esc to interrupt\n❯ ${STUCK_MESSAGE}`,
    });
    await service.submitMessage('s1', STUCK_MESSAGE, 'respond');

    advance(15_000);
    expect(await service.sweepUnsubmittedDeliveries()).toBe(0);
    expect(sendEnter).not.toHaveBeenCalled();
  });

  it('never injects Enter while the pane shows a permission dialog', async () => {
    const { service, sendEnter, advance } = makeService({
      pane: 'Do you want to proceed?\n❯ 1. Yes\n  2. No',
    });
    await service.submitMessage('s1', STUCK_MESSAGE, 'respond');

    advance(15_000);
    expect(await service.sweepUnsubmittedDeliveries()).toBe(0);
    expect(sendEnter).not.toHaveBeenCalled();
  });

  it('skips when the delivery text is no longer visible in the pane', async () => {
    const { service, sendEnter, advance } = makeService({ pane: '❯ ' });
    await service.submitMessage('s1', STUCK_MESSAGE, 'respond');

    advance(15_000);
    expect(await service.sweepUnsubmittedDeliveries()).toBe(0);
    expect(sendEnter).not.toHaveBeenCalled();
  });

  it("treats Claude Code's pasted-text chip as pane evidence", async () => {
    const { service, sendEnter, advance } = makeService({
      pane: '❯ [Pasted text #1 +12 lines]',
    });
    await service.submitMessage('s1', `${STUCK_MESSAGE}\nsecond line`, 'respond');

    advance(15_000);
    expect(await service.sweepUnsubmittedDeliveries()).toBe(1);
    expect(sendEnter).toHaveBeenCalledWith('s1');
  });

  it('treats a current composer draft followed by status UI as pane evidence', async () => {
    const { service, sendEnter, advance } = makeService({
      pane: [
        `❯ ${STUCK_MESSAGE}`,
        '────────────────────────────────',
        '  tab to queue message                                       100% context left',
      ].join('\n'),
    });
    await service.submitMessage('s1', STUCK_MESSAGE, 'respond');

    advance(15_000);
    expect(await service.sweepUnsubmittedDeliveries()).toBe(1);
    expect(sendEnter).toHaveBeenCalledWith('s1');
  });

  it('matches pane evidence through ANSI control sequences', async () => {
    const { service, sendEnter, advance } = makeService({
      pane: '\x1b[2m❯\x1b[0m \x1b[1mpending dashboard\x1b[0m reply',
    });
    await service.submitMessage('s1', 'pending dashboard', 'respond');

    advance(15_000);
    expect(await service.sweepUnsubmittedDeliveries()).toBe(1);
    expect(sendEnter).toHaveBeenCalled();
  });

  it('sends at most one Enter per session per sweep', async () => {
    const { service, sendEnter, advance } = makeService({
      pane: '❯ first stuck message and second stuck message',
    });
    await service.submitMessage('s1', 'first stuck message', 'respond');
    await service.submitMessage('s1', 'second stuck message', 'respond');

    advance(15_000);
    expect(await service.sweepUnsubmittedDeliveries()).toBe(1);
    expect(sendEnter).toHaveBeenCalledTimes(1);
  });

  it('skips the session when pane capture fails', async () => {
    const { service, sendEnter, advance } = makeService({
      capturePane: vi.fn(async () => {
        throw new Error('session gone');
      }),
    });
    await service.submitMessage('s1', STUCK_MESSAGE, 'respond');

    advance(15_000);
    expect(await service.sweepUnsubmittedDeliveries()).toBe(0);
    expect(sendEnter).not.toHaveBeenCalled();
  });

  it('does not consume the retry budget when the Enter write fails', async () => {
    const sendEnter = vi.fn(async () => {
      throw new Error('write failed');
    });
    let nowMs = Date.parse(T0);
    const service = new UserInputDeliveryService({
      adapter: { sendInput: vi.fn(async () => undefined) },
      retry: {
        sendEnter,
        capturePane: vi.fn(async () => `❯ ${STUCK_MESSAGE}`),
        confirmTimeoutMs: 15_000,
      },
      now: () => new Date(nowMs),
    });
    await service.submitMessage('s1', STUCK_MESSAGE, 'respond');

    nowMs += 15_000;
    expect(await service.sweepUnsubmittedDeliveries()).toBe(0);
    expect(service.getSnapshot('s1')[0]).not.toHaveProperty('enterRetries');
  });

  it('is a no-op when the retry seam is not wired', async () => {
    const service = new UserInputDeliveryService({
      adapter: { sendInput: vi.fn(async () => undefined) },
      now: () => new Date(Date.parse(T0) + 60_000),
    });
    await service.submitMessage('s1', 'continue', 'respond');

    expect(await service.sweepUnsubmittedDeliveries()).toBe(0);
  });

  it('a retried delivery can still be confirmed by a later provider hook', async () => {
    const { service, advance } = makeService();
    await service.submitMessage('s1', STUCK_MESSAGE, 'respond');

    advance(15_000);
    await service.sweepUnsubmittedDeliveries();
    service.observeProviderUserPrompt(
      's1',
      STUCK_MESSAGE,
      'hook-1',
      Date.parse(T0) + 16_000,
    );

    expect(service.getSnapshot('s1')[0]).toMatchObject({
      status: 'submitted_by_agent',
      enterRetries: 1,
    });
  });

  it('does not retry when matching text only appears in scrollback', async () => {
    const { service, sendEnter, advance } = makeService({
      pane: `Earlier submitted prompt: ${STUCK_MESSAGE}\nAssistant answered.\n❯ `,
    });
    await service.submitMessage('s1', STUCK_MESSAGE, 'respond');

    advance(15_000);
    expect(await service.sweepUnsubmittedDeliveries()).toBe(0);
    expect(sendEnter).not.toHaveBeenCalled();
  });

  it('does not retry when a matching prompt line only appears in scrollback', async () => {
    const { service, sendEnter, advance } = makeService({
      pane: `❯ ${STUCK_MESSAGE}\nAssistant answered.\n❯ `,
    });
    await service.submitMessage('s1', STUCK_MESSAGE, 'respond');

    advance(15_000);
    expect(await service.sweepUnsubmittedDeliveries()).toBe(0);
    expect(sendEnter).not.toHaveBeenCalled();
  });

  it('does not treat old pasted-text chips in scrollback as composer evidence', async () => {
    const { service, sendEnter, advance } = makeService({
      pane: 'Earlier prompt had [Pasted text #1 +12 lines]\nAssistant answered.\n❯ ',
    });
    await service.submitMessage('s1', `${STUCK_MESSAGE}\nsecond line`, 'respond');

    advance(15_000);
    expect(await service.sweepUnsubmittedDeliveries()).toBe(0);
    expect(sendEnter).not.toHaveBeenCalled();
  });

  it('does not treat old pasted-text prompt lines in scrollback as composer evidence', async () => {
    const { service, sendEnter, advance } = makeService({
      pane: '❯ [Pasted text #1 +12 lines]\nAssistant answered.\n❯ ',
    });
    await service.submitMessage('s1', `${STUCK_MESSAGE}\nsecond line`, 'respond');

    advance(15_000);
    expect(await service.sweepUnsubmittedDeliveries()).toBe(0);
    expect(sendEnter).not.toHaveBeenCalled();
  });
});

describe('UserInputDeliveryService submit-retry races (#935)', () => {
  const T0 = '2026-06-06T10:00:00.000Z';

  it('does not Enter when the hook confirms during the pane capture', async () => {
    let nowMs = Date.parse(T0);
    const sendEnter = vi.fn(async () => undefined);
    // eslint-disable-next-line prefer-const
    let service!: UserInputDeliveryService;
    const capturePane = vi.fn(async () => {
      // Hook line lands while the sweep awaits the capture.
      service.observeProviderUserPrompt('s1', 'supervisor note', 'hook-1', nowMs);
      return '\u276f supervisor note';
    });
    service = new UserInputDeliveryService({
      adapter: { sendInput: vi.fn(async () => undefined) },
      retry: { sendEnter, capturePane, confirmTimeoutMs: 15_000 },
      now: () => new Date(nowMs),
    });
    await service.submitMessage('s1', 'supervisor note', 'respond');

    nowMs += 15_000;
    expect(await service.sweepUnsubmittedDeliveries()).toBe(0);

    expect(sendEnter).not.toHaveBeenCalled();
    expect(service.getSnapshot('s1')[0]).toMatchObject({ status: 'submitted_by_agent' });
  });

  it('never clobbers a confirmation that raced the Enter write back to queued', async () => {
    let nowMs = Date.parse(T0);
    // eslint-disable-next-line prefer-const
    let service!: UserInputDeliveryService;
    const sendEnter = vi.fn(async () => {
      // The original submit goes through just as the nudge is written; the
      // hook confirms before the sweep records its retry bookkeeping.
      service.observeProviderUserPrompt('s1', 'supervisor note', 'hook-1', nowMs);
    });
    service = new UserInputDeliveryService({
      adapter: { sendInput: vi.fn(async () => undefined) },
      retry: {
        sendEnter,
        capturePane: vi.fn(async () => '\u276f supervisor note'),
        confirmTimeoutMs: 15_000,
      },
      now: () => new Date(nowMs),
    });
    await service.submitMessage('s1', 'supervisor note', 'respond');

    nowMs += 15_000;
    expect(await service.sweepUnsubmittedDeliveries()).toBe(1);

    // The hook line is dedup-consumed (observedHookIds) — reverting to
    // 'queued' here would strand the delivery forever.
    const delivery = service.getSnapshot('s1')[0];
    expect(delivery).toMatchObject({ status: 'submitted_by_agent', submittedHookLineId: 'hook-1' });
    expect(delivery).not.toHaveProperty('enterRetries');
  });
});
