import { describe, expect, it, vi } from 'vitest';
import { InputSubmitAbortedError } from '../core/ports/agent-interaction-port.js';
import { GuardedInputSender, type GuardedDeliveryRecord } from './guarded-input-sender.js';

const NOW = new Date('2026-11-21T12:00:00.000Z');

function sender(opts: { awaiting?: boolean; sendInput?: ReturnType<typeof vi.fn>; record?: boolean } = {}) {
  const sendInput = opts.sendInput ?? vi.fn(async () => undefined);
  const records: GuardedDeliveryRecord[] = [];
  const awaiting = { value: opts.awaiting ?? false };
  const s = new GuardedInputSender({
    adapter: { sendInput },
    isAwaitingChoice: () => awaiting.value,
    ...(opts.record === false ? {} : { recordDelivery: (r: GuardedDeliveryRecord) => { records.push(r); } }),
    now: () => NOW,
  });
  return { s, sendInput, records, awaiting };
}

describe('GuardedInputSender', () => {
  it('types the line with a beforeSubmit re-check and records it under the given source', async () => {
    const { s, sendInput, records, awaiting } = sender();
    const result = await s.send('sess', 'hello', 'sentinel');
    expect(result).toEqual({ outcome: 'sent', at: NOW.toISOString() });
    expect(sendInput).toHaveBeenCalledTimes(1);
    const [id, text, opts] = sendInput.mock.calls[0] as [string, string, { beforeSubmit: () => boolean }];
    expect([id, text]).toEqual(['sess', 'hello']);
    expect(opts.beforeSubmit()).toBe(true);
    awaiting.value = true;
    expect(opts.beforeSubmit()).toBe(false);
    expect(records).toEqual([{ sessionId: 'sess', text: 'hello', source: 'sentinel', at: NOW.toISOString() }]);
  });

  it('records nothing when the caller names no source', async () => {
    const { s, records } = sender();
    expect((await s.send('sess', 'wake')).outcome).toBe('sent');
    expect(records).toEqual([]);
  });

  it('refuses up front on a choice dialog: nothing typed, nothing recorded', async () => {
    const { s, sendInput, records } = sender({ awaiting: true });
    const result = await s.send('sess', 'hello', 'sentinel');
    expect(result.outcome).toBe('refused');
    expect(sendInput).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it('maps a vetoed Enter to refused', async () => {
    const sendInput = vi.fn(async () => { throw new InputSubmitAbortedError(); });
    const { s, records } = sender({ sendInput });
    const result = await s.send('sess', 'hello', 'sentinel');
    expect(result.outcome).toBe('refused');
    expect(records).toEqual([]);
  });

  it('reports any other adapter error as failed (ambiguous), with its message', async () => {
    const sendInput = vi.fn(async () => { throw new Error('pty closed'); });
    const { s, records } = sender({ sendInput });
    expect(await s.send('sess', 'hello', 'sentinel')).toEqual({ outcome: 'failed', error: 'pty closed' });
    expect(records).toEqual([]);
  });

  it('a failing delivery log does not turn a typed line into a failure', async () => {
    const sendInput = vi.fn(async () => undefined);
    const s = new GuardedInputSender({
      adapter: { sendInput },
      isAwaitingChoice: () => false,
      recordDelivery: () => { throw new Error('disk full'); },
      now: () => NOW,
    });
    expect((await s.send('sess', 'hello', 'sentinel')).outcome).toBe('sent');
  });

  it('without a dialog probe it calls sendInput with two arguments', async () => {
    const sendInput = vi.fn(async () => undefined);
    const s = new GuardedInputSender({ adapter: { sendInput }, isAwaitingChoice: undefined });
    await s.send('sess', 'hello');
    expect(sendInput.mock.calls[0]).toEqual(['sess', 'hello']);
  });
});
