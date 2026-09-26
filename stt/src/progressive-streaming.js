/**
 * Smart Progressive Streaming Handler
 *
 * Port of SmartProgressiveStreamingHandler from parakeet-v3-streaming
 * for the AegisCore STT server. Provides progressive transcription with:
 * - Growing window (0-15s) for initial accuracy
 * - Sentence-boundary-aware window sliding for audio > 15s
 * - Fixed sentences (completed, immutable) + active text (in-progress)
 * - Silero VAD pre-filter to reject silent audio before Whisper (prevents hallucinations)
 *
 * FR-STT-015: Progressive Streaming Transcription
 */

import { detectSpeech } from './vad.js';

/** Immutable result of a progressive transcription step. */
export class PartialTranscription {
  /**
   * @param {string} fixedText - Completed sentences that won't change
   * @param {string} activeText - Current in-progress transcription
   * @param {number} timestamp - Current position in audio (seconds)
   * @param {boolean} isFinal - Whether this is the last update
   */
  constructor(fixedText, activeText, timestamp, isFinal) {
    this.fixedText = fixedText;
    this.activeText = activeText;
    this.timestamp = timestamp;
    this.isFinal = isFinal;
  }

  toJSON() {
    return {
      fixedText: this.fixedText,
      activeText: this.activeText,
      timestamp: this.timestamp,
      isFinal: this.isFinal,
    };
  }
}

/**
 * Progressive streaming handler that manages growing/sliding windows
 * for incremental transcription with sentence-level fixation.
 *
 * Strategy:
 * 1. Emit partial transcriptions every emissionInterval (500ms)
 * 2. Use growing window up to maxWindowSize (15s) for accuracy
 * 3. Beyond maxWindowSize, slide window at sentence boundaries:
 *    - Lock completed sentences as "fixed" (immutable)
 *    - Only re-transcribe the "active" portion
 */
export class SmartProgressiveStreamingHandler {
  /**
   * @param {import('./backends/types.js').TranscriptionBackend} model
   * @param {object} [options]
   * @param {number} [options.emissionInterval=0.5] - Seconds between updates
   * @param {number} [options.maxWindowSize=15.0] - Max window before sliding
   * @param {number} [options.sentenceBuffer=2.0] - Seconds kept before slide point
   * @param {number} [options.sampleRate=16000] - Audio sample rate
   * @param {number} [options.minAudioSeconds=0.5] - Min audio before transcribing
   */
  constructor(model, options = {}) {
    this.model = model;
    this.emissionInterval = options.emissionInterval ?? 0.5;
    this.maxWindowSize = options.maxWindowSize ?? 15.0;
    this.sentenceBuffer = options.sentenceBuffer ?? 2.0;
    this.sampleRate = options.sampleRate ?? 16000;
    this.minAudioSeconds = options.minAudioSeconds ?? 0.5;

    this.reset();
  }

  /** Reset state for a new streaming session. */
  reset() {
    this.generation = (this.generation ?? 0) + 1;
    /** @type {string[]} Completed sentences that won't change */
    this.fixedSentences = [];
    /** @type {number} End time of last fixed sentence (seconds) */
    this.fixedEndTime = 0.0;
    /** @type {number} Length of audio at last transcription */
    this.lastTranscribedLength = 0;
    /** @type {PartialTranscription | null} Cached result for same-length shortcut */
    this.lastResult = null;
    /** @type {string | null} Language used by the cached and fixed text. */
    this.lastLanguage = null;
  }

  /**
   * Transcribe audio incrementally for live streaming.
   *
   * Call repeatedly with a growing audio buffer (Float32Array).
   * Returns the current transcription state with fixed + active text.
   *
   * `fixedEndTime` and `lastTranscribedLength` are tracked in absolute
   * (session-relative) coordinates. When the source buffer applies a rolling
   * window it drops samples off the front, so `audio[0]` is no longer session
   * time 0. Pass `audioStartSample` (the absolute index of `audio[0]`, e.g.
   * `AudioBuffer.trimmedSamples`) so the window offsets rebase into the trimmed
   * buffer's coordinates. It defaults to 0 (no trimming), preserving the
   * previous behavior exactly.
   *
   * @param {Float32Array} audio - Growing audio buffer at sampleRate
   * @param {number} [audioStartSample=0] - Absolute index of audio[0]
   * @param {import('./backends/types.js').TranscriptionOptions} [options]
   * @returns {Promise<PartialTranscription>}
   */
  async transcribeIncremental(audio, audioStartSample = 0, { language = 'auto', signal } = {}) {
    // A new language must reprocess even unchanged audio, including sentences
    // fixed by an earlier pass. Keep this state local to the client handler.
    if (this.lastLanguage !== null && this.lastLanguage !== language) this.reset();
    this.lastLanguage = language;
    const generation = this.generation;
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (generation !== this.generation) throw new DOMException('Recording was cleared', 'AbortError');
    };
    assertCurrent();
    const currentLength = audio.length;
    // Absolute length of audio seen this session, including trimmed-off front.
    const absoluteLength = audioStartSample + currentLength;
    const minSamples = this.sampleRate * this.minAudioSeconds;

