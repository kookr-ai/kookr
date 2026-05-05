/**
 * PCM Audio Buffer for accumulating WebSocket audio chunks.
 *
 * Receives 16-bit Int16 PCM from the client, normalizes to Float32 [-1, 1],
 * and maintains a growing buffer for incremental transcription.
 *
 * FR-STT-010: Parakeet STT Backend
 */

const SAMPLE_RATE = 16000;

export class AudioBuffer {
  constructor(sampleRate = SAMPLE_RATE) {
    this.sampleRate = sampleRate;
    /** @type {Float32Array[]} */
    this._chunks = [];
    this._totalSamples = 0;
    /** @type {Float32Array|null} */
    this._cachedBuffer = null;
  }

  /**
   * Add raw PCM bytes (16-bit Int16 LE) to the buffer.
   *
   * @param {Buffer} pcmBytes - Raw 16-bit PCM audio data
   * @returns {number} Current buffer duration in seconds
   */
  addChunk(pcmBytes) {
    const sampleCount = pcmBytes.byteLength / 2;
    if (sampleCount === 0) return this.duration();

    // Node.js pooled Buffers can have odd byteOffset, which crashes
    // Int16Array (requires 2-byte alignment). Copy to an aligned buffer
    // when the offset is not a multiple of 2.
    let aligned = pcmBytes;
    if (pcmBytes.byteOffset % 2 !== 0) {
      aligned = Buffer.from(pcmBytes);
    }
    const int16 = new Int16Array(
      aligned.buffer,
      aligned.byteOffset,
      sampleCount,
    );
    const float32 = new Float32Array(sampleCount);

    for (let i = 0; i < sampleCount; i++) {
      float32[i] = int16[i] / 32768.0;
    }

    this._chunks.push(float32);
    this._totalSamples += sampleCount;
    this._cachedBuffer = null;

    return this.duration();
  }

  /**
   * Get the complete audio buffer as a single Float32Array.
   * Concatenates all chunks and caches the result.
   *
   * @returns {Float32Array}
   */
  getAudio() {
    if (this._cachedBuffer && this._cachedBuffer.length === this._totalSamples) {
      return this._cachedBuffer;
    }

    const buffer = new Float32Array(this._totalSamples);
    let offset = 0;
    for (const chunk of this._chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }

    this._cachedBuffer = buffer;
    return buffer;
  }

  /**
   * Current buffer duration in seconds.
   * @returns {number}
   */
  duration() {
    return this._totalSamples / this.sampleRate;
  }

  /** Clear all audio data. */
  clear() {
    this._chunks = [];
    this._totalSamples = 0;
    this._cachedBuffer = null;
  }
}
