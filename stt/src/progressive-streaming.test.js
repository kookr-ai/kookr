/**
 * Tests for SmartProgressiveStreamingHandler — VAD guard and streaming behavior.
 *
 * The handler now uses Silero VAD as a pre-filter before Whisper transcription.
 * Silent audio is blocked, preventing hallucinations like "Thank you for watching!".
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock the VAD module so tests don't need the ONNX model
vi.mock('./vad.js', () => ({
  detectSpeech: vi.fn(),
}));

import { SmartProgressiveStreamingHandler } from './progressive-streaming.js';
import { detectSpeech } from './vad.js';

// -- Helpers ------------------------------------------------------------------

/** Create Float32Array of silence (all zeros). */
function createSilence(durationSeconds, sampleRate = 16000) {
  return new Float32Array(durationSeconds * sampleRate);
}

/** Create Float32Array with a sine wave (simulates speech-like signal). */
function createTone(durationSeconds, frequencyHz = 440, amplitude = 0.5, sampleRate = 16000) {
  const samples = new Float32Array(durationSeconds * sampleRate);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = amplitude * Math.sin(2 * Math.PI * frequencyHz * i / sampleRate);
  }
  return samples;
}

/** Compute RMS energy of a Float32Array. */
function rms(audio) {
  let sum = 0;
  for (let i = 0; i < audio.length; i++) {
    sum += audio[i] * audio[i];
  }
  return Math.sqrt(sum / audio.length);
}

// -- Tests --------------------------------------------------------------------

describe('SmartProgressiveStreamingHandler', () => {
  beforeEach(() => {
    vi.mocked(detectSpeech).mockReset();
  });

  describe('VAD guard — silent audio blocked', () => {
    test('silent audio is rejected by VAD — backend never called', async () => {
      // VAD detects no speech
      vi.mocked(detectSpeech).mockResolvedValue({
        maxProb: 0.01, speechRatio: 0, hasSpeech: false,
      });

      const transcribeCalls = [];
      const mockBackend = {
        name: 'mock',
        async transcribe(audio) {
          transcribeCalls.push({ rms: rms(audio) });
          return { text: 'Thank you for watching!', sentences: [] };
        },
      };

      const handler = new SmartProgressiveStreamingHandler(mockBackend, {
        minAudioSeconds: 0.5,
      });

      const silence = createSilence(3);
      const result = await handler.transcribeIncremental(silence);

      // Backend never called — hallucination prevented
      expect(transcribeCalls.length).toBe(0);
      expect(result.activeText).toBe('');
    });

    test('near-silent audio (mic noise floor) is rejected by VAD', async () => {
      vi.mocked(detectSpeech).mockResolvedValue({
        maxProb: 0.07, speechRatio: 0, hasSpeech: false,
      });

      const transcribeCalls = [];
      const mockBackend = {
        name: 'mock',
        async transcribe() {
          transcribeCalls.push(true);
          return { text: 'Subscribe to my channel!', sentences: [] };
        },
      };

      const handler = new SmartProgressiveStreamingHandler(mockBackend);
      const noise = new Float32Array(16000 * 2);
      for (let i = 0; i < noise.length; i++) {
        noise[i] = (Math.random() - 0.5) * 0.002;
      }

      const result = await handler.transcribeIncremental(noise);

      expect(transcribeCalls.length).toBe(0);
      expect(result.activeText).toBe('');
    });
  });

  describe('VAD guard — speech audio allowed', () => {
    test('speech audio passes VAD and reaches backend', async () => {
      vi.mocked(detectSpeech).mockResolvedValue({
        maxProb: 0.95, speechRatio: 0.8, hasSpeech: true,
      });

      const mockBackend = {
        name: 'mock',
        async transcribe() {
          return { text: 'Hello world', sentences: [] };
        },
      };

      const handler = new SmartProgressiveStreamingHandler(mockBackend);
      const speech = createTone(2, 300, 0.3);
      const result = await handler.transcribeIncremental(speech);

      expect(result.activeText).toBe('Hello world');
      expect(detectSpeech).toHaveBeenCalledOnce();
    });

    test('audio shorter than minAudioSeconds skips both VAD and transcription', async () => {
      const transcribeCalls = [];
      const mockBackend = {
        name: 'mock',
        async transcribe() {
          transcribeCalls.push(true);
          return { text: '', sentences: [] };
        },
      };

      const handler = new SmartProgressiveStreamingHandler(mockBackend, {
        minAudioSeconds: 0.5,
      });

      const shortAudio = createTone(0.3);
      await handler.transcribeIncremental(shortAudio);

      expect(transcribeCalls.length).toBe(0);
      // VAD not called either — short-circuit before VAD
      expect(detectSpeech).not.toHaveBeenCalled();
    });

    test('cached result returned for same audio length', async () => {
      vi.mocked(detectSpeech).mockResolvedValue({
        maxProb: 0.9, speechRatio: 0.7, hasSpeech: true,
      });

      let callCount = 0;
      const mockBackend = {
        name: 'mock',
        async transcribe() {
          callCount++;
          return { text: 'Cached result', sentences: [] };
        },
      };

      const handler = new SmartProgressiveStreamingHandler(mockBackend);
      const audio = createTone(2);

      await handler.transcribeIncremental(audio);
      expect(callCount).toBe(1);

      // Same length → cached (no VAD or transcription call)
      await handler.transcribeIncremental(audio);
      expect(callCount).toBe(1);
    });
  });

  describe('energy degradation from dropped frames', () => {
    test('50% dropped frames halve the energy — detectable by VAD', () => {
      const speech = createTone(5, 300, 0.3);
      const originalRms = rms(speech);

      // Zero out every other chunk (simulates ScriptProcessorNode drops)
      const corrupted = new Float32Array(speech);
      const chunkSize = 4096;
      const totalChunks = Math.floor(corrupted.length / chunkSize);
      for (let c = 0; c < totalChunks; c++) {
        if (c % 2 === 0) {
          corrupted.fill(0, c * chunkSize, (c + 1) * chunkSize);
        }
      }

      const energyRatio = rms(corrupted) / originalRms;
      expect(energyRatio).toBeLessThan(0.75);
    });
  });

  describe('window sliding', () => {
    test('fixes sentences when window exceeds maxWindowSize', async () => {
      vi.mocked(detectSpeech).mockResolvedValue({
        maxProb: 0.9, speechRatio: 0.8, hasSpeech: true,
      });

      const mockBackend = {
        name: 'mock',
        async transcribe(audio) {
          const duration = audio.length / 16000;
          if (duration > 10) {
            return {
              text: 'First sentence. Second sentence. Third part',
              sentences: [
                { text: 'First sentence.', start: 0, end: 5 },
                { text: 'Second sentence.', start: 5, end: 10 },
                { text: 'Third part', start: 10, end: duration },
              ],
            };
          }
          return { text: 'Remaining text', sentences: [] };
        },
      };

      const handler = new SmartProgressiveStreamingHandler(mockBackend, {
        maxWindowSize: 12,
        sentenceBuffer: 2,
      });

      const longAudio = createTone(16);
      const result = await handler.transcribeIncremental(longAudio);

      expect(result.fixedText).toContain('First sentence.');
    });
  });
});
