import { groupWordsIntoSentences } from '../sentence-grouper.js';

const WHISPER_URL = process.env.WHISPER_URL || 'http://kookr-stt-whisper:8010';
const WHISPER_TIMEOUT_MS = parseInt(process.env.WHISPER_TIMEOUT_MS || '5000', 10);
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'large-v3';
const SAMPLE_RATE = 16000;

/**
 * Convert Float32Array PCM audio to WAV buffer for HTTP upload.
 *
 * @param {Float32Array} audio
 * @returns {Buffer}
 */
export function float32ToWav(audio) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = SAMPLE_RATE * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = audio.length * (bitsPerSample / 8);
  const headerSize = 44;
  const buffer = Buffer.alloc(headerSize + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < audio.length; i++) {
    const sample = Math.max(-1, Math.min(1, audio[i]));
    buffer.writeInt16LE(Math.round(sample * 32767), headerSize + i * 2);
  }

  return buffer;
}

/**
 * Normalize Whisper words to the internal timestamp shape.
 *
 * @param {Array<{word: string, start: number, end: number}> | undefined} whisperWords
 * @returns {Array<{text: string, start_time: number, end_time: number}>}
 */
export function normalizeWhisperWords(whisperWords) {
  if (!whisperWords) return [];

  return whisperWords.map((word) => ({
    text: (word.word || '').trim(),
    start_time: word.start ?? 0,
    end_time: word.end ?? word.start ?? 0,
  }));
}

/**
 * @typedef {import('./types.js').TranscriptionBackend} TranscriptionBackend
 */

/** @type {TranscriptionBackend} */
export const whisperBackend = {
  name: 'whisper',

  async transcribe(audioWindow) {
    const wavBuffer = float32ToWav(audioWindow);

    const formData = new FormData();
    formData.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
    formData.append('model', WHISPER_MODEL);
    formData.append('response_format', 'verbose_json');
    formData.append('timestamp_granularities[]', 'word');
    formData.append('language', 'en');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);

    try {
      const response = await fetch(`${WHISPER_URL}/v1/audio/transcriptions`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Whisper API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      // Check Whisper's own confidence that speech is present.
      // Segments with high no_speech_prob are likely hallucinations.
      const noSpeechProb = data.segments?.[0]?.no_speech_prob ?? 0;
      if (noSpeechProb > 0.6) {
        return { text: '', sentences: [], noSpeechProb };
      }

      const words = normalizeWhisperWords(data.words);
      const sentences = groupWordsIntoSentences(words);

      return { text: data.text?.trim() || '', sentences, noSpeechProb };
    } finally {
      clearTimeout(timeout);
    }
  },
};
