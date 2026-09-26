import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DEFAULT_VOCABULARY } from '../vocabulary.cjs';
import { whisperBackend } from './whisper-backend.js';
import { SmartProgressiveStreamingHandler } from '../progressive-streaming.js';

vi.mock('../vad.js', () => ({ detectSpeech: vi.fn().mockResolvedValue({ hasSpeech: true }) }));

beforeEach(() => {
  vi.stubEnv('STT_VOCABULARY', undefined);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => Response.json({ text: 'Bonjour Kookr.' })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

test.each(['fr', 'en', 'auto'])('preserves unhinted %s recognition and word timestamps by default', async (language) => {
  await whisperBackend.transcribe(new Float32Array(16000), { language });
  const form = fetch.mock.calls[0][1].body;
  expect(form.has('prompt')).toBe(false);
  expect(form.get('language')).toBe(language === 'auto' ? null : language);
  expect(form.get('response_format')).toBe('verbose_json');
  expect(form.get('timestamp_granularities[]')).toBe('word');
  expect(form.get('model')).toBe(whisperBackend.modelName);
  const wav = Buffer.from(await form.get('file').arrayBuffer());
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.readUInt32LE(24)).toBe(16000);
});

test.each(['', DEFAULT_VOCABULARY, 'Kookr, générique.', '😀'.repeat(2000)])('preserves explicit overrides, including empty and Unicode limits (%#)', async (vocabulary) => {
  vi.stubEnv('STT_VOCABULARY', vocabulary);
  await whisperBackend.transcribe(new Float32Array(16000));
  expect(fetch.mock.calls[0][1].body.get('prompt')).toBe(vocabulary);
});

test.each(['x'.repeat(2001), '😀'.repeat(2001)])('rejects overlong hints before sending audio (%#)', async (vocabulary) => {
  vi.stubEnv('STT_VOCABULARY', vocabulary);
  await expect(whisperBackend.transcribe(new Float32Array(16000))).rejects.toThrow('at most 2000 characters');
  expect(fetch).not.toHaveBeenCalled();
});

test('retains the glossary during window sliding and finalization without rewriting text', async () => {
  vi.stubEnv('STT_VOCABULARY', DEFAULT_VOCABULARY);
  const first = { text: 'Kookr suit Codex. Claude continue.', words: [
    { word: 'Kookr', start: 0, end: 1 }, { word: 'suit', start: 1, end: 2 },
    { word: 'Codex.', start: 2, end: 4 }, { word: 'Claude', start: 17, end: 18 },
    { word: 'continue.', start: 18, end: 19 },
  ] };
  fetch.mockResolvedValueOnce(Response.json(first))
    .mockResolvedValueOnce(Response.json({ text: 'Claude continue.' }))
    .mockResolvedValueOnce(Response.json({ text: 'Claude continue. Fin.' }));
  const handler = new SmartProgressiveStreamingHandler(whisperBackend);
  const partial = await handler.transcribeIncremental(new Float32Array(16000 * 20), 0, { language: 'fr' });
  expect(partial.fixedText).toBe('Kookr suit Codex.');
  expect(partial.activeText).toBe('Claude continue.');
  expect(handler.fixedEndTime).toBe(4);
  expect(await handler.finalize(new Float32Array(16000 * 21), 0, { language: 'fr' }))
    .toBe('Kookr suit Codex. Claude continue. Fin.');
  expect(fetch).toHaveBeenCalledTimes(3);
  for (const [, { body }] of fetch.mock.calls) {
    expect(body.get('prompt')).toBe(DEFAULT_VOCABULARY);
    expect(body.get('language')).toBe('fr');
  }
  const secondWav = await fetch.mock.calls[1][1].body.get('file').arrayBuffer();
  expect(secondWav.byteLength).toBe(44 + 16000 * 16 * 2);
});

test('suppresses likely silence even when a hinted response contains glossary terms', async () => {
  vi.stubEnv('STT_VOCABULARY', DEFAULT_VOCABULARY);
  fetch.mockResolvedValueOnce(Response.json({
    text: DEFAULT_VOCABULARY, segments: [{ no_speech_prob: 0.9 }],
    words: [{ word: 'Kookr.', start: 0, end: 1 }],
  }));
  expect(await whisperBackend.transcribe(new Float32Array(16000)))
    .toEqual({ text: '', sentences: [], noSpeechProb: 0.9 });
  expect(fetch.mock.calls[0][1].body.get('prompt')).toBe(DEFAULT_VOCABULARY);
});
