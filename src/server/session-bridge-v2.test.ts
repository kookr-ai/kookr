import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import type { TerminalBackend } from '../adapters/terminal-backend.js';
import type { TerminalStreamSnapshot } from '../shared/terminal-stream.js';
import { ABSOLUTE_TUI_COLS } from '../shared/absolute-tui-geometry.js';
import { TERMINAL_V2_PROTOCOL, TERMINAL_CLOSE } from '../shared/terminal-protocol.js';
import { SessionBridge, type SessionBridgeOptions } from './session-bridge.js';
import { diffRenderedAgentStream, SPINNER_ONLY_FRAMES } from './__fixtures__/diff-rendered-agent-stream.js';
import { Terminal } from '@xterm/xterm';

const grokRingBytes = grokLikeRing();

function grokLikeRing(): Uint8Array {
  const parts: string[] = [];
  for (let i = 0; i < 40; i++) parts.push('\x1b[?2026h');
  for (let i = 0; i < 220; i++) {
    const row = (i % 48) + 1;
    const col = 150 + (i % 40);
    parts.push(`\x1b[${row};${col}Hx`);
  }
  for (let i = 0; i < 40; i++) parts.push('\x1b[?2026l');
  return new TextEncoder().encode(parts.join(''));
}

const bridges: SessionBridge[] = [];
async function drain() { for (let i = 0; i < 60; i++) await setImmediate(); }

function sparseGrokRing(): Uint8Array {
  // Wide cursor addressing keeps the absolute-TUI classification, but every
  // cell is a space except one spinner glyph, so reconstruction stays under
  // the printable-cell floor.
  const parts: string[] = ['\x1b[?2026h'];
  for (let i = 0; i < 220; i++) {
    const row = (i % 48) + 1;
    const col = 150 + (i % 40);
    parts.push(`\x1b[${row};${col}H `);
  }
  parts.push('\x1b[5;6H*');
  parts.push('\x1b[?2026l');
  return new TextEncoder().encode(parts.join(''));
}

async function setup(
  bytes = new TextEncoder().encode('seed'),
  readOnly = false,
  absolute = false,
  liveRedrawNudgeMs?: number,
  extraOptions: SessionBridgeOptions = {},
) {
  let snapshot: TerminalStreamSnapshot = {
    bytes, originComplete: true, epoch: 'e', start: 0, end: bytes.byteLength, geometryRevision: 1, cols: 80, rows: 24,
  };
  const backend = Object.assign(new FakeTerminalBackend(), {
    captureStreamSnapshot: vi.fn(async () => snapshot),
  });
  await backend.createSession({ id: 'test', command: 'fake', args: [] });
  let listener: Parameters<TerminalBackend['onData']>[1] | undefined;
  vi.spyOn(backend, 'onData').mockImplementation((_id, callback) => { listener = callback; return () => { listener = undefined; }; });
  const resize = vi.spyOn(backend, 'resize').mockImplementation(async (_id, cols, rows) => {
    // A shrink-before-capture would smash a Grok ring to a narrow tail and
    // flip the heuristic onto viewport-ring. Mirror that so the test fails.
    if (cols < ABSOLUTE_TUI_COLS && snapshot.bytes === grokRingBytes) {
      snapshot = {
        ...snapshot,
        bytes: new TextEncoder().encode('narrow-after-shrink\n'),
        end: 20, cols, rows,
      };
    }
  });
  const write = vi.spyOn(backend, 'write');
  const ws = Object.assign(new EventEmitter(), {
    protocol: TERMINAL_V2_PROTOCOL, readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn(),
  });
  const bridge = new SessionBridge('test', ws as unknown as WebSocket, backend, undefined, undefined, undefined,
    {
      readOnly,
      ...(liveRedrawNudgeMs !== undefined ? { liveRedrawNudgeMs } : {}),
      ...(absolute ? { ringReplay: 'skip-live-redraw' as const } : {}),
      ...extraOptions,
    });
  bridges.push(bridge);
  await bridge.start();
  const hello = ws.send.mock.calls.map(([data]) => typeof data === 'string' ? JSON.parse(data) : null).find((frame) => frame?.type === 'hello');
  const send = (control: Record<string, unknown>) => ws.emit('message', Buffer.from(JSON.stringify({ generation: hello?.generation, ...control })), false);
  return { bridge, ws, backend, resize, write, hello, send,
    attach: (extra: Record<string, unknown> = {}) => send({ type: 'attach', attachId: 'a', cols: 80, rows: 24, ...extra }),
    emit: (text: string | Uint8Array) => {
      const data = typeof text === 'string' ? new TextEncoder().encode(text) : text;
      const start = snapshot.end;
      snapshot = { ...snapshot, bytes: Buffer.concat([snapshot.bytes, data]), end: start + data.byteLength };
      listener?.(data, 'live', { ...snapshot, start });
    },
  };
}

