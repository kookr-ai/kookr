import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
