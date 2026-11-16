import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DtachRingStore,
  RING_BUFFER_BYTES,
  RING_IDLE_CAPACITY_BYTES,
  createDtachRingState,
  enforceRingFleetBudget,
  expandRing,
  ringCapacity,
  ringFleetBudgetSnapshot,
  shrinkRing,
  totalRingFleetBytes,
} from './dtach-ring-store.js';

describe('DtachRingStore', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('copies wrapped ring bytes in logical order', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-ring-test-'));
    const store = new DtachRingStore(tmpDir);
    const state = createDtachRingState('wrapped');
    const head = RING_BUFFER_BYTES + 512 + 7;

    for (let logical = head - RING_BUFFER_BYTES; logical < head; logical += 1) {
      state.ringBuffer[logical % RING_BUFFER_BYTES] = logical & 0xff;
    }
    state.ringHead = head;

    const out = Buffer.alloc(2048);
    store.copyFrom(state, state.ringHead, out.length, out);

    for (let i = 0; i < out.length; i += 1) {
      expect(out[i]).toBe((head - out.length + i) & 0xff);
    }
  });

  it('persists, restores, and removes a snapshot', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-ring-test-'));
    const store = new DtachRingStore(tmpDir);
    const state = createDtachRingState('persisted');
    const payload = new TextEncoder().encode('hello persisted ring');

    store.copyInto(state, payload);
    store.persist(state);

    const restored = createDtachRingState('persisted');
    store.load(restored);

    const out = Buffer.alloc(payload.length);
    store.copyFrom(restored, restored.ringHead, out.length, out);
    expect(out.toString('utf-8')).toBe('hello persisted ring');
    expect(restored.lastFlushedHead).toBe(payload.length);

    store.remove('persisted');
    expect(existsSync(join(tmpDir, 'persisted.bin'))).toBe(false);
    expect(existsSync(join(tmpDir, 'persisted.meta.json'))).toBe(false);
  });

  it('persists a snapshot synchronously when the async writer rejects it at capacity (#3145)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-ring-test-'));
    // A tiny async budget forces the enqueue to be rejected, as happens at
    // graceful shutdown when many dirty rings flush together past the writer's
    // byte budget. The rejected snapshot must still reach disk (sync fallback)
    // instead of being dropped and then losing the ring on disposal.
    const store = new DtachRingStore(tmpDir, { asyncPersistence: true, asyncMaxBytes: 8 });
    const state = createDtachRingState('overflow');
    const payload = new TextEncoder().encode('scrollback that must survive shutdown');
    store.copyInto(state, payload);
    store.persist(state);
    expect(store.persistenceStats().rejected).toBe(1); // enqueue was refused

    const restored = createDtachRingState('overflow');
    store.load(restored);
    const out = Buffer.alloc(payload.length);
    store.copyFrom(restored, restored.ringHead, out.length, out);
    expect(out.toString('utf-8')).toBe('scrollback that must survive shutdown');
    expect(restored.lastFlushedHead).toBe(payload.length);
  });

  it('defers an over-budget snapshot until older writes finish, including after resize', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-ring-test-'));
    const store = new DtachRingStore(tmpDir, { asyncPersistence: true, asyncMaxBytes: 200 });
    const state = createDtachRingState('fallback-race', 128);
    store.copyInto(state, Buffer.from('A'.repeat(80)));
    store.persist(state);
    shrinkRing(state, 64);
    store.copyInto(state, Buffer.from('B'.repeat(16)));
    store.persist(state);
    expect(store.persistenceStats().rejected).toBe(1);
    await store.drain();
    // The last-flushed marker must request another flush while the newest
    // bytes are still only in memory. Shutdown performs this after draining.
    expect(state.lastFlushedHead).not.toBe(state.ringHead);
    store.persist(state);
    await store.drain();
    const restored = createDtachRingState(state.id, 128);
    store.load(restored);
    const out = Buffer.alloc(restored.ringHead);
    store.copyFrom(restored, restored.ringHead, out.length, out);
    expect(out.toString()).toBe('A'.repeat(48) + 'B'.repeat(16));
    expect(state.lastFlushedHead).toBe(state.ringHead);
  });

  it('does not restore a stale flushed head after the ring is shrunk mid-flush (#3145)', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-ring-test-'));
    const store = new DtachRingStore(tmpDir, { asyncPersistence: true });
    const state = createDtachRingState('shrink-race');
    store.copyInto(state, new TextEncoder().encode('X'.repeat(80)));
    expect(state.ringHead).toBe(80);
    // Enqueue an async snapshot at head 80, then re-linearize (shrink) the ring
    // BEFORE the async write completes. The shrink resets lastFlushedHead to -1;
    // the async completion must NOT restore the pre-shrink head 80 (that would
    // mark the shrunk/newer content as already persisted and strand it).
    store.persist(state);
    expect(shrinkRing(state, 64)).toBe(true);
    expect(state.ringHead).toBe(64);
    await store.drain();
    expect(state.lastFlushedHead).not.toBe(80);
    expect(state.lastFlushedHead).toBe(-1); // still dirty -> a later flush re-persists it
  });

  it('copyInto respects a shrunken capacity', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-ring-test-'));
    const store = new DtachRingStore(tmpDir);
    const state = createDtachRingState('small', 16);
    store.copyInto(state, new TextEncoder().encode('abcdefghijklmnopQRST'));
    expect(state.ringHead).toBe(20);
    const out = Buffer.alloc(16);
    store.copyFrom(state, state.ringHead, 16, out);
    expect(out.toString('utf-8')).toBe('efghijklmnopQRST');
  });

  it('re-creates a rings directory that was swept away mid-run (#3042)', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-ring-test-'));
    const ringsDir = join(tmpDir, 'rings');
    const store = new DtachRingStore(ringsDir);
    const state = createDtachRingState('after-sweep');

    store.copyInto(state, new TextEncoder().encode('scrollback after the sweep'));
    // A /tmp sweeper removes the instance directory (and `rings/` with it) while
    // the server is running. persist() swallows write errors, so before #3042
    // this silently dropped every snapshot from here on.
    rmSync(ringsDir, { recursive: true, force: true });

    store.persist(state);

    const restored = createDtachRingState('after-sweep');
    store.load(restored);
    const out2 = Buffer.alloc('scrollback after the sweep'.length);
    store.copyFrom(restored, restored.ringHead, out2.length, out2);
    expect(out2.toString('utf-8')).toBe('scrollback after the sweep');
  });
});

