/**
 * PCM Audio Buffer for accumulating WebSocket audio chunks.
 *
 * Receives 16-bit Int16 PCM from the client, normalizes to Float32 [-1, 1],
 * and maintains a growing buffer for incremental transcription.
 *
 * The buffer is bounded by a rolling window (default {@link DEFAULT_MAX_BUFFER_SECONDS})
 * so a client that streams audio without ever sending `stop`/`clear` cannot grow
 * memory without limit. When the window is exceeded the oldest samples are trimmed
 * off the front rather than rejecting new audio.
 *
 * FR-STT-010: Parakeet STT Backend
 */

const SAMPLE_RATE = 16000;

/**
 * Default rolling-window length for the accumulating buffer, in seconds.
 * Generous enough for legitimate long dictations while still bounding
 * per-connection memory (300s @ 16kHz Float32 ≈ 19 MB).
 */
export const DEFAULT_MAX_BUFFER_SECONDS = 300;

export class AudioBuffer {
  /**
   * @param {number} [sampleRate]
   * @param {number} [maxSamples] Rolling-window cap in samples. Values <= 0
   *   disable trimming (unbounded). Defaults to
   *   `DEFAULT_MAX_BUFFER_SECONDS * sampleRate`.
   */
  constructor(sampleRate = SAMPLE_RATE, maxSamples = null) {
    this.sampleRate = sampleRate;
    this.maxSamples =
      maxSamples == null ? Math.round(DEFAULT_MAX_BUFFER_SECONDS * sampleRate) : maxSamples;
    /** @type {Float32Array[]} */
    this._chunks = [];
    this._totalSamples = 0;
    /**
     * Absolute index of the first sample currently held, i.e. how many
     * samples the rolling window has dropped off the front since the last
     * `clear()`. Consumers that track absolute (session-relative) offsets
     * use this to rebase into the trimmed buffer's coordinates.
     * @type {number}
     */
    this._trimmedSamples = 0;
    /** @type {Float32Array|null} */
    this._cachedBuffer = null;
  }

  /**
   * Absolute index of `getAudio()[0]` within the full session — the count of
   * samples trimmed off the front so far. `0` until the rolling window engages.
   * @returns {number}
   */
  get trimmedSamples() {
    return this._trimmedSamples;
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

    this._trimToWindow();

    return this.duration();
  }

  /**
   * Drop the oldest samples until the buffer fits within `maxSamples`.
   * Whole leading chunks are shifted off; the chunk that straddles the
   * window boundary is sliced (copied) so its old backing memory is freed.
   */
  _trimToWindow() {
    if (this.maxSamples <= 0) return;

    while (this._totalSamples > this.maxSamples && this._chunks.length > 0) {
      const overflow = this._totalSamples - this.maxSamples;
      const head = this._chunks[0];
      if (head.length <= overflow) {
        this._chunks.shift();
        this._totalSamples -= head.length;
        this._trimmedSamples += head.length;
      } else {
        this._chunks[0] = head.slice(overflow);
        this._totalSamples -= overflow;
        this._trimmedSamples += overflow;
      }
      this._cachedBuffer = null;
    }
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
    this._trimmedSamples = 0;
    this._cachedBuffer = null;
  }
}
