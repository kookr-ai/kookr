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
   * @param {object} model - Transcription model with .transcribe(audio) method
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
    /** @type {string[]} Completed sentences that won't change */
    this.fixedSentences = [];
    /** @type {number} End time of last fixed sentence (seconds) */
    this.fixedEndTime = 0.0;
    /** @type {number} Length of audio at last transcription */
    this.lastTranscribedLength = 0;
    /** @type {PartialTranscription | null} Cached result for same-length shortcut */
    this.lastResult = null;
  }

  /**
   * Transcribe audio incrementally for live streaming.
   *
   * Call repeatedly with a growing audio buffer (Float32Array).
   * Returns the current transcription state with fixed + active text.
   *
   * @param {Float32Array} audio - Growing audio buffer at sampleRate
   * @returns {Promise<PartialTranscription>}
   */
  async transcribeIncremental(audio) {
    const currentLength = audio.length;
    const minSamples = this.sampleRate * this.minAudioSeconds;

    // Need minimum audio before transcribing
    if (currentLength < minSamples) {
      return new PartialTranscription(
        this.fixedSentences.join(' '),
        '',
        currentLength / this.sampleRate,
        false,
      );
    }

    // Return cached result if no new audio since last transcription
    if (currentLength === this.lastTranscribedLength && this.lastResult) {
      return this.lastResult;
    }

    this.lastTranscribedLength = currentLength;

    // Extract window from last fixed sentence endpoint to end of audio
    const windowStartSamples = Math.floor(this.fixedEndTime * this.sampleRate);
    const audioWindow = audio.slice(windowStartSamples);
    const windowDuration = audioWindow.length / this.sampleRate;

    // VAD pre-filter: skip transcription if no speech detected.
    // Prevents Whisper hallucinations on silent/near-silent audio.
    const vad = await detectSpeech(audioWindow);
    if (!vad.hasSpeech) {
      this.lastResult = new PartialTranscription(
        this.fixedSentences.join(' '),
        '',
        currentLength / this.sampleRate,
        false,
      );
      return this.lastResult;
    }

    // Transcribe current window
    let result = await this.model.transcribe(audioWindow);

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
        this.fixedSentences.push(...newFixedSentences);
        this.fixedEndTime = newFixedEndTime;

        // Re-transcribe from new fixed point for fresh active text
        const newWindowStartSamples = Math.floor(
          this.fixedEndTime * this.sampleRate,
        );
        const newAudioWindow = audio.slice(newWindowStartSamples);
        result = await this.model.transcribe(newAudioWindow);
      }
    }

    const fixedText = this.fixedSentences.join(' ');
    const activeText = result.text ? result.text.trim() : '';
    const timestamp = audio.length / this.sampleRate;

    this.lastResult = new PartialTranscription(fixedText, activeText, timestamp, false);
    return this.lastResult;
  }

  /**
   * Get final transcription by combining fixed + active.
   *
   * @param {Float32Array} audio - Complete audio buffer
   * @returns {Promise<string>} Final complete transcription text
   */
  async finalize(audio) {
    const result = await this.transcribeIncremental(audio);

    const parts = [];
    if (result.fixedText) parts.push(result.fixedText);
    if (result.activeText) parts.push(result.activeText);

    return parts.join(' ');
  }
}
