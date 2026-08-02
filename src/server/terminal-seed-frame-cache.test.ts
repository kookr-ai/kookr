import { describe, expect, it } from 'vitest';
import {
  TerminalSeedFrameCache,
  seedFramesEqual,
} from './terminal-seed-frame-cache.js';

describe('TerminalSeedFrameCache', () => {
  it('stores and returns a copied seed frame', () => {
    const cache = new TerminalSeedFrameCache();
    const bytes = new Uint8Array([1, 2, 3]);
    expect(cache.set('s1', bytes, {
      kind: 'absolute-reconstruct',
      cols: 200,
      rows: 50,
      sourceRingBytes: 1000,
    })).toBe(true);

    bytes[0] = 9;
    const got = cache.get('s1');
    expect(got).not.toBeNull();
    expect(got!.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(got!.kind).toBe('absolute-reconstruct');
    expect(got!.cols).toBe(200);
    expect(got!.sourceRingBytes).toBe(1000);
  });

  it('rejects empty and oversized frames', () => {
    const cache = new TerminalSeedFrameCache({ maxBytes: 4 });
    expect(cache.set('s1', new Uint8Array(0), {
      kind: 'absolute-frame',
      cols: 80,
      rows: 24,
      sourceRingBytes: 0,
    })).toBe(false);
    expect(cache.set('s1', new Uint8Array(5), {
      kind: 'absolute-frame',
      cols: 80,
      rows: 24,
      sourceRingBytes: 0,
    })).toBe(false);
    expect(cache.get('s1')).toBeNull();
  });

  it('evicts oldest entries when over capacity', () => {
    const cache = new TerminalSeedFrameCache({ maxEntries: 2 });
    cache.set('a', new Uint8Array([1]), {
      kind: 'absolute-frame', cols: 80, rows: 24, sourceRingBytes: 1,
    });
    cache.set('b', new Uint8Array([2]), {
      kind: 'absolute-frame', cols: 80, rows: 24, sourceRingBytes: 1,
    });
    cache.set('c', new Uint8Array([3]), {
      kind: 'absolute-frame', cols: 80, rows: 24, sourceRingBytes: 1,
    });
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')?.bytes).toEqual(new Uint8Array([2]));
    expect(cache.get('c')?.bytes).toEqual(new Uint8Array([3]));
  });

  it('refreshing an existing key counts as recent for eviction', () => {
    const cache = new TerminalSeedFrameCache({ maxEntries: 2 });
    cache.set('a', new Uint8Array([1]), {
      kind: 'absolute-frame', cols: 80, rows: 24, sourceRingBytes: 1,
    });
    cache.set('b', new Uint8Array([2]), {
      kind: 'absolute-frame', cols: 80, rows: 24, sourceRingBytes: 1,
    });
    // Touch a so b is oldest.
    cache.set('a', new Uint8Array([11]), {
      kind: 'absolute-frame', cols: 80, rows: 24, sourceRingBytes: 2,
    });
    cache.set('c', new Uint8Array([3]), {
      kind: 'absolute-frame', cols: 80, rows: 24, sourceRingBytes: 1,
    });
    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')?.bytes).toEqual(new Uint8Array([11]));
    expect(cache.get('c')?.bytes).toEqual(new Uint8Array([3]));
  });
});

describe('seedFramesEqual', () => {
  it('compares length and content', () => {
    expect(seedFramesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(seedFramesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(seedFramesEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });
});
