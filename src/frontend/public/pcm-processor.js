/**
 * AudioWorklet processor for PCM audio capture.
 *
 * Runs on a dedicated audio thread so main-thread load does not interrupt
 * capture. Replaces the deprecated ScriptProcessorNode which
 * runs on the main thread and drops callbacks when React/JS is busy.
 *
 * Buffers 4096 samples before sending to match the chunk size used by
 * the STT WebSocket pipeline. A caller that needs lower latency (hands-free
 * conversation with Lucy) passes `processorOptions: { bufferSize }` to the node.
 */

const DEFAULT_BUFFER_SIZE = 4096;

class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const requested = options?.processorOptions?.bufferSize;
    this._size = Number.isInteger(requested) && requested >= 128 ? requested : DEFAULT_BUFFER_SIZE;
    this._buffer = new Float32Array(this._size);
    this._offset = 0;
    this._stopped = false;
    this.port.onmessage = (event) => {
      if (event.data?.type !== 'flush' || this._stopped) return;
      this._stopped = true;
      if (this._offset > 0) this.port.postMessage(this._buffer.slice(0, this._offset));
      this._offset = 0;
      // Messages on this port are ordered: the main thread sends this remainder
      // to the service before it receives the acknowledgement and requests finalization.
      this.port.postMessage({ type: 'flushed' });
    };
  }

  process(inputs) {
    if (this._stopped) return false;
    const input = inputs[0]?.[0]; // First input, first channel
    if (!input || input.length === 0) return true;

    let srcOffset = 0;

    while (srcOffset < input.length) {
      const remaining = this._size - this._offset;
      const toCopy = Math.min(input.length - srcOffset, remaining);

      this._buffer.set(input.subarray(srcOffset, srcOffset + toCopy), this._offset);
      this._offset += toCopy;
      srcOffset += toCopy;

      if (this._offset >= this._size) {
        // Send a copy — the buffer is reused
        this.port.postMessage(this._buffer.slice());
        this._offset = 0;
      }
    }

    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
