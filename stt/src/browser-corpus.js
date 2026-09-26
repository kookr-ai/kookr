/**
 * Keep one complete recording for evaluation, independently of the recognizer's
 * sliding audio window. Oversized recordings are omitted as a whole: pairing a
 * truncated waveform with a complete transcript would corrupt the corpus.
 */
const SAMPLE_RATE = 16000;
const MAX_PCM_BYTES = SAMPLE_RATE * 2 * 300;

function pcmToWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export class BrowserCorpusCapture {
  constructor(writer, backend, pipeline, logger = console) {
    this.writer = writer;
    this.backend = backend;
    this.pipeline = pipeline;
    this.logger = logger;
    this.generation = 0;
    this.discard();
  }

  discard() {
    this.generation += 1;
    this.chunks = [];
    this.bytes = 0;
    this.startedAt = null;
    this.omitted = false;
    this.recognition = null;
    this.inferenceCount = 0;
  }

  append(bytes) {
    if (!this.writer.enabled || this.omitted) return;
    if (bytes.length % 2 !== 0 || this.bytes + bytes.length > MAX_PCM_BYTES) {
      this.chunks = [];
      this.bytes = 0;
      this.omitted = true;
      this.logger.warn('[stt-corpus] browser_recording_omitted');
      return;
    }
    if (bytes.length === 0) return;
    this.startedAt ??= Date.now();
    this.chunks.push(Buffer.from(bytes));
    this.bytes += bytes.length;
  }

  /** Bind provenance to this recording even when an old inference settles late. */
  async transcribe(audio, options) {
    const generation = this.generation;
    const result = await this.backend.transcribe(audio, options);
    if (generation === this.generation) {
      this.recognition = result.recognition ?? null;
      this.inferenceCount += 1;
    }
    return result;
  }

  finish(transcript, language, status = 'success', errorCode = null) {
    if (!this.writer.enabled || this.omitted || this.bytes === 0) {
      this.discard();
      return;
    }
    const record = {
      audio: pcmToWav(Buffer.concat(this.chunks, this.bytes)),
      format: 'wav',
      metadata: {
        source: 'browser', status, transcript, errorCode,
        startedAt: new Date(this.startedAt).toISOString(),
        durationSeconds: this.bytes / (SAMPLE_RATE * 2),
        elapsedMs: Date.now() - this.startedAt,
        language,
        model: {
          backend: this.backend.name,
          requested: this.backend.modelName ?? null,
          recognition: this.recognition,
        },
        pipeline: { ...this.pipeline, sampleRate: SAMPLE_RATE, inferenceCount: this.inferenceCount },
      },
    };
    this.discard();
    // Local persistence is deliberately outside the finalization deadline.
    // The writer bounds queued work and isolates filesystem failures.
    void this.writer.write(record);
  }
}
