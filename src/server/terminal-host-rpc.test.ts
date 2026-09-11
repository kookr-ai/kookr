import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalHostRpcClient } from './terminal-host-rpc.js';
import { TerminalHostUnavailableError, type TerminalHostRequest } from './terminal-host-contract.js';

function harness() {
  const sent: TerminalHostRequest[] = [];
  const callbacks: Array<(error?: Error | null) => void> = [];
  const rpc = new TerminalHostRpcClient('g', (packet, callback) => { sent.push(packet); callbacks.push(callback); });
  return { rpc, sent, callbacks };
}
describe('NFR-TERM-001: bounded terminal-host RPC', () => {
  afterEach(() => vi.useRealTimers());
  it('joins typed responses by request and generation, ignoring stale responses', async () => {
    const h = harness(); const result = h.rpc.request('listSessions', []);
    h.rpc.receive({ kind: 'response', generation: 'old', id: 1, result: ['wrong'] });
    expect(h.rpc.pendingCount).toBe(1);
    h.rpc.receive({ kind: 'response', generation: 'g', id: 1, result: ['s'] });
    expect(await result).toEqual(['s']); h.rpc.close();
  });
  it('does not retry an uncertain write when IPC fails', async () => {
    const h = harness(); const result = h.rpc.request('write', ['s', Uint8Array.of(65)]);
    const rejected = expect(result).rejects.toBeInstanceOf(TerminalHostUnavailableError);
    h.callbacks.shift()!(new Error('channel closed'));
    await rejected;
    expect(h.sent).toHaveLength(1); h.rpc.close();
  });
  it('rejects a request whose send fails without disabling the whole client', async () => {
    const h = harness();
    const a = h.rpc.request('write', ['s', Uint8Array.of(65)]);
    const aRejected = expect(a).rejects.toBeInstanceOf(TerminalHostUnavailableError);
    // Channel backpressure fails this one send; it must not brown out the client.
    h.callbacks.shift()!(new Error('Terminal host IPC capacity unavailable'));
    await aRejected;
    // A subsequent request still transmits and completes on the same client.
    const b = h.rpc.request('listSessions', []);
    expect(h.sent.some((packet) => packet.method === 'listSessions')).toBe(true);
    h.callbacks.shift()!();
    h.rpc.receive({ kind: 'response', generation: 'g', id: 2, result: ['s'] });
    expect(await b).toEqual(['s']);
    h.rpc.close();
  });
  it('prioritizes input over unsent captures and expires queued work without sending it', async () => {
    vi.useFakeTimers(); const h = harness();
    const first = h.rpc.request('captureBytes', ['s']);
    const capture = h.rpc.request('captureBytes', ['s'], 100);
    const input = h.rpc.request('write', ['s', Uint8Array.of(65)]);
    const settled = Promise.allSettled([first, capture, input]);
    h.callbacks.shift()!();
    expect(h.sent.map((packet) => packet.method)).toEqual(['captureBytes', 'write']);
    vi.advanceTimersByTime(101);
    h.callbacks.shift()!();
    expect(h.sent).toHaveLength(2);
    h.rpc.close(); await settled;
    expect(h.rpc.pendingBytes).toBe(0);
  });
  it('bounds byte and request admission before accepting more work', async () => {
    const h = harness();
    await expect(h.rpc.request('write', ['s', new Uint8Array(9 * 1024 * 1024)])).rejects.toBeInstanceOf(TerminalHostUnavailableError);
    const requests = Array.from({ length: 128 }, () => h.rpc.request('listSessions', []));
    const settled = Promise.allSettled(requests);
    await expect(h.rpc.request('listSessions', [])).rejects.toBeInstanceOf(TerminalHostUnavailableError);
    h.rpc.close(); await settled;
    expect(h.rpc.pendingCount).toBe(0);
  });
});