describe('DtachRingStore combined-generation snapshots (issue #2829)', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function restore(store: DtachRingStore, id: string): string {
    const state = createDtachRingState(id);
    store.load(state);
    const out = Buffer.alloc(state.ringHead);
    store.copyFrom(state, state.ringHead, out.length, out);
    return out.toString('utf-8');
  }

  it('persists data and metadata as a single .ring file, not a two-file pair', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-ring-test-'));
    const store = new DtachRingStore(tmpDir);
    const state = createDtachRingState('combined');
    store.copyInto(state, new TextEncoder().encode('one generation'));
    store.persist(state);

    expect(existsSync(join(tmpDir, 'combined.ring'))).toBe(true);
    expect(existsSync(join(tmpDir, 'combined.bin'))).toBe(false);
    expect(existsSync(join(tmpDir, 'combined.meta.json'))).toBe(false);
    expect(restore(store, 'combined')).toBe('one generation');
  });

  it('leaves no leftover temp files after repeated flushes', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-ring-test-'));
    const store = new DtachRingStore(tmpDir);
    const state = createDtachRingState('repeat');
    for (let i = 0; i < 5; i += 1) {
      store.copyInto(state, new TextEncoder().encode(`flush-${i} `));
      store.persist(state);
    }
    const files = readdirSync(tmpDir);
    expect(files).toEqual(['repeat.ring']);
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('shields committed scrollback from the mismatched-pair residue that broke the old format', () => {
    // Reproduce the pre-#2829 data-loss residue: a crash between the two renames
    // left a legacy pair whose metadata size disagreed with its data length,
    // which the old `load` rejected (`meta.size !== buf.length`), failing open to
    // an empty ring and discarding valid scrollback. Here the committed
    // generation lives in the atomic `.ring` file; even with that exact broken
    // legacy pair sitting on disk beside it, recovery returns the real
    // scrollback because the single-file generation is authoritative. Reverting
    // to the two-file format makes this read the mismatched pair and lose the
    // data — so this test genuinely guards the fix.
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-ring-test-'));
    const store = new DtachRingStore(tmpDir);
    const state = createDtachRingState('durable');
    store.copyInto(state, new TextEncoder().encode('committed generation'));
    store.persist(state);

    // A mismatched legacy pair: 5-byte data, metadata claiming 999 bytes.
    writeFileSync(join(tmpDir, 'durable.bin'), Buffer.from('short'));
    writeFileSync(
      join(tmpDir, 'durable.meta.json'),
      JSON.stringify({ version: 1, size: 999, savedAt: 'x', lastByteAt: null }),
    );

    expect(restore(store, 'durable')).toBe('committed generation');
  });

  it('does not fall back to a valid legacy pair when the combined file is present but torn', () => {
    // A present `.ring` is authoritative even when unreadable — falling back to a
    // stale legacy pair would resurrect old scrollback. Guard the deliberate
    // no-fallback choice: a torn `.ring` beside a perfectly good legacy pair must
    // still yield an empty ring, never the legacy bytes.
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-ring-test-'));
    const store = new DtachRingStore(tmpDir);
    writeFileSync(
      join(tmpDir, 'shadow.ring'),
      Buffer.concat([
        Buffer.from(`${JSON.stringify({ version: 2, size: 100, lastByteAt: null })}\n`, 'utf-8'),
        Buffer.from('short'),
      ]),
    );
    writeFileSync(join(tmpDir, 'shadow.bin'), Buffer.from('stale legacy scrollback'));
    writeFileSync(
      join(tmpDir, 'shadow.meta.json'),
      JSON.stringify({ version: 1, size: 23, savedAt: 'x', lastByteAt: 7 }),
    );

    const state = createDtachRingState('shadow');
    store.load(state);
    expect(state.ringHead).toBe(0);
    expect(state.lastByteAt).toBeNull();
  });

  it.each([
    ['size larger than payload', `${JSON.stringify({ version: 2, size: 100, lastByteAt: null })}\n`, 'short'],
    ['size smaller than payload', `${JSON.stringify({ version: 2, size: 2, lastByteAt: null })}\n`, 'much longer body'],
    ['unknown version', `${JSON.stringify({ version: 3, size: 4, lastByteAt: null })}\n`, 'body'],
    ['legacy version in combined file', `${JSON.stringify({ version: 1, size: 4, lastByteAt: null })}\n`, 'body'],
    ['invalid json header', 'this is not json\n', 'body'],
    ['no separator at all', 'no newline anywhere in this file', ''],
  ])('fails open to an empty ring on a torn combined file (%s)', (_label, header, body) => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-ring-test-'));
    const store = new DtachRingStore(tmpDir);
    writeFileSync(join(tmpDir, 'torn.ring'), Buffer.concat([Buffer.from(header, 'utf-8'), Buffer.from(body)]));

    const state = createDtachRingState('torn');
    expect(() => store.load(state)).not.toThrow();
    expect(state.ringHead).toBe(0);
  });

  it('round-trips an empty ring (size 0) without writing a stray generation', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-ring-test-'));
    const store = new DtachRingStore(tmpDir);
    const state = createDtachRingState('empty');
    store.persist(state); // never ingested any bytes
    expect(existsSync(join(tmpDir, 'empty.ring'))).toBe(true);

    const restored = createDtachRingState('empty');
    expect(() => store.load(restored)).not.toThrow();
    expect(restored.ringHead).toBe(0);
  });

  it('round-trips a wrapped ring (head > capacity) through the combined format', () => {
    // The fix rewrote the persist packing; drive a buffer past capacity so bytes
    // are stored out of logical order and confirm the combined snapshot restores
    // the most-recent capacity bytes in logical order.
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-ring-test-'));
    const store = new DtachRingStore(tmpDir);
    const state = createDtachRingState('wrapped', 16);
    store.copyInto(state, new TextEncoder().encode('abcdefghijklmnopQRSTUVWX')); // 24 > 16
    expect(state.ringHead).toBe(24);
    store.persist(state);

    const restored = createDtachRingState('wrapped', 16);
    store.load(restored);
    const out = Buffer.alloc(restored.ringHead);
    store.copyFrom(restored, restored.ringHead, out.length, out);
    expect(out.toString('utf-8')).toBe('ijklmnopQRSTUVWX'); // last 16 bytes, in order
  });

  it('reports the exact bytes it committed via a size-matched round-trip', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-ring-test-'));
    const store = new DtachRingStore(tmpDir);
    const state = createDtachRingState('roundtrip');
    const payload = new TextEncoder().encode('measure me precisely');
    store.copyInto(state, payload);
    store.persist(state);

    const file = readFileSync(join(tmpDir, 'roundtrip.ring'));
    const sep = file.indexOf(0x0a);
    const meta = JSON.parse(file.subarray(0, sep).toString('utf-8')) as { size: number };
    expect(meta.size).toBe(payload.length);
    expect(file.subarray(sep + 1).length).toBe(payload.length);
  });

  it('restores a legacy two-file snapshot written before the format upgrade', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-ring-test-'));
    const store = new DtachRingStore(tmpDir);
    const payload = Buffer.from('legacy scrollback');
    writeFileSync(join(tmpDir, 'legacy.bin'), payload);
    writeFileSync(
      join(tmpDir, 'legacy.meta.json'),
      JSON.stringify({ version: 1, size: payload.length, savedAt: 'x', lastByteAt: 42 }),
    );

    const state = createDtachRingState('legacy');
    store.load(state);
    const out = Buffer.alloc(state.ringHead);
    store.copyFrom(state, state.ringHead, out.length, out);
    expect(out.toString('utf-8')).toBe('legacy scrollback');
    expect(state.lastByteAt).toBe(42);
  });

  it('a fresh persist retires the legacy two-file snapshot it supersedes', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-ring-test-'));
    const store = new DtachRingStore(tmpDir);
    writeFileSync(join(tmpDir, 'upgrade.bin'), Buffer.from('old'));
    writeFileSync(
      join(tmpDir, 'upgrade.meta.json'),
      JSON.stringify({ version: 1, size: 3, savedAt: 'x', lastByteAt: null }),
    );

    const state = createDtachRingState('upgrade');
    store.copyInto(state, new TextEncoder().encode('new content'));
    store.persist(state);

    expect(existsSync(join(tmpDir, 'upgrade.bin'))).toBe(false);
    expect(existsSync(join(tmpDir, 'upgrade.meta.json'))).toBe(false);
    expect(existsSync(join(tmpDir, 'upgrade.ring'))).toBe(true);
    expect(restore(store, 'upgrade')).toBe('new content');
  });

  it('remove deletes both the combined file and any legacy pair', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dtach-ring-test-'));
    const store = new DtachRingStore(tmpDir);
    const state = createDtachRingState('cleanup');
    store.copyInto(state, new TextEncoder().encode('bye'));
    store.persist(state);
    // A stale legacy pair can coexist if it was never superseded by a persist.
    writeFileSync(join(tmpDir, 'cleanup.bin'), Buffer.from('stale'));
    writeFileSync(join(tmpDir, 'cleanup.meta.json'), '{}');

    store.remove('cleanup');
    expect(existsSync(join(tmpDir, 'cleanup.ring'))).toBe(false);
    expect(existsSync(join(tmpDir, 'cleanup.bin'))).toBe(false);
    expect(existsSync(join(tmpDir, 'cleanup.meta.json'))).toBe(false);
  });
});

