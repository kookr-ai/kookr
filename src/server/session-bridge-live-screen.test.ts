import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import type { WebSocket } from 'ws';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { FakeTerminalBackend } from '../adapters/fake-terminal-backend.js';
import type { TerminalBackend } from '../adapters/terminal-backend.js';
import type { TerminalRingReader } from '../adapters/terminal-ring-observer.js';
import type { TerminalStreamSnapshot } from '../shared/terminal-stream.js';
import { TERMINAL_V2_PROTOCOL } from '../shared/terminal-protocol.js';
import { SessionBridge, type SessionBridgeOptions } from './session-bridge.js';
import { snapshotStreamingAttachSeed } from './streaming-attach-snapshot.js';
import { LiveScreenModels, type LiveScreenSeedResult, type LiveScreenSeedSource } from './terminal-live-screen-models.js';
import { diffRenderedAgentStream, SPINNER_ONLY_FRAMES } from './__fixtures__/diff-rendered-agent-stream.js';

const VIEWPORT = 64 * 1024;
const bridges: SessionBridge[] = [];
const registries: LiveScreenModels[] = [];
async function drain() { for (let i = 0; i < 60; i++) await setImmediate(); }

/**
 * A v2 bridge over a fake backend whose ring is `full.subarray(ringStart)`:
 * `ringStart > 0` is a ring that lost its start (shrunk by the fleet budget,
 * or wrapped), so it is not the complete stream.
 */
async function setup(full: Uint8Array, ringStart: number, options: SessionBridgeOptions = {}, observer?: LiveScreenModels) {
  let all = full;
  let start = ringStart;
  const current = (): TerminalStreamSnapshot => ({
    bytes: all.slice(start), originComplete: start === 0, epoch: 'e', start, end: all.byteLength,
    geometryRevision: 1, cols: 80, rows: 24,
  });
  const backend = Object.assign(new FakeTerminalBackend(), { captureStreamSnapshot: vi.fn(async () => current()) });
  await backend.createSession({ id: 'test', command: 'fake', args: [] });
  let listener: Parameters<TerminalBackend['onData']>[1] | undefined;
  vi.spyOn(backend, 'onData').mockImplementation((_id, callback) => { listener = callback; return () => { listener = undefined; }; });
  vi.spyOn(backend, 'resize').mockImplementation(async () => {});
  const ring: TerminalRingReader = { captureStreamSnapshot: () => current() };
  const ws = Object.assign(new EventEmitter(), { protocol: TERMINAL_V2_PROTOCOL, readyState: 1, OPEN: 1, send: vi.fn(), close: vi.fn() });
  const bridge = new SessionBridge('test', ws as unknown as WebSocket, backend, undefined, undefined, undefined, {
    streamingAttachSnapshot: snapshotStreamingAttachSeed,
    ...options,
  });
  bridges.push(bridge);
  await bridge.start();
  const hello = ws.send.mock.calls.map(([data]) => typeof data === 'string' ? JSON.parse(data) : null).find((frame) => frame?.type === 'hello');
  const send = (control: Record<string, unknown>) => ws.emit('message', Buffer.from(JSON.stringify({ generation: hello?.generation, ...control })), false);
  /** Retain bytes in the ring, tell the model, then fan out to the bridge: `LocalDtachStream`'s order. */
  const emit = (data: Uint8Array) => {
    const from = all.byteLength;
    const next = new Uint8Array(from + data.byteLength);
    next.set(all, 0); next.set(data, from);
    all = next;
    const range = { epoch: 'e', start: from, end: all.byteLength, geometryRevision: 1, cols: 80, rows: 24 };
    observer?.onRingAppend('test', data, range, ring);
    listener?.(data, 'live', range);
  };
  return {
    ws, send, emit, backend, ring,
    shrink: (keep: number) => { start = Math.max(0, all.byteLength - keep); },
    attach: () => send({ type: 'attach', attachId: 'a', cols: 80, rows: 24 }),
  };
}

type Harness = Awaited<ReturnType<typeof setup>>;
const controlsOf = (h: Harness) => h.ws.send.mock.calls.map(([data]) => typeof data === 'string' ? JSON.parse(data) : null);
const outputOf = (h: Harness) => Buffer.concat(h.ws.send.mock.calls.map(([data]) => data).filter((data) => data instanceof Uint8Array));
const timing = (h: Harness) => controlsOf(h).find((frame) => frame?.type === 'attach_timing');
const seedEnd = (h: Harness) => controlsOf(h).find((frame) => frame?.type === 'seed-end');
async function seeded(h: Harness, timeout = 5_000) {
  await vi.waitFor(() => expect(controlsOf(h).filter((frame) => frame?.type === 'seed-end')).toHaveLength(1), { timeout });
  await drain();
}
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

