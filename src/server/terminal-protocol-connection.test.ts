import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { TerminalProtocolConnection } from './terminal-protocol-connection.js';
import { TERMINAL_CLOSE } from '../shared/terminal-protocol.js';

function setup(readOnly = false) {
  const socket = Object.assign(new EventEmitter(), { readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() });
  const onAttach = vi.fn();
  const onControl = vi.fn();
  const connection = new TerminalProtocolConnection({ ws: socket as unknown as WebSocket, readOnly, onAttach, onControl });
  connection.start();
  const hello = JSON.parse(socket.send.mock.calls[0][0]);
  const send = (frame: Record<string, unknown>) => socket.emit('message', Buffer.from(JSON.stringify({ generation: hello.generation, ...frame })), false);
  return { connection, socket, hello, send, onAttach, onControl };
}

describe('NFR-TERM-001: terminal protocol connection', () => {
  afterEach(() => vi.useRealTimers());

  test('sends an explicit hello and rejects input before attach', () => {
    const h = setup();
    expect(h.hello).toMatchObject({ type: 'hello', version: 2, creditBytes: 131072, frameBytes: 8192 });
    h.send({ type: 'input', text: 'wrong time' });
    expect(h.onControl).not.toHaveBeenCalled();
    expect(h.socket.close).toHaveBeenCalledWith(TERMINAL_CLOSE.incompatible, expect.any(String));
  });

  test('read-only viewers return credit but cannot input, resize, or request history', () => {
    const h = setup(true);
    h.send({ type: 'attach', attachId: 'a', cols: 80, rows: 24 });
    h.connection.markReady();
    h.send({ type: 'ack', processed: 0 });
    h.send({ type: 'input', text: 'x' });
    h.send({ type: 'resize', cols: 90, rows: 30 });
    h.send({ type: 'request-history' });
    expect(h.onAttach).toHaveBeenCalledOnce();
    expect(h.onControl).not.toHaveBeenCalled();
    expect(h.socket.close).not.toHaveBeenCalled();
    h.connection.dispose();
  });

  test('literal JSON remains a typed input payload after negotiation', () => {
    const h = setup();
    h.send({ type: 'attach', attachId: 'a', cols: 80, rows: 24 });
    h.connection.markReady();
    h.send({ type: 'input', text: '{"type":"resize"}' });
    expect(h.onControl).toHaveBeenCalledWith(expect.objectContaining({ type: 'input', text: '{"type":"resize"}' }));
    h.connection.dispose();
  });

  test('times out negotiation and rejects future acknowledgements without agent termination', () => {
    vi.useFakeTimers();
    const silent = setup();
    vi.advanceTimersByTime(2000);
    expect(silent.socket.close).toHaveBeenCalledWith(TERMINAL_CLOSE.incompatible, expect.any(String));
    const invalid = setup();
    invalid.send({ type: 'ack', processed: 1 });
    expect(invalid.socket.close).toHaveBeenCalledWith(TERMINAL_CLOSE.incompatible, expect.any(String));
  });
});