describe('ring fleet budget (issue #1779)', () => {
  it('NFR-TERM-001: asynchronously persists a complete generation and fences deletion', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dtach-ring-async-'));
    try {
      const store = new DtachRingStore(dir, { asyncPersistence: true });
      const state = createDtachRingState('s');
      store.copyInto(state, Buffer.from('old'));
      store.persist(state);
      store.copyInto(state, Buffer.from('new'));
      store.persist(state);
      await store.drain();
      const restored = createDtachRingState('s');
      store.load(restored);
      const out = Buffer.alloc(6);
      store.copyFrom(restored, restored.ringHead, 6, out);
      expect(out.toString()).toBe('oldnew');
      expect(state.lastFlushedHead).toBe(6);
      store.copyInto(state, Buffer.from('never resurrect'));
      store.persist(state);
      await store.remove('s');
      await store.drain();
      expect(existsSync(join(dir, 's.ring'))).toBe(false);
      expect(store.persistenceStats().pendingBytes).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('shrinkRing keeps the most recent bytes and lowers capacity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dtach-ring-shrink-'));
    try {
      const store = new DtachRingStore(dir);
      const state = createDtachRingState('s', 32);
      store.copyInto(state, new TextEncoder().encode('0123456789ABCDEFGHIJ'));
      expect(shrinkRing(state, 8)).toBe(true);
      expect(ringCapacity(state)).toBe(8);
      expect(state.ringHead).toBe(8);
      const out = Buffer.alloc(8);
      store.copyFrom(state, state.ringHead, 8, out);
      expect(out.toString('utf-8')).toBe('CDEFGHIJ');
      // Second shrink to same floor is a no-op.
      expect(shrinkRing(state, 8)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('expandRing restores full capacity without losing retained bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dtach-ring-expand-'));
    try {
      const store = new DtachRingStore(dir);
      const state = createDtachRingState('e', 8);
      store.copyInto(state, new TextEncoder().encode('abcdefgh'));
      expect(expandRing(state, 32)).toBe(true);
      expect(ringCapacity(state)).toBe(32);
      const out = Buffer.alloc(8);
      store.copyFrom(state, state.ringHead, 8, out);
      expect(out.toString('utf-8')).toBe('abcdefgh');
      store.copyInto(state, new TextEncoder().encode('XYZ'));
      const out2 = Buffer.alloc(11);
      store.copyFrom(state, state.ringHead, 11, out2);
      expect(out2.toString('utf-8')).toBe('abcdefghXYZ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforceRingFleetBudget shrinks least-recently-active rings first', () => {
    const full = 4 * RING_IDLE_CAPACITY_BYTES; // 256 KiB per ring
    const a = createDtachRingState('a', full);
    const b = createDtachRingState('b', full);
    const c = createDtachRingState('c', full);
    a.lastByteAt = 100;
    b.lastByteAt = 300;
    c.lastByteAt = 200;

    // Budget fits only one full ring + two idle floors.
    const budget = full + 2 * RING_IDLE_CAPACITY_BYTES;
    const result = enforceRingFleetBudget([a, b, c], budget, RING_IDLE_CAPACITY_BYTES);

    expect(result.shrunk).toBe(2);
    expect(ringCapacity(a)).toBe(RING_IDLE_CAPACITY_BYTES); // oldest
    expect(ringCapacity(c)).toBe(RING_IDLE_CAPACITY_BYTES); // middle
    expect(ringCapacity(b)).toBe(full); // most recently active kept full
    expect(result.totalBytes).toBe(budget);
    expect(result.overBudgetBytes).toBe(0);
  });

  it('enforceRingFleetBudget is a no-op when budget is 0 or under budget', () => {
    const rings = [createDtachRingState('x'), createDtachRingState('y')];
    expect(enforceRingFleetBudget(rings, 0).shrunk).toBe(0);
    expect(ringCapacity(rings[0]!)).toBe(RING_BUFFER_BYTES);
    expect(enforceRingFleetBudget(rings, 3 * RING_BUFFER_BYTES).shrunk).toBe(0);
    expect(totalRingFleetBytes(rings)).toBe(2 * RING_BUFFER_BYTES);
  });

  it('ringFleetBudgetSnapshot reports pressure without secret flags', () => {
    const rings = [
      createDtachRingState('full'),
      createDtachRingState('idle', RING_IDLE_CAPACITY_BYTES),
    ];
    const snap = ringFleetBudgetSnapshot(rings, RING_BUFFER_BYTES);
    expect(snap.totalBytes).toBe(RING_BUFFER_BYTES + RING_IDLE_CAPACITY_BYTES);
    expect(snap.budgetBytes).toBe(RING_BUFFER_BYTES);
    expect(snap.overBudgetBytes).toBe(RING_IDLE_CAPACITY_BYTES);
    expect(snap.shrunkenSessions).toBe(1);
  });

  it('null lastByteAt is treated as least recently active', () => {
    const full = 2 * RING_IDLE_CAPACITY_BYTES;
    const never = createDtachRingState('never', full);
    const recent = createDtachRingState('recent', full);
    never.lastByteAt = null;
    recent.lastByteAt = Date.now();
    enforceRingFleetBudget([never, recent], full + RING_IDLE_CAPACITY_BYTES, RING_IDLE_CAPACITY_BYTES);
    expect(ringCapacity(never)).toBe(RING_IDLE_CAPACITY_BYTES);
    expect(ringCapacity(recent)).toBe(full);
  });
});

describe('fleet shrink keeps the scrollback it drops (issue #3565)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function newStore(options: { asyncPersistence?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'dtach-ring-pre-shrink-'));
    dirs.push(dir);
    return { dir, store: new DtachRingStore(dir, options) };
  }
  const write = (store: DtachRingStore, state: ReturnType<typeof createDtachRingState>, text: string) =>
    store.copyInto(state, Buffer.from(text));
  /** The pre-shrink snapshot files of session `s` in `dir`. */
  const snapshots = (dir: string) => readdirSync(dir).filter((name) => name.startsWith('s.pre-shrink.')).sort();
  /** What a new server generation restores for `s` from `dir`. */
  function restored(dir: string): string {
    const state = createDtachRingState('s');
    new DtachRingStore(dir).load(state);
    const out = Buffer.alloc(Math.min(state.ringHead, state.ringBuffer.length));
    new DtachRingStore(dir).copyFrom(state, state.ringHead, out.length, out);
    return out.toString();
  }

  it.each([false, true])('restores the full ring plus later output after the flush (async=%s)', async (asyncPersistence) => {
    const { dir, store } = newStore({ asyncPersistence });
    const state = createDtachRingState('s', 32);
    write(store, state, '0123456789ABCDEFGHIJ');
    expect(store.shrink(state, 8)).toBe(true);
    expect(ringCapacity(state)).toBe(8);
    write(store, state, 'xyz');
    // The periodic flush now writes the 8-byte ring over `s.ring`.
    store.persist(state);
    await store.drain();
    expect(restored(dir)).toBe('0123456789ABCDEFGHIJxyz');
  });

  it('enforceRingFleetBudget saves through the shrink it is given', () => {
    const { dir, store } = newStore();
    const state = createDtachRingState('s', 4 * RING_IDLE_CAPACITY_BYTES);
    const history = 'h'.repeat(RING_IDLE_CAPACITY_BYTES) + 'tail';
    write(store, state, history);
    enforceRingFleetBudget([state], RING_IDLE_CAPACITY_BYTES, RING_IDLE_CAPACITY_BYTES,
      (s, capacity) => store.shrink(s, capacity));
    expect(ringCapacity(state)).toBe(RING_IDLE_CAPACITY_BYTES);
    store.persist(state);
    expect(restored(dir)).toBe(history);
  });

  it('a ring that already fits loses nothing and writes no snapshot', () => {
    const { dir, store } = newStore();
    const state = createDtachRingState('s', 32);
    write(store, state, 'short');
    expect(store.shrink(state, 8)).toBe(true);
    expect(snapshots(dir)).toEqual([]);
    store.persist(state);
    expect(restored(dir)).toBe('short');
  });

  it('drops the snapshot once more output arrived than the ring holds, instead of splicing across the hole', () => {
    const { dir, store } = newStore();
    const state = createDtachRingState('s', 32);
    write(store, state, '0123456789ABCDEFGHIJ');
    store.shrink(state, 8);
    write(store, state, 'abcdefghi'); // 9 new bytes: the ring keeps only 'bcdefghi'
    expect(snapshots(dir)).toHaveLength(1);
    store.persist(state);
    expect(snapshots(dir)).toEqual([]);
    expect(restored(dir)).toBe('bcdefghi');
  });

  it('keeps joining after a restart until the ring stops continuing the snapshot', () => {
    const { dir, store } = newStore();
    const state = createDtachRingState('s', 32);
    write(store, state, '0123456789ABCDEFGHIJ');
    store.shrink(state, 8);
    store.persist(state);

    // Next generation: the joined history loads into a full-size ring and its
    // flushes keep naming the snapshot.
    const next = new DtachRingStore(dir);
    const reloaded = createDtachRingState('s');
    next.load(reloaded);
    next.copyInto(reloaded, Buffer.from('new'));
    next.persist(reloaded);
    expect(restored(dir)).toBe('0123456789ABCDEFGHIJnew');
  });

  it('carries the older snapshot forward when an expanded ring is shrunk again', () => {
    const { dir, store } = newStore();
    const state = createDtachRingState('s', 32);
    write(store, state, '0123456789ABCDEFGHIJ');
    store.shrink(state, 8);
    expect(expandRing(state, 32)).toBe(true);
    write(store, state, 'abcdefghijkl');
    store.shrink(state, 8);
    write(store, state, '!');
    store.persist(state);
    expect(restored(dir)).toBe('0123456789ABCDEFGHIJabcdefghijkl!');
  });

  it('keeps post-shrink output when the shrunk ring wrapped before it was expanded', () => {
    const { dir, store } = newStore();
    const state = createDtachRingState('s', 32);
    write(store, state, '0123456789ABCDEFGHIJ');
    store.shrink(state, 8);
    write(store, state, 'abcde'); // wraps the 8-byte ring: it now holds 'HIJabcde'
    expect(expandRing(state, 32)).toBe(true);
    write(store, state, '!');
    store.persist(state);
    expect(restored(dir)).toBe('0123456789ABCDEFGHIJabcde!');
  });

  it('keeps the join point right when snapshot plus newer output exceeds a full ring', () => {
    const { dir, store } = newStore();
    const state = createDtachRingState('s');
    write(store, state, 'x'.repeat(RING_BUFFER_BYTES - 4) + 'TAIL');
    store.shrink(state, RING_IDLE_CAPACITY_BYTES);
    write(store, state, 'new1');
    store.persist(state);
    // Restart: snapshot + 'new1' is 4 bytes over capacity, so the load drops
    // the 4 oldest bytes. The next generation's flush must still join correctly.
    const next = new DtachRingStore(dir);
    const reloaded = createDtachRingState('s');
    next.load(reloaded);
    next.copyInto(reloaded, Buffer.from('new2'));
    next.persist(reloaded);
    expect(restored(dir).endsWith('TAILnew1new2')).toBe(true);
  });

  it('caps the carried-forward snapshot at one full ring', () => {
    const { dir, store } = newStore();
    const state = createDtachRingState('s');
    write(store, state, 'a'.repeat(RING_BUFFER_BYTES));
    store.shrink(state, RING_IDLE_CAPACITY_BYTES);
    expandRing(state, RING_BUFFER_BYTES);
    write(store, state, 'b'.repeat(RING_BUFFER_BYTES / 2));
    store.shrink(state, RING_IDLE_CAPACITY_BYTES);
    const newest = snapshots(dir).find((name) => name.includes(state.preShrink!.snapshotId))!;
    const file = readFileSync(join(dir, newest));
    const payload = file.subarray(file.indexOf(0x0a) + 1);
    expect(payload.length).toBe(RING_BUFFER_BYTES);
    expect(payload.subarray(-4).toString()).toBe('bbbb');
  });

  it('ignores and deletes a snapshot the ring file does not name', () => {
    const { dir, store } = newStore();
    const state = createDtachRingState('s', 32);
    write(store, state, '0123456789ABCDEFGHIJ');
    store.shrink(state, 8);
    store.persist(state);
    // The file `s.ring` points at holds some other snapshot.
    const path = join(dir, snapshots(dir)[0]!);
    const file = readFileSync(path);
    const sep = file.indexOf(0x0a);
    const header = { ...JSON.parse(file.subarray(0, sep).toString()), snapshotId: 'other' };
    writeFileSync(path, Buffer.concat([Buffer.from(JSON.stringify(header) + '\n'), file.subarray(sep + 1)]));
    expect(restored(dir)).toBe('CDEFGHIJ');
    expect(existsSync(path)).toBe(false);
  });

  it.each([false, true])('shrinks anyway when the snapshot cannot be written (async=%s)', async (asyncPersistence) => {
    const { dir, store } = newStore({ asyncPersistence });
    // A regular file where the rings directory should be makes the save fail.
    rmSync(dir, { recursive: true });
    writeFileSync(dir, '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const state = createDtachRingState('s', 32);
      write(store, state, '0123456789ABCDEFGHIJ');
      expect(store.shrink(state, 8)).toBe(true);
      expect(ringCapacity(state)).toBe(8);
      // The sync save fails at once; the async one fails in the background.
      if (!asyncPersistence) expect(state.preShrink).toBeNull();
      await store.drain();
      expect(state.preShrink).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to save pre-shrink scrollback for s'));
    } finally { warn.mockRestore(); }
  });

  it.each([false, true])('remove deletes the snapshot too (async=%s)', async (asyncPersistence) => {
    const { dir, store } = newStore({ asyncPersistence });
    const state = createDtachRingState('s', 32);
    write(store, state, '0123456789ABCDEFGHIJ');
    store.shrink(state, 8);
    store.persist(state);
    await store.drain();
    expect(snapshots(dir)).toHaveLength(1);
    await store.remove('s');
    expect(readdirSync(dir)).toEqual([]);
  });

  /** Shrink, flush, expand, more output, flush: `s.ring` now names snapshot A. */
  async function shrunkTwiceSetup(asyncPersistence: boolean) {
    const { dir, store } = newStore({ asyncPersistence });
    const state = createDtachRingState('s', 32);
    write(store, state, '0123456789ABCDEFGHIJ');
    store.shrink(state, 8);
    store.persist(state);
    await store.drain();
    expandRing(state, 32);
    write(store, state, 'abcdefghijkl');
    store.persist(state);
    await store.drain();
    return { dir, store, state };
  }

  it.each([false, true])('keeps the older history when the server dies right after a second shrink (#3965, async=%s)', async (asyncPersistence) => {
    const { dir, store, state } = await shrunkTwiceSetup(asyncPersistence);
    store.shrink(state, 8);
    await store.drain();
    // No flush since the second shrink: `s.ring` still names the first snapshot.
    expect(snapshots(dir)).toHaveLength(2);
    expect(restored(dir)).toBe('0123456789ABCDEFGHIJabcdefghijkl');
  });

  it.each([false, true])('deletes the older snapshot once a ring naming the newer one is on disk (async=%s)', async (asyncPersistence) => {
    const { dir, store, state } = await shrunkTwiceSetup(asyncPersistence);
    const first = state.preShrink!.snapshotId;
    store.shrink(state, 8);
    const second = state.preShrink!.snapshotId;
    write(store, state, '!');
    store.persist(state);
    await store.drain();
    expect(snapshots(dir)).toEqual([`s.pre-shrink.${second}.ring`]);
    expect(first).not.toBe(second);
    expect(restored(dir)).toBe('0123456789ABCDEFGHIJabcdefghijkl!');
  });

  it('keeps the newer snapshot when a flush captured before the shrink commits after it', async () => {
    const { dir, store, state } = await shrunkTwiceSetup(true);
    write(store, state, 'mn');
    store.persist(state); // captured now, naming the first snapshot; still in flight
    store.shrink(state, 8);
    await store.drain();
    // That commit named the first snapshot, so the second must survive it.
    expect(snapshots(dir)).toHaveLength(2);
    store.persist(state);
    await store.drain();
    expect(snapshots(dir)).toHaveLength(1);
    expect(restored(dir)).toBe('0123456789ABCDEFGHIJabcdefghijklmn');
  });

  it('writes the snapshot off the event loop with async persistence (#3965)', async () => {
    const { dir, store } = newStore({ asyncPersistence: true });
    const state = createDtachRingState('s', 32);
    write(store, state, '0123456789ABCDEFGHIJ');
    store.shrink(state, 8);
    // Nothing reached the disk while shrink() ran.
    expect(snapshots(dir)).toEqual([]);
    write(store, state, 'xyz');
    store.persist(state);
    await store.drain();
    expect(snapshots(dir)).toHaveLength(1);
    expect(restored(dir)).toBe('0123456789ABCDEFGHIJxyz');
  });

  it('never commits a ring that names a snapshot not yet on disk', async () => {
    const { dir, store, state } = await shrunkTwiceSetup(true);
    store.shrink(state, 8);
    write(store, state, '!');
    store.persist(state); // names the second snapshot, whose write is still queued
    let done = false;
    const drained = store.drain().then(() => { done = true; });
    const dangling: string[] = [];
    while (!done) {
      const file = readFileSync(join(dir, 's.ring'));
      const named = JSON.parse(file.subarray(0, file.indexOf(0x0a)).toString()).preShrink?.snapshotId;
      if (named && !existsSync(join(dir, `s.pre-shrink.${named}.ring`))) dangling.push(named);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await drained;
    expect(dangling).toEqual([]);
    expect(restored(dir)).toBe('0123456789ABCDEFGHIJabcdefghijkl!');
  });

  it('remove waits for a snapshot still being written', async () => {
    const { dir, store } = newStore({ asyncPersistence: true });
    const state = createDtachRingState('s', 32);
    write(store, state, '0123456789ABCDEFGHIJ');
    store.shrink(state, 8);
    await store.remove('s');
    await store.drain();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('restores and removes a snapshot saved under the fixed name used before #3965', async () => {
    const { dir, store } = newStore();
    const state = createDtachRingState('s', 32);
    write(store, state, '0123456789ABCDEFGHIJ');
    store.shrink(state, 8);
    store.persist(state);
    const [name] = snapshots(dir);
    renameSync(join(dir, name!), join(dir, 's.pre-shrink.ring'));
    expect(restored(dir)).toBe('0123456789ABCDEFGHIJ');
    expect(snapshots(dir)).toEqual(['s.pre-shrink.ring']);
    await new DtachRingStore(dir).remove('s');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('on load deletes only the snapshots of this session that its ring does not name', () => {
    const { dir, store } = newStore();
    const state = createDtachRingState('s', 32);
    write(store, state, '0123456789ABCDEFGHIJ');
    store.shrink(state, 8);
    store.persist(state);
    const [named] = snapshots(dir);
    const stray = ['s.pre-shrink.other.ring', 's.pre-shrink.ring', 't.pre-shrink.other.ring', 's-2.pre-shrink.x.ring'];
    for (const name of stray) writeFileSync(join(dir, name), 'x');
    expect(restored(dir)).toBe('0123456789ABCDEFGHIJ');
    expect(readdirSync(dir).sort()).toEqual(['s-2.pre-shrink.x.ring', 's.ring', named, 't.pre-shrink.other.ring'].sort());
  });
});
