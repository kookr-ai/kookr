/**
 * Microphone sample capture shared by dictation (`hooks/useSTT.ts`) and hands-free
 * conversation with Lucy (`lucy-live/useLucyLive.ts`).
 *
 * The preferred path is an AudioWorklet (`/pcm-processor.js`), which runs on the
 * browser's audio thread so a busy page cannot make it drop audio. Browsers
 * without AudioWorklet get a ScriptProcessorNode instead: deprecated, and it runs
 * on the main thread, but it works everywhere.
 */

/** Chunk size, in samples at the audio context's rate, when the caller does not ask for another. */
const DEFAULT_CHUNK_SAMPLES = 4096;

/**
 * Set up AudioWorkletNode for audio capture (preferred — runs on audio thread).
 * Returns the worklet node, or null if AudioWorklet is not supported.
 *
 * `chunkSamples` lowers the delivery latency for callers that react to the sound
 * as it arrives; dictation keeps the default.
 */
export async function tryCreateWorkletNode(
  audioContext: AudioContext,
  source: MediaStreamAudioSourceNode,
  onChunk: (data: Float32Array) => void,
  isCurrent: () => boolean,
  onFlushed: () => void,
  chunkSamples?: number,
): Promise<AudioWorkletNode | null> {
  if (!audioContext.audioWorklet) return null;

  try {
    await audioContext.audioWorklet.addModule('/pcm-processor.js');
    if (!isCurrent()) return null;
    const workletNode = new AudioWorkletNode(
      audioContext,
      'pcm-processor',
      chunkSamples ? { processorOptions: { bufferSize: chunkSamples } } : undefined,
    );
    workletNode.port.onmessage = (e: MessageEvent<Float32Array | { type: 'flushed' }>) => {
      if (!isCurrent()) return;
      if (e.data instanceof Float32Array) onChunk(e.data);
      else if (e.data?.type === 'flushed') onFlushed();
    };
    source.connect(workletNode);
    // AudioWorkletNode doesn't need to connect to destination to receive data
    workletNode.connect(audioContext.destination);
    return workletNode;
  } catch {
    return null;
  }
}

/**
 * Set up ScriptProcessorNode as fallback (deprecated — runs on main thread).
 * Drops audio frames under heavy UI load.
 */
export function createScriptProcessorFallback(
  audioContext: AudioContext,
  source: MediaStreamAudioSourceNode,
  onChunk: (data: Float32Array) => void,
  chunkSamples: number = DEFAULT_CHUNK_SAMPLES,
): ScriptProcessorNode {
  const processor = audioContext.createScriptProcessor(chunkSamples, 1, 1);
  processor.onaudioprocess = (e) => {
    // Copy the data — the buffer is reused by the audio graph
    onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(audioContext.destination);
  return processor;
}
