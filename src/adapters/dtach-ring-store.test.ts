import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DtachRingStore, RING_BUFFER_BYTES, createDtachRingState } from './dtach-ring-store.js';

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
});