/** A model stub that answers with the true screen: a step-1 snapshot of the whole stream. */
function truthfulModel(full: () => Uint8Array): LiveScreenSeedSource & { seed: ReturnType<typeof vi.fn> } {
  return {
    seed: vi.fn(async (): Promise<LiveScreenSeedResult> => {
      const bytes = full();
      const result = await snapshotStreamingAttachSeed(bytes, { cols: 80, rows: 24 });
      if (result.kind !== 'snapshot') throw new Error('fixture');
      return { kind: 'seed', bytes: result.bytes, epoch: 'e', end: bytes.byteLength, elapsedMs: 2 };
    }),
  };
}

const unavailableModel = () => ({ seed: vi.fn(async (): Promise<LiveScreenSeedResult> => ({ kind: 'unavailable', reason: 'no-model', elapsedMs: 0 })) });

describe('live screen seeds in the v2 bridge (issue #3564, step 2)', () => {
  const stream = diffRenderedAgentStream(SPINNER_ONLY_FRAMES);
  /** The stream's last 64 KiB: spinner diffs only, the base screen is gone. */
  const shrunkStart = stream.bytes.byteLength - VIEWPORT;

  afterEach(async () => {
    for (const bridge of bridges.splice(0)) bridge.dispose();
    for (const registry of registries.splice(0)) await registry.close();
    vi.restoreAllMocks();
  });

  test('a shrunk ring is seeded from the model, and offers no history that would blank it', async () => {
    const model = truthfulModel(() => stream.bytes);
    const h = await setup(stream.bytes, shrunkStart, { liveScreen: model });
    h.attach(); await seeded(h);
    expect(model.seed).toHaveBeenCalledWith('test', { cols: 80, rows: 24, maxBytes: VIEWPORT });
    expect(await paint(outputOf(h))).toEqual(await paint(stream.bytes));
    expect(timing(h)).toMatchObject({ strategy: 'live-screen', attachSeed: 'viewport', historyAvailable: false });
    // "Load earlier output" would replace the right screen with the blank ring replay.
    expect(seedEnd(h)).toMatchObject({ cursor: null, approximate: true, historyAvailable: false });
  });

  test('a large ring is seeded from the model without replaying it, and keeps its history', async () => {
    const model = truthfulModel(() => stream.bytes);
    const replay = vi.fn();
    const h = await setup(stream.bytes, 0, { liveScreen: model, streamingAttachSnapshot: replay });
    h.attach(); await seeded(h);
    expect(replay).not.toHaveBeenCalled();
    expect(await paint(outputOf(h))).toEqual(await paint(stream.bytes));
    expect(timing(h)).toMatchObject({ strategy: 'live-screen', historyAvailable: true });
    expect(seedEnd(h)).toMatchObject({ cursor: null, historyAvailable: true });
  });

  test('output the model saw after the capture is not painted twice', async () => {
    const more = diffRenderedAgentStream(SPINNER_ONLY_FRAMES + 30).bytes.subarray(stream.bytes.byteLength);
    let h!: Harness;
    let full = stream.bytes;
    const model: LiveScreenSeedSource = {
      seed: async () => {
        // Output arrives while the seed is being built, and the model includes it.
        h.emit(more.subarray(0, 100));
        full = Buffer.concat([stream.bytes, more.subarray(0, 100)]);
        const result = await snapshotStreamingAttachSeed(full, { cols: 80, rows: 24 });
        if (result.kind !== 'snapshot') throw new Error('fixture');
        return { kind: 'seed', bytes: result.bytes, epoch: 'e', end: full.byteLength, elapsedMs: 1 };
      },
    };
    h = await setup(stream.bytes, shrunkStart, { liveScreen: model });
    h.attach(); await seeded(h);
    h.send({ type: 'ack', processed: outputOf(h).byteLength });
    h.emit(more.subarray(100)); await drain();
    expect(await paint(outputOf(h))).toEqual(await paint(stream.bytes, more));
  });

  test('a model that stopped short of the capture is completed from the ring', async () => {
    const before = stream.bytes.subarray(0, stream.bytes.byteLength - 500);
    const model: LiveScreenSeedSource = {
      seed: async () => {
        const result = await snapshotStreamingAttachSeed(before, { cols: 80, rows: 24 });
        if (result.kind !== 'snapshot') throw new Error('fixture');
        return { kind: 'seed', bytes: result.bytes, epoch: 'e', end: before.byteLength, elapsedMs: 1 };
      },
    };
    const h = await setup(stream.bytes, shrunkStart, { liveScreen: model });
    h.attach(); await seeded(h);
    expect(await paint(outputOf(h))).toEqual(await paint(stream.bytes));
  });

  test('without a model, a large ring falls back to the ring replay and a small one is sent whole', async () => {
    const replay = vi.fn(snapshotStreamingAttachSeed);
    const large = await setup(stream.bytes, 0, { liveScreen: unavailableModel(), streamingAttachSnapshot: replay });
    large.attach(); await seeded(large);
    expect(replay).toHaveBeenCalledTimes(1);
    expect(timing(large)).toMatchObject({ strategy: 'viewport-snapshot' });

    const small = await setup(stream.bytes, shrunkStart, { liveScreen: unavailableModel() });
    small.attach(); await seeded(small);
    expect(outputOf(small).equals(Buffer.from(stream.bytes.subarray(shrunkStart)))).toBe(true);
    expect(timing(small)).toMatchObject({ strategy: 'full-ring', historyAvailable: false });
  });

  test('a model that throws costs the attach its model seed, not the connection', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = await setup(stream.bytes, 0, { liveScreen: { seed: async () => { throw new Error('model blew up'); } } });
    h.attach(); await seeded(h);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('live screen model threw'), expect.any(Error));
    expect(timing(h)).toMatchObject({ strategy: 'viewport-snapshot' });
    expect(h.ws.close).not.toHaveBeenCalled();
  });

  test('a small complete ring is still sent whole and resumable, without asking the model', async () => {
    const model = truthfulModel(() => stream.bytes);
    const small = stream.bytes.subarray(0, 4096);
    const h = await setup(small, 0, { liveScreen: model });
    h.attach(); await seeded(h);
    expect(model.seed).not.toHaveBeenCalled();
    expect(outputOf(h).equals(Buffer.from(small))).toBe(true);
    expect(seedEnd(h)).toMatchObject({ cursor: { epoch: 'e', position: small.byteLength }, approximate: false });
  });

  test('the full-ring rollback, an empty ring and an exact resume never ask the model', async () => {
    const model = truthfulModel(() => stream.bytes);
    const full = await setup(stream.bytes, 0, { liveScreen: model, forceFullRingAttach: true });
    full.attach(); await seeded(full);
    const empty = await setup(new Uint8Array(0), 0, { liveScreen: model });
    empty.attach(); await seeded(empty);
    const resume = await setup(stream.bytes, shrunkStart, { liveScreen: model });
    resume.send({ type: 'attach', attachId: 'a', cols: 80, rows: 24,
      cursor: { epoch: 'e', position: stream.bytes.byteLength - 5, geometryRevision: 1, cols: 80, rows: 24 } });
    await seeded(resume);
    expect(model.seed).not.toHaveBeenCalled();
  });

  describe('through the real worker thread', { timeout: 60_000 }, () => {
    test('a ring shrunk past its base screen still attaches to the true screen; with the switch off it does not', async () => {
      const registry = new LiveScreenModels({ flushMs: 50 });
      registries.push(registry);
      // The session starts empty and every byte reaches the model as it is retained.
      const h = await setup(new Uint8Array(0), 0, {}, registry);
      for (let offset = 0; offset < stream.bytes.byteLength; offset += 1500) {
        h.emit(stream.bytes.subarray(offset, offset + 1500));
      }
      // The fleet budget shrinks the ring to its last 64 KiB: spinner diffs only.
      h.shrink(VIEWPORT);
      const ringNow = (await h.backend.captureStreamSnapshot()).bytes;
      expect(await paint(ringNow)).not.toEqual(await paint(stream.bytes));

      // A thread that loads tsx can take seconds to start on a busy host: wait for the model.
      await vi.waitFor(async () => {
        expect((await registry.seed('test', { cols: 80, rows: 24, maxBytes: VIEWPORT })).kind).toBe('seed');
      }, { timeout: 30_000, interval: 200 });

      const on = await setup(stream.bytes, shrunkStart, { liveScreen: registry });
      on.attach(); await seeded(on, 20_000);
      expect(timing(on)).toMatchObject({ strategy: 'live-screen', historyAvailable: false });
      expect(await paint(outputOf(on))).toEqual(await paint(stream.bytes));

      // Switch off: the bridge has no model, and the shrunk ring is sent whole, as before.
      const off = await setup(stream.bytes, shrunkStart, { liveScreen: null });
      off.attach(); await seeded(off);
      expect(timing(off)).toMatchObject({ strategy: 'full-ring' });
      expect(outputOf(off).equals(Buffer.from(ringNow))).toBe(true);
      expect(await paint(outputOf(off))).not.toEqual(await paint(stream.bytes));
    });
  });
});
