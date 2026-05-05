/**
 * AudioWorklet processor for PCM audio capture.
 *
 * Runs on a dedicated audio thread — never drops frames regardless of
 * main-thread load. Replaces the deprecated ScriptProcessorNode which
 * runs on the main thread and drops callbacks when React/JS is busy.
 *
 * Buffers 4096 samples before sending to match the chunk size used by
 * the STT WebSocket pipeline.
 */

const BUFFER_SIZE = 4096;

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(BUFFER_SIZE);
    this._offset = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0]; // First input, first channel
    if (!input || input.length === 0) return true;

    let srcOffset = 0;

    while (srcOffset < input.length) {
      const remaining = BUFFER_SIZE - this._offset;
      const toCopy = Math.min(input.length - srcOffset, remaining);

      this._buffer.set(input.subarray(srcOffset, srcOffset + toCopy), this._offset);
      this._offset += toCopy;
      srcOffset += toCopy;

      if (this._offset >= BUFFER_SIZE) {
        // Send a copy — the buffer is reused
        this.port.postMessage(this._buffer.slice());
        this._offset = 0;
      }
    }

    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
