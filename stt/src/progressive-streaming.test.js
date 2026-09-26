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
    test('verified silence advances the release point across a rolling buffer', async () => {
      vi.mocked(detectSpeech).mockResolvedValue({ hasSpeech: false });
      const backend = { transcribe: vi.fn() };
      const handler = new SmartProgressiveStreamingHandler(backend);
      await handler.transcribeIncremental(createSilence(3));
      expect(handler.fixedEndTime).toBe(2.5);
      await handler.transcribeIncremental(createSilence(3.5), 16000 * 2.5);
      expect(handler.fixedEndTime).toBe(5.5);
      expect(backend.transcribe).not.toHaveBeenCalled();
    });

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

  describe('trimmed-buffer rebasing (rolling window)', () => {
    test('growing absolute length is not treated as cached — no freeze', async () => {
      vi.mocked(detectSpeech).mockResolvedValue({
        maxProb: 0.9, speechRatio: 0.8, hasSpeech: true,
      });

      let callCount = 0;
      const mockBackend = {
        name: 'mock',
        async transcribe() {
          callCount++;
          return { text: 'text', sentences: [] };
        },
      };

      const handler = new SmartProgressiveStreamingHandler(mockBackend);
      const audio = createTone(2); // 32000 samples

      await handler.transcribeIncremental(audio, 0);
      expect(callCount).toBe(1);

      // Same physical length AND same absolute start → cached.
      await handler.transcribeIncremental(audio, 0);
      expect(callCount).toBe(1);

      // Physical length identical but 16000 samples trimmed off the front, so
      // absolute length grew (48000 > 32000) → must transcribe, not freeze.
      handler.fixedEndTime = 1; // Only finalized audio may leave the buffer.
      await handler.transcribeIncremental(audio, 16000);
      expect(callCount).toBe(2);
    });

    test('window start rebases into the trimmed buffer coordinates', async () => {
      vi.mocked(detectSpeech).mockResolvedValue({
        maxProb: 0.9, speechRatio: 0.8, hasSpeech: true,
      });

      let received = null;
      const mockBackend = {
        name: 'mock',
        async transcribe(audio) {
          received = audio;
          return { text: 'text', sentences: [] };
        },
      };

      const handler = new SmartProgressiveStreamingHandler(mockBackend);
      handler.fixedEndTime = 1.0; // absolute 16000 samples fixed

      const audio = createTone(2); // 32000 physical samples

      // 8000 samples trimmed → windowStart = 16000 - 8000 = 8000
      await handler.transcribeIncremental(audio, 8000);
      expect(received.length).toBe(32000 - 8000);
    });

    test('window start rejects a gap when the trim passes the fixed point', async () => {
      vi.mocked(detectSpeech).mockResolvedValue({
        maxProb: 0.9, speechRatio: 0.8, hasSpeech: true,
      });

      let received = null;
      const mockBackend = {
        name: 'mock',
        async transcribe(audio) {
          received = audio;
          return { text: 'text', sentences: [] };
        },
      };

      const handler = new SmartProgressiveStreamingHandler(mockBackend);
      handler.fixedEndTime = 0.5; // absolute 8000 samples fixed

      const audio = createTone(2); // 32000 physical samples

      // This gap cannot be safely reconciled with the partial text. Report it
      // rather than silently dropping the missing half second.
      await expect(handler.transcribeIncremental(audio, 16000))
        .rejects.toMatchObject({ code: 'audio_window_exhausted' });
      expect(received).toBeNull();
    });
  });

  describe('window sliding', () => {
    test('retries the same audio after a failed newer inference instead of returning an older cache', async () => {
      vi.mocked(detectSpeech).mockResolvedValue({ hasSpeech: true });
      const backend = { transcribe: vi.fn()
        .mockResolvedValueOnce({ text: 'Start', sentences: [] })
        .mockRejectedValueOnce(new Error('temporary failure'))
        .mockResolvedValueOnce({ text: 'Start and end', sentences: [] }) };
      const handler = new SmartProgressiveStreamingHandler(backend);
      await handler.transcribeIncremental(createTone(1));
      await expect(handler.transcribeIncremental(createTone(2))).rejects.toThrow('temporary failure');
      expect(await handler.finalize(createTone(2))).toBe('Start and end');
      expect(backend.transcribe).toHaveBeenCalledTimes(3);
    });

    test('a failed second pass cannot fix sentences that were never delivered', async () => {
      vi.mocked(detectSpeech).mockResolvedValue({ hasSpeech: true });
      const backend = { transcribe: vi.fn()
        .mockResolvedValueOnce({ text: 'Start. End', sentences: [
          { text: 'Start.', start: 0, end: 1 }, { text: 'End', start: 1, end: 3 },
        ] })
        .mockRejectedValueOnce(new Error('second pass failed')) };
      const handler = new SmartProgressiveStreamingHandler(backend, { maxWindowSize: 2, sentenceBuffer: 1 });
      await expect(handler.transcribeIncremental(createTone(3))).rejects.toThrow('second pass failed');
      expect(handler.fixedSentences).toEqual([]);
      expect(handler.fixedEndTime).toBe(0);
      expect(handler.lastTranscribedLength).toBe(0);
    });

    test('reset invalidates a late result before it can change the new recording', async () => {
      vi.mocked(detectSpeech).mockResolvedValue({ hasSpeech: true });
      let complete;
      const backend = { transcribe: vi.fn(() => new Promise((resolve) => { complete = resolve; })) };
      const handler = new SmartProgressiveStreamingHandler(backend);
      const pending = handler.transcribeIncremental(createTone(1));
      await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
      handler.reset();
      complete({ text: 'Old recording', sentences: [] });
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(handler.lastResult).toBeNull();
    });

    test('reports unrecoverable audio when trimming passes the unfixed sentence boundary', async () => {
      vi.mocked(detectSpeech).mockResolvedValue({ hasSpeech: true });
      const backend = { transcribe: vi.fn().mockResolvedValue({ text: 'Only the tail', sentences: [] }) };
      const handler = new SmartProgressiveStreamingHandler(backend);
      await expect(handler.transcribeIncremental(createTone(2), 16000))
        .rejects.toMatchObject({ code: 'audio_window_exhausted' });
      expect(backend.transcribe).not.toHaveBeenCalled();
    });

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

  describe('language hints', () => {
    beforeEach(() => {
      vi.mocked(detectSpeech).mockResolvedValue({ hasSpeech: true });
    });

    test.each(['auto', 'fr', 'en'])('passes %s through both sliding-window requests', async (language) => {
      const backend = {
        name: 'mock',
        transcribe: vi.fn()
          .mockResolvedValueOnce({
            text: 'Bonjour. La suite',
            sentences: [
              { text: 'Bonjour.', start: 0, end: 1 },
              { text: 'La suite', start: 1, end: 3 },
            ],
          })
          .mockResolvedValueOnce({ text: 'La suite', sentences: [] }),
      };
      const handler = new SmartProgressiveStreamingHandler(backend, {
        maxWindowSize: 2,
        sentenceBuffer: 1,
      });

      const result = await handler.transcribeIncremental(createTone(3), 0, { language });

      expect(result.fixedText).toBe('Bonjour.');
      expect(backend.transcribe).toHaveBeenCalledTimes(2);
      for (const [audio, options] of backend.transcribe.mock.calls) {
        expect(audio).toBeInstanceOf(Float32Array);
        expect(options).toEqual({ language });
      }
      expect(backend.transcribe.mock.calls[1][0]).toHaveLength(16000 * 2);
    });

    test('forwards the selected language through finalization', async () => {
      const backend = {
        name: 'mock',
        transcribe: vi.fn().mockResolvedValue({ text: 'Bonjour', sentences: [] }),
      };
      const handler = new SmartProgressiveStreamingHandler(backend);

      expect(await handler.finalize(createTone(1), 0, { language: 'fr' })).toBe('Bonjour');
      expect(backend.transcribe.mock.calls[0][1]).toEqual({ language: 'fr' });
    });

    test('retranscribes unchanged audio when its language changes', async () => {
      const backend = {
        name: 'mock',
        transcribe: vi.fn()
          .mockResolvedValueOnce({ text: 'Hello', sentences: [] })
          .mockResolvedValueOnce({ text: 'Bonjour', sentences: [] }),
      };
      const handler = new SmartProgressiveStreamingHandler(backend);
      const audio = createTone(2);
      await handler.transcribeIncremental(audio, 0, { language: 'en' });
      // Completed text from the old language must be replaced as well.
      handler.fixedSentences = ['Earlier English sentence.'];
      handler.fixedEndTime = 1;

      const result = await handler.transcribeIncremental(audio, 0, { language: 'fr' });

      expect(result.fixedText).toBe('');
      expect(result.activeText).toBe('Bonjour');
      expect(backend.transcribe).toHaveBeenCalledTimes(2);
      expect(backend.transcribe.mock.calls[1][0]).toHaveLength(audio.length);
      expect(backend.transcribe.mock.calls[1][1]).toEqual({ language: 'fr' });
    });
  });
});