    // Need minimum audio before transcribing
    if (absoluteLength < minSamples) {
      return new PartialTranscription(
        this.fixedSentences.join(' '),
        '',
        absoluteLength / this.sampleRate,
        false,
      );
    }

    // Return cached result if no new audio since last transcription
    if (absoluteLength === this.lastTranscribedLength && this.lastResult) {
      return this.lastResult;
    }

    // Never invent timestamps for audio that has already fallen out of the
    // rolling buffer. The server can preserve the preview as incomplete text.
    if (audioStartSample > Math.floor(this.fixedEndTime * this.sampleRate)) {
      const error = new Error('Transcription could not keep up with this recording. The saved text is incomplete.');
      error.code = 'audio_window_exhausted';
      throw error;
    }

    // Publish all state together only after both inference passes succeed.
    // A failed pass must not make older text look current on the next retry.
    const fixedSentences = [...this.fixedSentences];
    let fixedEndTime = this.fixedEndTime;

    // Extract window from last fixed sentence endpoint to end of audio.
    // fixedEndTime is absolute; rebase it into the (possibly trimmed) buffer.
    const windowStartSamples = Math.max(
      0,
      Math.floor(this.fixedEndTime * this.sampleRate) - audioStartSample,
    );
    const audioWindow = audio.slice(windowStartSamples);
    const windowDuration = audioWindow.length / this.sampleRate;

    // VAD pre-filter: skip transcription if no speech detected.
    // Prevents Whisper hallucinations on silent/near-silent audio.
    const vad = await detectSpeech(audioWindow);
    assertCurrent();
    if (!vad.hasSpeech) {
      // Release a verified silent region, but retain half a second of overlap:
      // VAD examines whole frames and can leave an unfinished frame at the end.
      // Speech starting there must still be available on the next update.
      this.fixedEndTime = Math.max(this.fixedEndTime, absoluteLength / this.sampleRate - 0.5);
      this.lastTranscribedLength = absoluteLength;
      this.lastResult = new PartialTranscription(
        this.fixedSentences.join(' '),
        '',
        absoluteLength / this.sampleRate,
        false,
      );
      return this.lastResult;
    }

    // Transcribe current window
    const options = signal ? { language, signal } : { language };
    let result = await this.model.transcribe(audioWindow, options);
    assertCurrent();

    // If window exceeds maxWindowSize, fix completed sentences
    if (
      windowDuration >= this.maxWindowSize &&
      result.sentences &&
      result.sentences.length > 1
    ) {
      const cutoffTime = windowDuration - this.sentenceBuffer;

      const newFixedSentences = [];
      let newFixedEndTime = this.fixedEndTime;

      for (const sentence of result.sentences) {
        if (sentence.end < cutoffTime) {
          newFixedSentences.push(sentence.text.trim());
          newFixedEndTime = this.fixedEndTime + sentence.end;
        } else {
          break;
        }
      }

      if (newFixedSentences.length > 0) {
        fixedSentences.push(...newFixedSentences);
        fixedEndTime = newFixedEndTime;

        // Re-transcribe from new fixed point for fresh active text
        const newWindowStartSamples = Math.max(
          0,
          Math.floor(fixedEndTime * this.sampleRate) - audioStartSample,
        );
        const newAudioWindow = audio.slice(newWindowStartSamples);
        result = await this.model.transcribe(newAudioWindow, options);
        assertCurrent();
      }
    }

    const fixedText = fixedSentences.join(' ');
    const activeText = result.text ? result.text.trim() : '';
    const timestamp = absoluteLength / this.sampleRate;

    this.fixedSentences = fixedSentences;
    this.fixedEndTime = fixedEndTime;
    this.lastTranscribedLength = absoluteLength;
    this.lastResult = new PartialTranscription(fixedText, activeText, timestamp, false);
    return this.lastResult;
  }

  /**
   * Get final transcription by combining fixed + active.
   *
   * @param {Float32Array} audio - Complete audio buffer
   * @param {number} [audioStartSample=0] - Absolute index of audio[0]
   * @param {import('./backends/types.js').TranscriptionOptions} [options]
   * @returns {Promise<string>} Final complete transcription text
   */
  async finalize(audio, audioStartSample = 0, options = {}) {
    const result = await this.transcribeIncremental(audio, audioStartSample, options);

    const parts = [];
    if (result.fixedText) parts.push(result.fixedText);
    if (result.activeText) parts.push(result.activeText);

    return parts.join(' ');
  }
}
