import { EventEmitter, once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
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

  test('bounds real socket memory when acknowledgements arrive before the viewer reads', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1', perMessageDeflate: false });
    await once(server, 'listening');
    let connection: TerminalProtocolConnection | undefined;
    let socket: WebSocket | undefined;
    let attached = false;
    server.on('connection', (ws) => {
      socket = ws;
      connection = new TerminalProtocolConnection({ ws, readOnly: true,
        onAttach: () => { attached = true; connection!.markReady(); }, onControl: () => {} });
      connection.start();
    });
    const address = server.address();
    if (typeof address === 'string') throw new Error('Expected TCP address');
    const viewer = new WebSocket(`ws://127.0.0.1:${address.port}`);
    viewer.on('error', () => {});
    try {
      const [hello] = await once(viewer, 'message');
      const { generation } = JSON.parse(hello.toString());
      viewer.send(JSON.stringify({ type: 'attach', generation, attachId: 'slow-reader', cols: 80, rows: 24 }));
      await expect.poll(() => attached).toBe(true);
      viewer.pause();
      let processed = 0;
      let peakBuffered = 0;
      for (let round = 0; round < 160 && socket!.readyState === WebSocket.OPEN; round++) {
        connection!.output.enqueue(new Uint8Array(128 * 1024));
        for (let i = 0; i < 20; i++) await nextTurn();
        peakBuffered = Math.max(peakBuffered, socket!.bufferedAmount);
        if (socket!.readyState !== WebSocket.OPEN) break;
        processed += 128 * 1024;
        viewer.send(JSON.stringify({ type: 'ack', generation, processed }));
        for (let i = 0; i < 5; i++) await nextTurn();
      }
      // The allowance covers WebSocket headers, not another output payload.
      expect(peakBuffered).toBeLessThanOrEqual(2 * 1024 * 1024 + 4096);
      if (socket!.readyState !== WebSocket.OPEN) expect(connection!.output.reservedBytes).toBe(0);
    } finally {
      connection?.dispose(); viewer.terminate(); socket?.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

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
