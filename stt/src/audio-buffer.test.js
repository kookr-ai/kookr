/**
 * Tests for AudioBuffer — alignment safety and data integrity.
 *
 * Node.js `ws` library returns pooled Buffers whose byteOffset can be odd.
 * AudioBuffer.addChunk() must handle this without crashing.
 */

import { describe, test, expect } from 'vitest';
import { AudioBuffer } from './audio-buffer.js';

// -- Helpers ------------------------------------------------------------------

/** Create a Buffer containing a known Int16 PCM pattern (ascending ramp). */
function createPCMBuffer(sampleCount) {
  const buf = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i++) {
    buf.writeInt16LE((i * 100) % 32000, i * 2); // ramp with wrap to stay in Int16 range
  }
  return buf;
}

/**
 * Simulate a Node.js pooled Buffer with a specific byteOffset.
 *
 * Node.js Buffer.allocUnsafe() for small sizes uses an internal 8 KB pool.
 * The returned Buffer is a view into that pool with an arbitrary byteOffset.
 * We replicate this by slicing from a larger buffer.
 */
function createPooledBuffer(data, desiredByteOffset) {
  const backing = Buffer.alloc(desiredByteOffset + data.byteLength);
  data.copy(backing, desiredByteOffset);
  return backing.subarray(desiredByteOffset);
}

// -- Tests --------------------------------------------------------------------

describe('AudioBuffer', () => {
  describe('happy path', () => {
    test('aligned buffer (byteOffset=0) works correctly', () => {
      const ab = new AudioBuffer();
      const pcm = createPCMBuffer(50);

      expect(pcm.byteOffset).toBe(0);
      ab.addChunk(pcm);

      const audio = ab.getAudio();
      expect(audio.length).toBe(50);
      expect(audio[0]).toBeCloseTo(0);
      expect(audio[1]).toBeCloseTo(100 / 32768, 4);
    });

    test('even byteOffset (2, 4, 6...) works correctly', () => {
      const ab = new AudioBuffer();
      const rawData = createPCMBuffer(50);
      const pooled = createPooledBuffer(rawData, 2);

      expect(pooled.byteOffset % 2).toBe(0);
      ab.addChunk(pooled);
      expect(ab.getAudio().length).toBe(50);
    });

    test('multiple chunks accumulate correctly', () => {
      const ab = new AudioBuffer();
      ab.addChunk(createPCMBuffer(100));
      ab.addChunk(createPCMBuffer(200));
      ab.addChunk(createPCMBuffer(50));

      expect(ab.getAudio().length).toBe(350);
      expect(ab.duration()).toBeCloseTo(350 / 16000, 4);
    });
  });

  describe('alignment safety (fixed)', () => {
    test('odd byteOffset (1) no longer crashes — data is preserved', () => {
      const ab = new AudioBuffer();
      const rawData = createPCMBuffer(50);
      const unaligned = createPooledBuffer(rawData, 1);

      expect(unaligned.byteOffset % 2).toBe(1);

      // Should NOT throw — the fix copies to an aligned buffer
      ab.addChunk(unaligned);
      expect(ab.getAudio().length).toBe(50);

      // Verify data integrity: first sample should match original
      expect(ab.getAudio()[0]).toBeCloseTo(0);
      expect(ab.getAudio()[1]).toBeCloseTo(100 / 32768, 4);
    });

    test('odd byteOffset (3) no longer crashes', () => {
      const ab = new AudioBuffer();
      const rawData = createPCMBuffer(50);
      const unaligned = createPooledBuffer(rawData, 3);

      expect(unaligned.byteOffset % 2).toBe(1);
      ab.addChunk(unaligned);
      expect(ab.getAudio().length).toBe(50);
    });

    test('mixed aligned/unaligned chunks all preserved', () => {
      const ab = new AudioBuffer();

      // Chunk 1: aligned
      ab.addChunk(createPCMBuffer(1000));

      // Chunk 2: unaligned — now handled safely
      const rawData = createPCMBuffer(1000);
      const unaligned = createPooledBuffer(rawData, 1);
      ab.addChunk(unaligned);

      // Chunk 3: aligned
      ab.addChunk(createPCMBuffer(1000));

      // All 3000 samples preserved — zero audio loss
      expect(ab.getAudio().length).toBe(3000);
    });
  });
});
