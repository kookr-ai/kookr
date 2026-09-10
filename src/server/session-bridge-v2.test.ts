import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import type { TerminalBackend } from '../adapters/terminal-backend.js';
import type { TerminalStreamSnapshot } from '../shared/terminal-stream.js';
import { TERMINAL_V2_PROTOCOL, TERMINAL_CLOSE } from '../shared/terminal-protocol.js';
import { SessionBridge } from './session-bridge.js';

const bridges: SessionBridge[] = [];
async function drain() { for (let i = 0; i < 60; i++) await setImmediate(); }

async function setup(bytes = new TextEncoder().encode('seed'), readOnly = false, absolute = false) {
  let snapshot: TerminalStreamSnapshot = {
    bytes, epoch: 'e', start: 0, end: bytes.byteLength, geometryRevision: 1, cols: 80, rows: 24,
  };
  const backend = Object.assign(new FakeTerminalBackend(), { captureStreamSnapshot: vi.fn(async () => snapshot) });
  await backend.createSession({ id: 'test', command: 'fake', args: [] });
  let listener: Parameters<TerminalBackend['onData']>[1] | undefined;
  vi.spyOn(backend, 'onData').mockImplementation((_id, callback) => { listener = callback; return () => { listener = undefined; }; });
  const resize = vi.spyOn(backend, 'resize');
  const write = vi.spyOn(backend, 'write');
  const ws = Object.assign(new EventEmitter(), {
    protocol: TERMINAL_V2_PROTOCOL, readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn(),
  });
  const bridge = new SessionBridge('test', ws as unknown as WebSocket, backend, undefined, undefined, undefined,
    { readOnly, ...(absolute ? { ringReplay: 'skip-live-redraw' as const } : {}) });
  bridges.push(bridge);
  await bridge.start();
  const hello = ws.send.mock.calls.map(([data]) => typeof data === 'string' ? JSON.parse(data) : null).find((frame) => frame?.type === 'hello');
  const send = (control: Record<string, unknown>) => ws.emit('message', Buffer.from(JSON.stringify({ generation: hello?.generation, ...control })), false);
  return { bridge, ws, backend, resize, write, hello, send,
    attach: (extra: Record<string, unknown> = {}) => send({ type: 'attach', attachId: 'a', cols: 80, rows: 24, ...extra }),
    emit: (text: string) => {
      const data = new TextEncoder().encode(text);
      const start = snapshot.end;
      snapshot = { ...snapshot, bytes: Buffer.concat([snapshot.bytes, data]), end: start + data.byteLength };
      listener?.(data, 'live', { ...snapshot, start });
    },
  };
}

describe('NFR-TERM-001: version-two session bridge', () => {
  afterEach(() => { for (const bridge of bridges.splice(0)) bridge.dispose(); });

  test('waits for application negotiation, then sends a complete seed boundary even when empty', async () => {
    const h = await setup(new Uint8Array(0));
    expect(h.hello).toMatchObject({ type: 'hello', version: 2 });
    expect(h.backend.captureStreamSnapshot).not.toHaveBeenCalled();
    h.attach(); await drain();
    const controls = h.ws.send.mock.calls.map(([data]) => typeof data === 'string' ? JSON.parse(data) : null);
    expect(controls.filter((frame) => frame?.type === 'seed-begin')).toHaveLength(1);
    expect(controls.find((frame) => frame?.type === 'seed-end')).toMatchObject({ cursor: { epoch: 'e', position: 0 } });
  });

  test('bounds initial replay and keeps seed-end after all credited bytes', async () => {
    const h = await setup(new Uint8Array(140 * 1024).fill(65));
    h.attach(); await drain();
    const output = () => h.ws.send.mock.calls.map(([data]) => data).filter((data) => data instanceof Uint8Array);
    // Viewport-first initial seeds remain bounded by the existing 64-KiB policy.
    expect(output().reduce((sum, data) => sum + data.length, 0)).toBe(64 * 1024);
    expect(output().every((data) => data.byteLength <= 8192)).toBe(true);
    h.send({ type: 'ack', processed: 64 * 1024 });
    h.emit('live'); await drain();
    expect(output().at(-1)?.toString()).toBe('live');
  });

  test('an unavailable reconstructed screen cannot claim a cursor or accept input', async () => {
    const h = await setup(new Uint8Array(0), false, true);
    h.attach(); await drain();
    const controls = h.ws.send.mock.calls.map(([data]) => typeof data === 'string' ? JSON.parse(data) : null);
    expect(controls.find((frame) => frame?.type === 'seed-end')).toMatchObject({
      cursor: null, screenUnavailable: true, approximate: true,
    });
    h.send({ type: 'input', text: 'not ready' });
    expect(h.write).not.toHaveBeenCalled();
    expect(h.ws.close).toHaveBeenCalledWith(TERMINAL_CLOSE.incompatible, 'terminal input before ready');
  });

  test('exact resume sends only missing bytes without resizing or resetting the retained screen', async () => {
    const h = await setup();
    h.attach({ cursor: { epoch: 'e', position: 2, geometryRevision: 1, cols: 80, rows: 24 } });
    await drain();
    expect(h.resize).not.toHaveBeenCalled();
    expect(h.ws.send.mock.calls.some(([data]) => typeof data === 'string' && JSON.parse(data).mode === 'resume')).toBe(true);
    expect(Buffer.concat(h.ws.send.mock.calls.map(([data]) => data).filter(Buffer.isBuffer)).toString()).toBe('ed');
  });

  test('missing continuity is disclosed without Ctrl-L, resize, or transport recycling', async () => {
    const h = await setup();
    h.attach({ cursor: { epoch: 'old', position: 2, geometryRevision: 1, cols: 80, rows: 24 } });
    await drain();
    expect(h.ws.send.mock.calls.some(([data]) => typeof data === 'string' && JSON.parse(data).type === 'continuity-unavailable')).toBe(true);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.resize).not.toHaveBeenCalled();
    h.attach({ acceptGap: true }); await drain();
    expect(h.ws.send.mock.calls.some(([data]) => typeof data === 'string' && JSON.parse(data).type === 'seed-end')).toBe(true);
  });

  test('read-only sessions can acknowledge output but cannot mutate the shared PTY', async () => {
    const h = await setup(undefined, true);
    h.attach(); await drain();
    h.send({ type: 'ack', processed: 4 });
    h.send({ type: 'input', text: 'do not send' });
    h.send({ type: 'resize', cols: 100, rows: 30 });
    expect(h.resize).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.ws.close).not.toHaveBeenCalled();
  });

  test('input preserves literal JSON and transport failures are not reported as agent exit', async () => {
    const h = await setup();
    h.attach(); await drain();
    h.send({ type: 'input', text: '{"type":"resize"}' });
    await drain();
    expect(h.write).toHaveBeenCalledWith('test', new TextEncoder().encode('{"type":"resize"}'));
    h.ws.emit('error', new Error('transport failure'));
    expect(h.ws.close).toHaveBeenCalledWith(TERMINAL_CLOSE.unavailable, expect.any(String));
  });
});
