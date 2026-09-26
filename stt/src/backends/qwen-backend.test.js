import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { sentencesFromQwenAlignment } from './qwen-sentences.js';
import { SmartProgressiveStreamingHandler } from '../progressive-streaming.js';

vi.mock('../vad.js', () => ({ detectSpeech: vi.fn().mockResolvedValue({ hasSpeech: true }) }));

const fixture = JSON.parse(readFileSync(new URL('./fixtures/qwen-aligned-french.json', import.meta.url)));
const [first, second] = fixture.clips;
const wordsOf = (clip, offset = 0) => clip.response.time_stamps.items.map((word) => ({
  word: word.text, start: word.start_time + offset, end: word.end_time + offset,
}));

describe('Qwen sentence reconstruction', () => {
  test('restores real punctuation and apostrophes without rewriting the transcript', () => {
    expect(sentencesFromQwenAlignment(second.response.text, wordsOf(second), second.duration)).toEqual([
      { text: "À l'autre bout du spectre, se transforme en un individu méconnaissable obsistant.", start: 0.88, end: 4.96 },
      { text: "Qu'il, elle, doit changer tout ce que le groupe a créé jusqu'alors et faire les choses à sa manière.", start: 5.12, end: 10.56 },
    ]);
  });

  test('accepts split apostrophes, hyphens and zero-duration words while preserving spelling', () => {
    const text = 'L’évolution est-elle utile ? Oui !';
    const words = ["L'évolution", 'est', 'elle', 'utile', 'Oui'].map((word, index) => ({
      word, start: index, end: index === 1 ? index : index + 0.5,
    }));
    expect(sentencesFromQwenAlignment(text, words, 5)).toEqual([
      { text: 'L’évolution est-elle utile ?', start: 0, end: 3.5 },
      { text: 'Oui !', start: 4, end: 4.5 },
    ]);
  });

  test.each([
    ['missing word', (words) => words.slice(1)],
    ['different word', (words) => [{ ...words[0], word: 'Autre' }, ...words.slice(1)]],
    ['negative start', (words) => [{ ...words[0], start: -1 }, ...words.slice(1)]],
    ['backwards duration', (words) => [{ ...words[0], end: 0 }, ...words.slice(1)]],
    ['overlapping time', (words) => [words[0], { ...words[1], start: 0 }, ...words.slice(2)]],
    ['nonfinite time', (words) => [{ ...words[0], end: NaN }, ...words.slice(1)]],
    ['past audio end', (words) => [...words.slice(0, -1), { ...words.at(-1), end: 100 }]],
  ])('keeps text unfixed for %s', (_name, mutate) => {
    expect(sentencesFromQwenAlignment(first.response.text, mutate(wordsOf(first)), first.duration)).toEqual([]);
  });

  test('does not guess a sentence timestamp inside an aligned token', () => {
    expect(sentencesFromQwenAlignment('Bonjour. Salut.', [{ word: 'BonjourSalut', start: 0, end: 2 }], 2)).toEqual([]);
  });

  test('retains decimal numbers, abbreviations inside a word, and closing quotes', () => {
    const text = '« Version 1.7B, merci ! » Puis test.';
    const words = ['Version', '1.7B', 'merci', 'Puis', 'test'].map((word, index) => ({ word, start: index, end: index + 0.5 }));
    expect(sentencesFromQwenAlignment(text, words, 5).map((sentence) => sentence.text)).toEqual([
      '« Version 1.7B, merci ! »', 'Puis test.',
    ]);
  });
});

describe('Qwen backend', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('QWEN_ASR_URL', 'http://qwen.test:8010');
    vi.stubEnv('QWEN_ASR_MODEL', 'Qwen/Qwen3-ASR-0.6B');
    vi.stubEnv('QWEN_ASR_TIMEOUT_MS', '20');
  });

  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  test('sends request-scoped language hints and the selected model as 16kHz WAV', async () => {
    vi.stubEnv('QWEN_ASR_MODEL', 'Qwen/Qwen3-ASR-1.7B');
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ text: first.response.text, words: wordsOf(first) }));
    vi.stubGlobal('fetch', fetchMock);
    const { qwenBackend } = await import('./qwen-backend.js');
    await Promise.all(['fr', 'en', 'auto'].map((language) => qwenBackend.transcribe(new Float32Array(16000 * 8), { language })));
    expect(fetchMock.mock.calls.map(([, options]) => options.body.get('language'))).toEqual(['fr', 'en', null]);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toBe('http://qwen.test:8010/v1/audio/transcriptions');
      expect(options.body.get('model')).toBe('Qwen/Qwen3-ASR-1.7B');
      expect(options.body.get('response_format')).toBe('verbose_json');
      expect(options.body.get('timestamp_granularities[]')).toBe('word');
      const wav = Buffer.from(await options.body.get('file').arrayBuffer());
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
      expect(wav.readUInt32LE(24)).toBe(16000);
    }
  });

  test('reports upstream HTTP failures and malformed successful responses', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ error: 'no transcript' })));
    const { qwenBackend } = await import('./qwen-backend.js');
    await expect(qwenBackend.transcribe(new Float32Array(16000))).rejects.toThrow('Qwen ASR API error: 503');
    await expect(qwenBackend.transcribe(new Float32Array(16000))).rejects.toThrow('missing transcript');
  });

  test('aborts a stalled upstream request', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })));
    const { qwenBackend } = await import('./qwen-backend.js');
    await expect(qwenBackend.transcribe(new Float32Array(16000))).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('cancels an upstream request when its recording is cleared', async () => {
    vi.stubEnv('QWEN_ASR_TIMEOUT_MS', '60000');
    vi.stubGlobal('fetch', vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })));
    const { qwenBackend } = await import('./qwen-backend.js');
    const controller = new AbortController();
    const pending = qwenBackend.transcribe(new Float32Array(16000), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('slides a window over fifteen seconds and finalizes without dropping or duplicating saved text', async () => {
    // Concatenate actual model responses, offsetting only the second clip's times.
    // This verifies streaming mechanics, not the model's accuracy on stitched audio.
    const fullText = `${first.response.text} ${second.response.text}`;
    const secondFirstSentence = second.response.text.slice(0, second.response.text.indexOf('.') + 1);
    const activeText = second.response.text.slice(second.response.text.indexOf('.') + 2);
    const fixedEnd = first.duration + 4.96;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ text: fullText, words: [...wordsOf(first), ...wordsOf(second, first.duration)] }))
      .mockResolvedValueOnce(Response.json({ text: activeText, words: wordsOf(second).slice(12).map((word) => ({ ...word, start: word.start - 4.96, end: word.end - 4.96 })) }));
    vi.stubGlobal('fetch', fetchMock);
    const { qwenBackend } = await import('./qwen-backend.js');
    const handler = new SmartProgressiveStreamingHandler(qwenBackend);
    const audio = new Float32Array(Math.round((first.duration + second.duration) * 16000));
    const result = await handler.transcribeIncremental(audio, 0, { language: 'fr' });
    expect(result.fixedText).toBe(`${first.response.text} ${secondFirstSentence}`);
    expect(result.activeText).toBe(activeText);
    expect(handler.fixedEndTime).toBeCloseTo(fixedEnd);
    const secondWav = await fetchMock.mock.calls[1][1].body.get('file').arrayBuffer();
    expect(secondWav.byteLength).toBe(44 + (audio.length - Math.floor(fixedEnd * 16000)) * 2);
    expect(await handler.finalize(audio, 0, { language: 'fr' })).toBe(fullText);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
