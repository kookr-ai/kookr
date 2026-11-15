import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node-pty';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { DtachRingStore, shrinkRing } from './dtach-ring-store.js';
import { DtachManifestStore } from './dtach-manifest-store.js';
import { LocalDtachStream, type LocalDtachStreamHost } from './local-dtach-stream.js';

const ptyMock = vi.hoisted(() => ({ data: undefined as ((data: string) => void) | undefined }));
vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: (callback: (data: string) => void) => { ptyMock.data = callback; return { dispose() {} }; },
    onExit: () => ({ dispose() {} }),
    kill: vi.fn(),
  })),
}));

const directories: string[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'terminal-source-'));
  directories.push(dir);
  const host: LocalDtachStreamHost = {
    attached: new Map(), ringStore: new DtachRingStore(join(dir, 'rings')),
    manifestStore: new DtachManifestStore(join(dir, 'manifest.json'), 'test'),
    dtachBinary: 'mock-dtach', writeTimeoutMs: 100, reattachCounts: {},
    isClosed: () => false, emitError: vi.fn(), observeWriteQueueDepth: vi.fn(),
    onRingStateChanged: vi.fn(), tryExpandRing: () => false,
  };
  const stream = new LocalDtachStream(host);
  const session = stream.createAttachedState('test', join(dir, 'test.sock'), true);
  stream.attachPtyInto(session, session.sock, { cols: 80, rows: 24 }, false, false);
  return { stream, session, host, emit: (data: string) => ptyMock.data?.(data) };
}

describe('FR-TERM-004: terminal source positions', () => {
  afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('publishes an appended live range and atomically captures its end', () => {
    const h = setup();
    const observed: unknown[] = [];
    h.session.dataSubscribers.add((_data, _source, range) => {
      const snapshot = h.stream.captureStreamSnapshot('test');
      observed.push({ range, snapshot });
    });
    h.emit('é');
    expect(observed).toEqual([{
      range: expect.objectContaining({ start: 0, end: 2, epoch: expect.any(String) }),
      snapshot: expect.objectContaining({ start: 0, end: 2, originComplete: true, bytes: new TextEncoder().encode('é'), cols: 80, rows: 24 }),
    }]);
  });

  test('source positions survive ring capacity changes and bounded captures', () => {
    const h = setup();
    h.emit('a'.repeat(100));
    const before = h.stream.captureStreamSnapshot('test');
    h.session.ringBuffer = Buffer.from('a'.repeat(8));
    h.session.ringHead = 8;
    h.emit('xyz');
    const after = h.stream.captureStreamSnapshot('test', 4);
    expect(after).toMatchObject({ epoch: before.epoch, start: 99, end: 103, originComplete: false });
    expect(new TextDecoder().decode(after.bytes)).toBe('axyz');
  });

  test('unknown attach replay invalidates resume without adding replay to live history', () => {
    const h = setup();
    h.emit('live');
    const before = h.stream.captureStreamSnapshot('test');
    h.session.attachReplayPending = true;
    h.emit('redraw');
    const after = h.stream.captureStreamSnapshot('test');
    expect(after.epoch).not.toBe(before.epoch);
    expect(new TextDecoder().decode(after.bytes)).toBe('live');
    expect(after.end).toBe(4);
    expect(after.originComplete).toBe(false);
  });

  test('reloaded ring suffixes cannot become a complete origin when their offsets restart at zero', () => {
    const h = setup();
    shrinkRing(h.session, 64 * 1024);
    // Dropping this OSC prefix changes how a fresh parser interprets the suffix.
    h.emit('\x1b]0;' + 'a'.repeat(70_000));
    h.host.ringStore.persist(h.session);
    h.host.attached.delete('test');
    h.stream.createAttachedState('test', h.session.sock);
    expect(h.stream.captureStreamSnapshot('test')).toMatchObject({
      start: 0, end: 64 * 1024, originComplete: false,
    });
  });

  test('a recovered session without a ring cannot certify a fresh stream origin', () => {
    const h = setup();
    h.host.attached.delete('test');
    h.stream.createAttachedState('test', h.session.sock);
    expect(h.stream.captureStreamSnapshot('test')).toMatchObject({ start: 0, end: 0, originComplete: false });
  });

  test('geometry changes invalidate continuity but repeated dimensions do not', () => {
    const h = setup();
    const before = h.stream.captureStreamSnapshot('test');
    h.stream.setGeometry(h.session, { cols: 80, rows: 24 });
    expect(h.stream.captureStreamSnapshot('test').geometryRevision).toBe(before.geometryRevision);
    h.stream.setGeometry(h.session, { cols: 90, rows: 24 });
    expect(h.stream.captureStreamSnapshot('test')).toMatchObject({
      geometryRevision: before.geometryRevision + 1, cols: 90, rows: 24,
    });
  });
});

