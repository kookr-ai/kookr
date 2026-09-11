import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