type Harness = Awaited<ReturnType<typeof setup>>;
const controlsOf = (h: Harness) => h.ws.send.mock.calls.map(([data]) => typeof data === 'string' ? JSON.parse(data) : null);
const outputOf = (h: Harness) => h.ws.send.mock.calls.map(([data]) => data).filter((data) => data instanceof Uint8Array);
const outputBytes = (h: Harness) => outputOf(h).reduce((sum, data) => sum + data.length, 0);
/** A snapshot seed is built asynchronously; wait for the boundary instead of counting loop turns. */
async function seeded(h: Harness, count = 1) {
  await vi.waitFor(() => expect(controlsOf(h).filter((frame) => frame?.type === 'seed-end')).toHaveLength(count));
  await drain();
}
/** Paint bytes into a fresh 80x24 terminal, as the browser does after a seed reset. */
async function paint(...chunks: Uint8Array[]) {
  const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 2000, allowProposedApi: true });
  try {
    for (const chunk of chunks) await new Promise<void>((resolve) => terminal.write(chunk, resolve));
    const buffer = terminal.buffer.active;
    return {
      rows: Array.from({ length: terminal.rows }, (_, y) => buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? ''),
      cursor: [buffer.cursorX, buffer.cursorY],
    };
  } finally { terminal.dispose(); }
}

