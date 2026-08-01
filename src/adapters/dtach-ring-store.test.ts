import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
