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
});
