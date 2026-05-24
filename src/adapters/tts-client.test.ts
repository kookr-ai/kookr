import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { synthesize, TTSClientError } from './tts-client.js';

describe('synthesize', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  test('happy path returns parsed result', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ audioBase64: 'aGVsbG8=', durationMs: 500, generationTimeMs: 30 }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const result = await synthesize({ ttsUrl: 'http://tts', text: 'hello', voice: 'matilda' });
    expect(result.audioBase64).toBe('aGVsbG8=');
    expect(result.durationMs).toBe(500);
  });

  test('non-200 throws TTSClientError(http)', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof globalThis.fetch;
    await expect(synthesize({ ttsUrl: 'http://tts', text: 'x', voice: 'v' }))
      .rejects.toBeInstanceOf(TTSClientError);
  });

  test('missing fields throws TTSClientError(bad-response)', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof globalThis.fetch;
    await expect(synthesize({ ttsUrl: 'http://tts', text: 'x', voice: 'v' }))
      .rejects.toMatchObject({ kind: 'bad-response' });
  });

  test('AbortSignal aborts the request', async () => {
    const ac = new AbortController();
    globalThis.fetch = vi.fn(async (input, init) => {
      // Wait for the signal so the test deterministically observes abortion.
      await new Promise((_, reject) => {
        (init as RequestInit).signal!.addEventListener('abort', () => reject(new Error('aborted')));
      });
      return new Response('', { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const pending = synthesize({ ttsUrl: 'http://tts', text: 'x', voice: 'v', signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(TTSClientError);
  });

  test('trims trailing slash from ttsUrl', async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ audioBase64: 'x', durationMs: 1, generationTimeMs: 1 }), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await synthesize({ ttsUrl: 'http://tts/', text: 'x', voice: 'v' });
    expect(fetchSpy).toHaveBeenCalledWith('http://tts/synthesize', expect.anything());
  });
});
