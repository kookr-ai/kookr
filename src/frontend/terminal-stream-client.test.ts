import { afterEach, describe, expect, test, vi } from 'vitest';
import { createTerminalWriter, createTerminalWriteScheduler } from './terminal-writer.js';
import { createTerminalStreamClient, type TerminalContinuity } from './terminal-stream-client.js';
import { TERMINAL_V2_PROTOCOL, TERMINAL_CLOSE } from '../shared/terminal-protocol.js';
import type { SocketLike } from './reconnecting-socket.js';

class Socket implements SocketLike {
  protocol = TERMINAL_V2_PROTOCOL;
  binaryType = 'arraybuffer';
  readyState = 1;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  send = vi.fn();
  close = vi.fn();
}

function harness(continuity: TerminalContinuity = { cursor: null, hadView: false }) {
  const tasks: Array<() => void> = [];
  const parses: Array<() => void> = [];
  const terminal = { reset: vi.fn(), write: vi.fn((_data: Uint8Array, callback: () => void) => parses.push(callback)) };
  const writer = createTerminalWriter({ terminal, scheduler: createTerminalWriteScheduler((task) => tasks.push(task)), onStall: vi.fn() });
  const sockets: Socket[] = [];
  const onState = vi.fn();
  const client = createTerminalStreamClient({
    writer, continuity, getSize: () => ({ cols: 80, rows: 24 }),
    createSocket: () => { const socket = new Socket(); sockets.push(socket); return socket; },
    onState, getMetadata: () => ({}), onTelemetry: vi.fn(), requestFrame: (cb) => { cb(); return 1; },
    cancelFrame: vi.fn(),
  });
  client.start();
  const socket = sockets[0];
  const control = (frame: Record<string, unknown>, target = socket) => target.onmessage?.({ data: JSON.stringify({ generation: 'g', ...frame }) });
  const hello = (target = socket) => { target.onopen?.(); control({ type: 'hello', version: 2, creditBytes: 131072, frameBytes: 8192 }, target); };
  const begin = () => control({ type: 'seed-begin', transaction: 't', mode: 'replace' });
  const data = (text: string) => socket.onmessage?.({ data: new TextEncoder().encode(text).buffer });
  const end = (position: number) => control({ type: 'seed-end', transaction: 't',
    cursor: { epoch: 'e', position, geometryRevision: 1, cols: 80, rows: 24 }, approximate: false, historyAvailable: false });
  const turn = () => tasks.shift()?.();
  const parse = () => parses.shift()?.();
  const settle = () => { while (tasks.length || parses.length) { turn(); parse(); } };
  return { client, sockets, socket, control, hello, begin, data, end, turn, parse, settle, terminal, continuity, onState, writer };
}

