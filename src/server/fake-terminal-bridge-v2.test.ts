import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import type { WebSocket } from 'ws';
import { expect, test, vi } from 'vitest';
import { FakeTerminalBridge } from './fake-terminal-bridge.js';
import { TERMINAL_V2_PROTOCOL } from '../shared/terminal-protocol.js';

test('NFR-TERM-001: demo terminals use the same negotiated seed and typed input protocol', async () => {
  const socket = Object.assign(new EventEmitter(), { protocol: TERMINAL_V2_PROTOCOL, readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() });
  const writer = { writeInput: vi.fn(async () => ({ sessionId: 'test', readinessVersion: 0 })), writeInputSequence: vi.fn() };
  const bridge = new FakeTerminalBridge('test', socket as unknown as WebSocket, { text: 'demo', mode: 'instant' }, writer);
  bridge.start();
  const hello = JSON.parse(socket.send.mock.calls[0][0]);
  expect(hello).toMatchObject({ type: 'hello', version: 2 });
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'attach', generation: hello.generation, attachId: 'a', cols: 80, rows: 24 })), false);
  for (let i = 0; i < 10; i++) await setImmediate();
  expect(socket.send.mock.calls.some(([frame]) => typeof frame === 'string' && JSON.parse(frame).type === 'seed-end')).toBe(true);
  expect(Buffer.concat(socket.send.mock.calls.map(([frame]) => frame).filter(Buffer.isBuffer)).toString()).toContain('demo');
  socket.emit('message', Buffer.from(JSON.stringify({ type: 'input', generation: hello.generation, text: '{"type":"resize"}' })), false);
  expect(writer.writeInput).toHaveBeenCalledWith('test', new TextEncoder().encode('{"type":"resize"}'), expect.anything());
  bridge.dispose();
});