describe('issue #3565: a session that survives a restart', () => {
  const CLEAR = '\x1b[H\x1b[J';

  afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.mocked(spawn).mockClear();
  });

  /** One server generation over a shared instance dir (manifest + rings). */
  function generation(dir: string) {
    const host: LocalDtachStreamHost = {
      attached: new Map(), ringStore: new DtachRingStore(join(dir, 'rings')),
      manifestStore: new DtachManifestStore(join(dir, 'manifest.json'), 'test'),
      dtachBinary: 'mock-dtach', writeTimeoutMs: 100, reattachCounts: {},
      isClosed: () => false, emitError: vi.fn(), observeWriteQueueDepth: vi.fn(),
      onRingStateChanged: vi.fn(), tryExpandRing: () => false,
    };
    return { host, stream: new LocalDtachStream(host) };
  }

  /** Write a manifest entry for session `s` whose socket path exists. */
  function instanceDir(size?: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'terminal-restart-'));
    directories.push(dir);
    const sock = join(dir, 's.sock');
    writeFileSync(sock, '');
    const entry = { sessionId: 's', pid: -1, startedAt: new Date().toISOString(), status: 'active', sock, size };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version: 1, instanceId: 'test', entries: [entry] }));
    return { dir, sock };
  }

  const lastSpawnSize = () => {
    const options = vi.mocked(spawn).mock.calls.at(-1)?.[2];
    return { cols: options?.cols, rows: options?.rows };
  };
  const ringText = (stream: LocalDtachStream) => new TextDecoder().decode(stream.captureBytes('s'));

  /** Launch at 120x40, resize to 83x30, record output, then restart. */
  async function launchResizeAndRestart() {
    const { dir, sock } = instanceDir();
    const before = generation(dir);
    before.stream.openAttach('s', sock, { cols: 120, rows: 40 }, true);
    const sess = before.host.attached.get('s')!;
    before.stream.setGeometry(sess, { cols: 83, rows: 30 });
    ptyMock.data?.('screen');
    before.host.ringStore.persist(sess);
    // The size write is fire-and-forget; queue behind it so it has landed.
    await before.host.manifestStore.withLock(() => undefined);
    return generation(dir);
  }

  test('re-attaches at its last size instead of 80x24', async () => {
    const after = await launchResizeAndRestart();
    expect(after.host.manifestStore.read().entries[0].size).toEqual({ cols: 83, rows: 30 });
    after.stream.ensureReadable('s');
    expect(lastSpawnSize()).toEqual({ cols: 83, rows: 30 });
    expect(after.stream.captureStreamSnapshot('s')).toMatchObject({ cols: 83, rows: 30 });
  });

  test('the dtach attach clear is neither recorded in the ring nor fanned out', async () => {
    const after = await launchResizeAndRestart();
    const sess = after.stream.ensureReadable('s');
    const received: string[] = [];
    sess.dataSubscribers.add((bytes) => received.push(new TextDecoder().decode(bytes)));
    ptyMock.data?.(CLEAR);
    expect(ringText(after.stream)).toBe('screen');
    expect(received).toEqual([]);
    after.host.ringStore.persist(sess);
    after.host.attached.delete('s');
    expect(ringText(after.stream)).toBe('screen');
  });

  test('a repaint coalesced with the clear is kept, and later clears are live output', async () => {
    const after = await launchResizeAndRestart();
    after.stream.ensureReadable('s');
    ptyMock.data?.(`${CLEAR}repaint`);
    ptyMock.data?.(CLEAR);
    expect(ringText(after.stream)).toBe(`screenrepaint${CLEAR}`);
  });

  test('the cold writable path drops the clear too', async () => {
    const after = await launchResizeAndRestart();
    after.stream.ensureWritable('s');
    expect(lastSpawnSize()).toEqual({ cols: 83, rows: 30 });
    ptyMock.data?.(CLEAR);
    expect(ringText(after.stream)).toBe('screen');
  });

  test('a fresh launch still records its first chunk as live output', () => {
    const { dir, sock } = instanceDir();
    const launch = generation(dir);
    launch.stream.openAttach('s', sock, { cols: 100, rows: 30 }, true);
    ptyMock.data?.(`${CLEAR}hello`);
    expect(ringText(launch.stream)).toBe(`${CLEAR}hello`);
  });

  test.each([
    ['missing', undefined],
    ['zero', { cols: 0, rows: 24 }],
    ['fractional', { cols: 80.5, rows: 24 }],
    ['absurd', { cols: 1_000_000, rows: 24 }],
    ['non-numeric', { cols: '120', rows: 40 }],
  ])('falls back to 80x24 when the persisted size is %s', (_label, size) => {
    const { dir } = instanceDir(size);
    generation(dir).stream.ensureReadable('s');
    expect(lastSpawnSize()).toEqual({ cols: 80, rows: 24 });
  });
});
