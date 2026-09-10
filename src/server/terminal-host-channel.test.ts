import { describe, expect, it, vi } from 'vitest';
import { TerminalHostChannel } from './terminal-host-channel.js';

describe('NFR-TERM-001: terminal host IPC admission', () => {
  it('keeps one transmission in flight and prioritizes control over queued bulk', () => {
    const packets: unknown[] = [];
    const callbacks: Array<(error?: Error | null) => void> = [];
    const channel = new TerminalHostChannel((packet, _handle, done) => { packets.push(packet); callbacks.push(done); });
    channel.send('first', { bulk: true });
    channel.send('capture', { bulk: true });
    channel.send('revoke');
    expect(packets).toEqual(['first']);
    callbacks.shift()!();
    expect(packets).toEqual(['first', 'revoke']);
    callbacks.shift()!(); callbacks.shift()!();
    expect(packets).toEqual(['first', 'revoke', 'capture']);
    expect(channel.pendingBytes).toBe(0);
  });

  it('reserves control capacity and releases rejected or closed packets exactly once', () => {
    const channel = new TerminalHostChannel(() => {});
    const done = vi.fn();
    expect(channel.send(new Uint8Array(7 * 1024 * 1024), { bulk: true })).toBe(true);
    expect(channel.send(new Uint8Array(7 * 1024 * 1024), { bulk: true, done })).toBe(false);
    expect(done).toHaveBeenCalledOnce();
    expect(channel.send('revoke')).toBe(true);
    channel.close(); channel.close();
    expect(channel.pendingBytes).toBe(0);
    expect(done).toHaveBeenCalledOnce();
  });

  it('rejects a handed-off socket on transfer failure without retrying it', () => {
    const transmit = vi.fn((_packet, _handle, done) => done(new Error('closed')));
    const channel = new TerminalHostChannel(transmit);
    const done = vi.fn();
    channel.send({ kind: 'upgrade' }, { done });
    expect(transmit).toHaveBeenCalledOnce();
    expect(done).toHaveBeenCalledWith(expect.any(Error));
    expect(channel.pendingBytes).toBe(0);
  });

  it('contains a failing completion callback without stranding later packets', () => {
    const callbacks: Array<(error?: Error | null) => void> = [];
    const transmit = vi.fn((_packet, _handle, done) => callbacks.push(done));
    const channel = new TerminalHostChannel(transmit);
    channel.send('first', { done: () => { throw new Error('observer failed'); } });
    const done = vi.fn();
    channel.send('second', { done });
    expect(() => callbacks.shift()!()).not.toThrow();
    expect(transmit).toHaveBeenCalledTimes(2);
    channel.close();
    expect(done).toHaveBeenCalledOnce();
    expect(channel.pendingBytes).toBe(0);
  });
});