describe('NFR-TERM-001: version-two session bridge', () => {
  afterEach(() => { for (const bridge of bridges.splice(0)) bridge.dispose(); vi.restoreAllMocks(); });

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
    h.attach(); await seeded(h);
    // Viewport-first initial seeds remain bounded by the existing 64-KiB policy,
    // whether the seed is a screen snapshot or the byte-tail fallback.
    const seedBytes = outputBytes(h);
    expect(seedBytes).toBeGreaterThan(0);
    expect(seedBytes).toBeLessThanOrEqual(64 * 1024);
    expect(outputOf(h).every((data) => data.byteLength <= 8192)).toBe(true);
    h.send({ type: 'ack', processed: seedBytes });
    h.emit('live'); await drain();
    expect(outputOf(h).at(-1)?.toString()).toBe('live');
  });

  test.each(['ring', 'viewport', 'restored'] as const)('a truncated %s seed permits explicit best-effort input without a resume cursor', async (kind) => {
    const bytes = new Uint8Array(kind === 'viewport' ? 140 * 1024 : 15).fill(65);
    const h = await setup(bytes);
    if (kind !== 'viewport') h.backend.captureStreamSnapshot.mockResolvedValue({
      bytes, originComplete: false, epoch: 'e', start: kind === 'ring' ? 100 : 0,
      end: kind === 'ring' ? 115 : 15, geometryRevision: 1, cols: 80, rows: 24,
    });
    h.attach(); await seeded(h);
    h.send({ type: 'ack', processed: outputBytes(h) });
    await drain();
    expect(controlsOf(h).find((frame) => frame?.type === 'seed-end')).toMatchObject({
      cursor: null, approximate: true,
    });
    h.send({ type: 'input', text: 'explicit initial view' });
    await drain();
    expect(h.write).toHaveBeenCalledWith('test', new TextEncoder().encode('explicit initial view'));
  });

  test('a secondary attach frame restores a sparse absolute screen and accepts input', async () => {
    const h = await setup(sparseGrokRing());
    h.attach({ cols: ABSOLUTE_TUI_COLS, rows: 24 });
    await drain();
    const controls = h.ws.send.mock.calls.map(([data]) => typeof data === 'string' ? JSON.parse(data) : null);
    expect(controls.find((frame) => frame?.type === 'seed-end')).toMatchObject({
      cursor: null, approximate: true,
    });
    expect(controls.find((frame) => frame?.type === 'seed-end')?.screenUnavailable).toBeUndefined();
    expect(controls.find((frame) => frame?.type === 'attach_timing')).toMatchObject({
      strategy: 'absolute-snapshot', recoveryUsed: true,
    });
    expect(Buffer.concat(h.ws.send.mock.calls.map(([data]) => data).filter(Buffer.isBuffer)).toString()).toContain('fake-current-frame');
    expect(h.write).not.toHaveBeenCalled();
    h.send({ type: 'input', text: 'visible again' });
    await drain();
    expect(h.write).toHaveBeenCalledWith('test', new TextEncoder().encode('visible again'));
  });

  test('bytes that arrived during the secondary attach are not painted again on top of the recovered frame', async () => {
    const h = await setup(sparseGrokRing());
    const original = h.backend.captureCurrentFrame.bind(h.backend);
    h.backend.captureCurrentFrame = async (id, options) => {
      h.emit('SHOULD-NOT-REPLAY');
      return original(id, options);
    };
    h.attach({ cols: ABSOLUTE_TUI_COLS, rows: 24 });
    await drain();
    const painted = Buffer.concat(h.ws.send.mock.calls.map(([data]) => data).filter(Buffer.isBuffer)).toString();
    expect(painted).toContain('fake-current-frame');
    expect(painted).not.toContain('SHOULD-NOT-REPLAY');
    const controls = h.ws.send.mock.calls.map(([data]) => typeof data === 'string' ? JSON.parse(data) : null);
    expect(controls.find((frame) => frame?.type === 'seed-end')).toMatchObject({
      cursor: null, approximate: true,
    });
    expect(controls.find((frame) => frame?.type === 'seed-end')?.screenUnavailable).toBeUndefined();
  });

  test('Ctrl+L redraw restores a sparse absolute screen when the secondary frame is empty', async () => {
    let bytes = sparseGrokRing();
    const h = await setup(bytes, false, false, 0);
    h.backend.setCurrentFrameContent('test', '');
    h.backend.captureStreamSnapshot.mockImplementation(async () => ({
      bytes, originComplete: true, epoch: 'e', start: 0, end: bytes.byteLength,
      geometryRevision: 1, cols: 80, rows: 24,
    }));
    h.write.mockImplementation(async (_id: string, data: Uint8Array) => {
      if (data.length === 1 && data[0] === 0x0c) bytes = grokLikeRing();
    });
    h.attach({ cols: ABSOLUTE_TUI_COLS, rows: 24 });
    await drain();
    const controls = h.ws.send.mock.calls.map(([data]) => typeof data === 'string' ? JSON.parse(data) : null);
    expect(controls.find((frame) => frame?.type === 'seed-end')).toMatchObject({
      cursor: null, approximate: true,
    });
    expect(controls.find((frame) => frame?.type === 'seed-end')?.screenUnavailable).toBeUndefined();
    expect(controls.find((frame) => frame?.type === 'attach_timing')).toMatchObject({
      strategy: 'absolute-redraw', recoveryUsed: true,
    });
    expect(h.write).toHaveBeenCalledWith('test', Uint8Array.of(0x0c));
    expect(Buffer.concat(h.ws.send.mock.calls.map(([data]) => data).filter(Buffer.isBuffer)).toString()).toContain('x');
    h.send({ type: 'input', text: 'visible again' });
    await drain();
    expect(h.write).toHaveBeenCalledWith('test', new TextEncoder().encode('visible again'));
  });

  test('an unavailable reconstructed screen cannot claim a cursor or accept input', async () => {
    const h = await setup(new Uint8Array(0), false, true);
    h.attach({ cols: ABSOLUTE_TUI_COLS, rows: 24 }); await drain();
    const controls = h.ws.send.mock.calls.map(([data]) => typeof data === 'string' ? JSON.parse(data) : null);
    expect(controls.find((frame) => frame?.type === 'seed-end')).toMatchObject({
      cursor: null, screenUnavailable: true, approximate: true,
    });
    h.send({ type: 'input', text: 'not ready' });
    expect(h.write).not.toHaveBeenCalled();
    expect(h.ws.close).toHaveBeenCalledWith(TERMINAL_CLOSE.incompatible, 'terminal input before ready');
  });

  test('keeps a client-pinned absolute-TUI PTY at 200 columns', async () => {
    const h = await setup(grokRingBytes);
    h.attach({ cols: ABSOLUTE_TUI_COLS, rows: 24 });
    await drain();
    expect(h.backend.captureStreamSnapshot).toHaveBeenCalled();
    expect(h.resize).toHaveBeenCalledWith('test', ABSOLUTE_TUI_COLS, 24);
    const controls = h.ws.send.mock.calls.map(([data]) => typeof data === 'string' ? JSON.parse(data) : null);
    expect(controls.find((frame) => frame?.type === 'attach_timing')).toMatchObject({
      strategy: 'absolute-display-only',
      attachSeed: 'absolute',
    });
  });

  test('FitAddon-narrow attaches still shrink even when the spawn-width ring looks absolute', async () => {
    const h = await setup(grokRingBytes);
    h.attach({ cols: 80, rows: 24 });
    await drain();
    expect(h.resize).toHaveBeenCalledWith('test', 80, 24);
    const controls = h.ws.send.mock.calls.map(([data]) => typeof data === 'string' ? JSON.parse(data) : null);
    expect(controls.find((frame) => frame?.type === 'attach_timing')?.strategy).not.toBe('absolute-display-only');
  });

  test('streaming attaches still resize to the requested FitAddon size', async () => {
    const h = await setup();
    h.attach({ cols: 80, rows: 24 });
    await drain();
    expect(h.resize).toHaveBeenCalledWith('test', 80, 24);
  });

  test('does not certify a resume cursor after a post-capture geometry change', async () => {
    const h = await setup();
    h.attach({ cols: 100, rows: 30 });
    await drain();
    const controls = h.ws.send.mock.calls.map(([data]) => typeof data === 'string' ? JSON.parse(data) : null);
    expect(controls.find((frame) => frame?.type === 'seed-end')).toMatchObject({
      cursor: null, approximate: true,
    });
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
  describe('screen-snapshot seed for rings larger than the viewport budget (issue #3564)', () => {
    // An agent that printed a screenful and then only ticked a spinner for more than 64 KiB.
    const stream = diffRenderedAgentStream(SPINNER_ONLY_FRAMES);
    const live = diffRenderedAgentStream(SPINNER_ONLY_FRAMES + 25).bytes.subarray(stream.bytes.byteLength);

    test('seeds the pane with the real screen and stays exact as live frames follow', async () => {
      const h = await setup(stream.bytes);
      h.attach(); await seeded(h);
      const seed = Buffer.concat(outputOf(h));
      expect(await paint(seed)).toEqual(await paint(stream.bytes));
      expect(controlsOf(h).find((frame) => frame?.type === 'attach_timing')).toMatchObject({
        strategy: 'viewport-snapshot', attachSeed: 'viewport', historyAvailable: true,
      });
      // The snapshot replaces a ring that was too large to send: older output is
      // still behind request-history, and the view cannot claim a resume cursor.
      expect(controlsOf(h).find((frame) => frame?.type === 'seed-end')).toMatchObject({
        cursor: null, approximate: true, historyAvailable: true,
      });

      h.send({ type: 'ack', processed: seed.byteLength });
      h.emit(live); await drain();
      const painted = Buffer.concat(outputOf(h));
      expect(painted.byteLength).toBe(seed.byteLength + live.byteLength);
      expect(await paint(painted)).toEqual(await paint(stream.bytes, live));
    });

    test('falls back to the byte tail, and says why, when no snapshot can be built', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const h = await setup(stream.bytes, false, false, undefined, {
        streamingAttachSnapshot: async () => ({ kind: 'unavailable', reason: 'budget-exceeded', elapsedMs: 1 }),
      });
      h.attach(); await seeded(h);
      const seed = Buffer.concat(outputOf(h));
      expect(seed.equals(Buffer.from(stream.bytes.subarray(stream.bytes.byteLength - seed.byteLength)))).toBe(true);
      expect(seed.byteLength).toBeLessThanOrEqual(64 * 1024);
      expect(seed.byteLength).toBeGreaterThan(60 * 1024);
      expect(controlsOf(h).find((frame) => frame?.type === 'attach_timing')).toMatchObject({ strategy: 'viewport-ring' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('screen snapshot unavailable for test (budget-exceeded)'));
      // This is the pane the snapshot exists to prevent: the tail alone does not rebuild the screen.
      expect(await paint(seed)).not.toEqual(await paint(stream.bytes));
    });

    test('a snapshot is treated as a partial seed even when it happens to be as long as the ring', async () => {
      // Length cannot tell a serialized screen from the raw ring. If it were
      // inferred from byte counts, this seed would be certified as the complete
      // origin stream: a resume cursor, no history, attachSeed "full".
      const h = await setup(stream.bytes, false, false, undefined, {
        streamingAttachSnapshot: async (bytes) => ({
          kind: 'snapshot', bytes: new Uint8Array(bytes.byteLength).fill(65),
          emulatedBytes: bytes.byteLength, rawTailBytes: 0, elapsedMs: 1,
        }),
      });
      h.attach(); await seeded(h);
      expect(outputBytes(h)).toBe(stream.bytes.byteLength);
      expect(controlsOf(h).find((frame) => frame?.type === 'seed-end')).toMatchObject({
        cursor: null, approximate: true, historyAvailable: true,
      });
      expect(controlsOf(h).find((frame) => frame?.type === 'attach_timing')).toMatchObject({
        strategy: 'viewport-snapshot', attachSeed: 'viewport', historyAvailable: true,
      });
    });

    test('keeps the seed inside a smaller configured viewport budget', async () => {
      // 140 KiB of dense text: 200 rows of scrollback alone would be about 18 KiB.
      const h = await setup(new Uint8Array(140 * 1024).fill(65), false, false, undefined, { streamingAttachViewportBytes: 8 * 1024 });
      h.attach(); await seeded(h);
      expect(controlsOf(h).find((frame) => frame?.type === 'attach_timing')).toMatchObject({ strategy: 'viewport-snapshot' });
      expect(outputBytes(h)).toBeGreaterThan(24 * 80);
      expect(outputBytes(h)).toBeLessThanOrEqual(8 * 1024);
    });

    test('the full-ring rollback flag bypasses the snapshot', async () => {
      const snapshot = vi.fn();
      const h = await setup(stream.bytes, false, false, undefined, { forceFullRingAttach: true, streamingAttachSnapshot: snapshot });
      h.attach(); await seeded(h);
      expect(snapshot).not.toHaveBeenCalled();
      expect(outputBytes(h)).toBe(stream.bytes.byteLength);
      expect(controlsOf(h).find((frame) => frame?.type === 'attach_timing')).toMatchObject({ strategy: 'full-ring', attachSeed: 'full' });
    });

    test('request-history after a snapshot seed delivers the raw ring', async () => {
      const h = await setup(stream.bytes);
      h.attach(); await seeded(h);
      const seedBytes = outputBytes(h);
      h.send({ type: 'ack', processed: seedBytes });
      h.send({ type: 'request-history' }); await seeded(h, 2);
      expect(controlsOf(h).some((frame) => frame?.type === 'history-unavailable')).toBe(false);
      expect(outputBytes(h) - seedBytes).toBe(stream.bytes.byteLength);
      expect(controlsOf(h).filter((frame) => frame?.type === 'attach_timing').at(-1)).toMatchObject({ strategy: 'full-ring' });
    });

    test('an exact resume still sends only the missing bytes', async () => {
      const snapshot = vi.fn();
      const h = await setup(stream.bytes, false, false, undefined, { streamingAttachSnapshot: snapshot });
      h.attach({ cursor: { epoch: 'e', position: stream.bytes.byteLength - 5, geometryRevision: 1, cols: 80, rows: 24 } });
      await seeded(h);
      expect(snapshot).not.toHaveBeenCalled();
      expect(Buffer.concat(outputOf(h)).equals(Buffer.from(stream.bytes.subarray(stream.bytes.byteLength - 5)))).toBe(true);
    });

    test('a ring that fits the viewport budget is still sent whole and resumable', async () => {
      const snapshot = vi.fn();
      const small = stream.bytes.subarray(0, 4096);
      const h = await setup(small, false, false, undefined, { streamingAttachSnapshot: snapshot });
      h.attach(); await seeded(h);
      expect(snapshot).not.toHaveBeenCalled();
      expect(outputBytes(h)).toBe(small.byteLength);
      expect(controlsOf(h).find((frame) => frame?.type === 'seed-end')).toMatchObject({
        cursor: { epoch: 'e', position: small.byteLength }, approximate: false,
      });
    });
  });
});
