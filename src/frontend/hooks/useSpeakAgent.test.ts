import { describe, expect, test } from 'vitest';
import {
  formatSpeakFindingTimingLine,
  formatSpeakFindingTimingTitle,
} from '../speech-presentation.js';

describe('speak agent timing formatting', () => {
  test('shows generation, synthesis, decode, and audio timing', () => {
    expect(formatSpeakFindingTimingLine({
      llmMs: 1234,
      ttsMs: 480,
      decodeMs: 32,
      audioMs: 4560,
      cached: false,
    })).toBe('LLM 1.2s · TTS 480ms · decode 32ms · audio 4.6s');
  });

  test('calls out cache hits and detailed playback timing in the title', () => {
    const title = formatSpeakFindingTimingTitle({
      requestMs: 95,
      llmMs: 0,
      ttsMs: 0,
      decodeMs: 14,
      timeToStartMs: 130,
      audioMs: 2400,
      playedMs: 2388,
      cached: true,
    });

    expect(title).toContain('Request: 95ms');
    expect(title).toContain('Summary/TTS: cache hit');
    expect(title).toContain('Time to playback: 130ms');
    expect(title).toContain('Observed playback: 2.4s');
  });
});