describe('NFR-TERM-001: terminal streaming client', () => {
  afterEach(() => vi.useRealTimers());

  test('keeps input disabled when reconstruction could not produce a usable screen', () => {
    const h = harness(); h.hello(); h.begin();
    h.control({ type: 'seed-end', transaction: 't', cursor: null, historyAvailable: false,
      approximate: true, screenUnavailable: true });
    h.settle();
    expect(h.onState).toHaveBeenLastCalledWith({ kind: 'unavailable', reason: 'current terminal screen unavailable' });
    expect(h.client.sendInput('unsafe')).toBe(false);
    h.client.stop(); h.writer.dispose();
  });

  test('waits for a valid hello before sending controls and never falls back to raw input', () => {
    const h = harness();
    h.socket.onopen?.();
    expect(h.socket.send).not.toHaveBeenCalled();
    expect(h.client.sendInput('x')).toBe(false);
    h.control({ type: 'attach_timing' });
    expect(h.onState).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'incompatible' }));
    h.client.stop(); h.writer.dispose();
  });

  test('ACKs parsed bytes, but keeps input gated until every seed chunk is parsed', () => {
    const h = harness();
    h.hello(); h.begin(); h.data('first'); h.data('last'); h.end(9);
    h.turn(); // ordered reset
    h.turn(); // first write
    expect(h.client.isEstablished()).toBe(false);
    expect(h.socket.send.mock.calls.some(([frame]) => JSON.parse(frame).type === 'ack')).toBe(false);
    h.parse(); h.turn();
    expect(h.client.isEstablished()).toBe(false);
    h.parse(); h.turn();
    expect(h.client.isEstablished()).toBe(true);
    expect(h.continuity.cursor?.position).toBe(9);
    expect(h.socket.send.mock.calls.map(([frame]) => JSON.parse(frame))).toContainEqual({ type: 'ack', generation: 'g', processed: 9 });
    expect(h.client.sendInput('{"type":"resize"}')).toBe(true);
    expect(JSON.parse(h.socket.send.mock.lastCall![0])).toEqual({ type: 'input', generation: 'g', text: '{"type":"resize"}' });
    h.client.stop(); h.writer.dispose();
  });

  test('explicit empty seed is ready without waiting for a visual write', () => {
    const h = harness();
    h.hello(); h.begin(); h.end(0); h.settle();
    expect(h.client.isEstablished()).toBe(true);
    expect(h.terminal.write).not.toHaveBeenCalled();
    h.client.stop(); h.writer.dispose();
  });

  test('retirement with an in-flight parse invalidates exact resume and ignores its callback', () => {
    const h = harness();
    h.hello(); h.begin(); h.data('seed'); h.end(4); h.settle();
    h.control({ type: 'source', epoch: 'e', start: 4, end: 8, geometryRevision: 1, cols: 80, rows: 24 });
    h.data('late'); h.turn();
    h.client.stop();
    h.parse();
    expect(h.continuity.cursor).toBeNull();
    expect(h.socket.send.mock.calls.map(([frame]) => JSON.parse(frame)).filter((frame) => frame.type === 'ack').at(-1)?.processed).toBe(4);
    h.writer.dispose();
  });

  test('resume keeps the retained parser and commits the cursor only at seed-end', () => {
    const h = harness({ cursor: { epoch: 'e', position: 4, geometryRevision: 1, cols: 80, rows: 24 }, hadView: true });
    h.hello();
    expect(JSON.parse(h.socket.send.mock.calls[0][0])).toMatchObject({ type: 'attach', cursor: { position: 4 } });
    h.control({ type: 'seed-begin', transaction: 't', mode: 'resume' });
    h.data('next'); h.end(8); h.settle();
    expect(h.terminal.reset).not.toHaveBeenCalled();
    expect(h.continuity.cursor?.position).toBe(8);
    h.client.stop(); h.writer.dispose();
  });

  test('known lag stays recoverable and never automatically retries or claims the agent ended', () => {
    vi.useFakeTimers();
    const h = harness();
    h.hello(); h.begin(); h.end(0); h.settle();
    h.socket.onclose?.({ code: TERMINAL_CLOSE.lagged });
    vi.advanceTimersByTime(30_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.onState).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'lagged' }));
    h.client.stop(); h.writer.dispose();
  });

  test('caps automatic reconnects across hello-only generations', () => {
    vi.useFakeTimers();
    const h = harness();
    for (let i = 0; i < 3; i++) {
      const socket = h.sockets.at(-1)!;
      h.hello(socket);
      socket.onclose?.({ code: 1006 });
      vi.advanceTimersByTime(1000 * (i + 1));
    }
    expect(h.sockets).toHaveLength(3);
    expect(h.onState).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'unavailable' }));
    h.client.stop(); h.writer.dispose();
  });

  test('a failed ACK send cannot recurse during retirement', () => {
    const h = harness();
    h.hello(); h.begin(); h.data('seed'); h.end(4);
    h.socket.send.mockImplementation(() => { throw new Error('closed'); });
    expect(() => h.settle()).not.toThrow();
    expect(h.onState).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'unavailable' }));
    h.client.stop(); h.writer.dispose();
  });
});
