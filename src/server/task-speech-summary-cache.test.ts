import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { TaskSpeechSummaryCache } from './task-speech-summary-cache.js';
import type { LlmClient } from '../core/llm-client.js';

const ttsResponse = (text: string) => ({
  audioBase64: Buffer.from(`AUDIO:${text}`).toString('base64'),
  durationMs: 1000,
  generationTimeMs: 50,
});

function mockClient(summary: string): LlmClient {
  return {
    provider: 'test',
    model: 'test-model',
    complete: vi.fn().mockResolvedValue(JSON.stringify({ summary })),
  };
}

describe('TaskSpeechSummaryCache', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('a per-call voice is part of the cache key and the synthesis request', async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = await new Request(input, init).json() as { text: string };
      return new Response(JSON.stringify(ttsResponse(body.text)), { status: 200 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    const cache = new TaskSpeechSummaryCache({
      llmClient: mockClient('Auth task completed.'), ttsUrl: 'http://tts.local', voice: 'matilda',
    });
    const input = { taskName: 'Auth task', taskStatus: 'completed' as const, completionDigest: { bullets: ['x'], filesChanged: [] } };
    const voiceOfCall = (n: number) =>
      (JSON.parse(String(fetchSpy.mock.calls[n][1]?.body)) as { voice: string }).voice;

    expect((await cache.get(input)).cached).toBe(false);
    expect(voiceOfCall(0)).toBe('matilda');
    expect((await cache.get(input, undefined, 'af_sky')).cached).toBe(false);
    expect(voiceOfCall(1)).toBe('af_sky');
    expect((await cache.get(input, undefined, 'af_sky')).cached).toBe(true);
    expect((await cache.get(input)).cached).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test('requests in flight are shared per voice, never across voices', async () => {
    // Synthesis stays pending until released, so all three requests overlap.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const voices: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = await new Request(input, init).json() as { text: string; voice: string };
      voices.push(body.voice);
      await gate;
      return new Response(JSON.stringify({ ...ttsResponse(body.text), audioBase64: `AUDIO:${body.voice}` }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const cache = new TaskSpeechSummaryCache({
      llmClient: mockClient('Auth task completed.'), ttsUrl: 'http://tts.local', voice: 'matilda',
    });
    const input = { taskName: 'Auth task', taskStatus: 'completed' as const, completionDigest: { bullets: ['x'], filesChanged: [] } };

    const heart = cache.get(input, undefined, 'af_heart');
    const sky = cache.get(input, undefined, 'af_sky');
    const heartAgain = cache.get(input, undefined, 'af_heart');
    await vi.waitFor(() => expect(voices).toHaveLength(2));
    release();

    expect((await heart).audioBase64).toBe('AUDIO:af_heart');
    expect((await sky).audioBase64).toBe('AUDIO:af_sky');
    expect((await heartAgain).audioBase64).toBe('AUDIO:af_heart');
    // One synthesis per voice: the second Heart request joined the first, Sky did not.
    expect(voices.sort()).toEqual(['af_heart', 'af_sky']);
  });

  test('runs LLM + TTS once and then cache-hits by normalized speech input', async () => {
    const client = mockClient('Auth task completed with tests passing.');
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      const body = await req.json() as { text: string };
      return new Response(JSON.stringify(ttsResponse(body.text)), { status: 200 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const cache = new TaskSpeechSummaryCache({
      llmClient: client,
      ttsUrl: 'http://tts.local',
      voice: 'matilda',
    });
    const input = {
      taskName: 'Auth task',
      taskStatus: 'completed' as const,
      completionDigest: { bullets: ['Tests passed'], filesChanged: [] },
    };

    const first = await cache.get(input);
    const second = await cache.get(input);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(client.complete).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith('http://tts.local/synthesize', expect.objectContaining({
      body: expect.stringContaining('Auth task completed with tests passing.'),
    }));
    expect(second.audioBase64).toBe(first.audioBase64);
  });

  test('aborting one waiter does not abort shared synthesis for later callers', async () => {
    const client = mockClient('Shared task summary.');
    let resolveFetch: ((value: Response) => void) | null = null;
    const fetchSpy = vi.fn(async () => new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const cache = new TaskSpeechSummaryCache({
      llmClient: client,
      ttsUrl: 'http://tts.local',
      voice: 'matilda',
    });
    const input = { taskName: 'Shared task', taskStatus: 'inProgress' as const };
    const controller = new AbortController();
    const first = cache.get(input, controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(first).rejects.toThrow(/aborted/);

    const second = cache.get(input);
    resolveFetch?.(new Response(JSON.stringify(ttsResponse('Shared task summary.')), { status: 200 }));
    const result = await second;

    expect(result.text).toBe('Shared task summary.');
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  test('synthesises and stores the speakable text, and carries rawText through cache hits', async () => {
    const raw = 'Fixed `src/core/foo-bar.ts` and opened #3608.';
    const client = mockClient(raw);
    const spoken: string[] = [];
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = await new Request(input, init).json() as { text: string };
      spoken.push(body.text);
      return new Response(JSON.stringify(ttsResponse(body.text)), { status: 200 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const cache = new TaskSpeechSummaryCache({ llmClient: client, ttsUrl: 'http://tts.local', voice: 'matilda' });
    const input = { taskName: 'Auth task', taskStatus: 'completed' as const };

    const first = await cache.get(input);
    const second = await cache.get(input);

    expect(spoken).toEqual(['Fixed foo-bar.ts and opened number 3608.']);
    expect(first.text).toBe('Fixed foo-bar.ts and opened number 3608.');
    expect(first.rawText).toBe(raw);
    expect(second.cached).toBe(true);
    expect(second.text).toBe(first.text);
    expect(second.rawText).toBe(raw);
  });

  test('omits rawText when the speakable step changed nothing', async () => {
    const client = mockClient('Auth task completed.');
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = await new Request(input, init).json() as { text: string };
      return new Response(JSON.stringify(ttsResponse(body.text)), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const cache = new TaskSpeechSummaryCache({ llmClient: client, ttsUrl: 'http://tts.local', voice: 'matilda' });
    const result = await cache.get({ taskName: 'Auth task', taskStatus: 'completed' as const });

    expect(result.text).toBe('Auth task completed.');
    expect('rawText' in result).toBe(false);
  });
});
