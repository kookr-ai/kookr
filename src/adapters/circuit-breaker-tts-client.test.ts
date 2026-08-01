import { afterEach, describe, expect, test, vi } from 'vitest';
import { CircuitBreaker } from '../core/circuit-breaker.js';
import { synthesizeWithCircuitBreaker } from './circuit-breaker-tts-client.js';
import { TTSClientError } from './tts-client.js';

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

const originalFetch = globalThis.fetch;

function mockOkFetch(audioBase64 = 'aGVsbG8='): void {
  globalThis.fetch = vi.fn(async () =>
    new Response(
      JSON.stringify({ audioBase64, durationMs: 500, generationTimeMs: 30 }),
      { status: 200 },
    ),
  ) as unknown as typeof globalThis.fetch;
}

function mockFailFetch(status = 500): void {
  globalThis.fetch = vi.fn(async () =>
    new Response('boom', { status }),
  ) as unknown as typeof globalThis.fetch;
}

function makeBreaker(threshold = 1): CircuitBreaker {
  return new CircuitBreaker({
    name: 'tts',
    failureThreshold: threshold,
    failureWindowMs: 60_000,
    resetTimeoutMs: 60_000,
  });
}

describe('synthesizeWithCircuitBreaker', () => {
  test('passes through when no breaker is provided', async () => {
    mockOkFetch('ZGF0YQ==');
    const result = await synthesizeWithCircuitBreaker(undefined, {
      ttsUrl: 'http://tts',
      text: 'hello',
      voice: 'matilda',
    });
    expect(result.audioBase64).toBe('ZGF0YQ==');
    expect(result.durationMs).toBe(500);
  });

  test('passes synthesize through a closed breaker', async () => {
    mockOkFetch();
    const breaker = makeBreaker();
    const result = await synthesizeWithCircuitBreaker(breaker, {
      ttsUrl: 'http://tts',
      text: 'hello',
      voice: 'matilda',
    });
    expect(result.audioBase64).toBe('aGVsbG8=');
    expect(breaker.getState()).toBe('closed');
  });

  test('provider failures trip the breaker', async () => {
    mockFailFetch();
    const breaker = makeBreaker(1);
    await expect(
      synthesizeWithCircuitBreaker(breaker, {
        ttsUrl: 'http://tts',
        text: 'x',
        voice: 'v',
      }),
    ).rejects.toBeInstanceOf(TTSClientError);
    expect(breaker.getState()).toBe('open');
  });

  test('when open, skips the provider and degrades with TTSClientError', async () => {
    const breaker = makeBreaker(1);
    mockFailFetch();
    await expect(
      synthesizeWithCircuitBreaker(breaker, {
        ttsUrl: 'http://tts',
        text: 'x',
        voice: 'v',
      }),
    ).rejects.toBeInstanceOf(TTSClientError);
    expect(breaker.getState()).toBe('open');

    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({ audioBase64: 'never', durationMs: 1, generationTimeMs: 1 }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await expect(
      synthesizeWithCircuitBreaker(breaker, {
        ttsUrl: 'http://tts',
        text: 'should-not-call',
        voice: 'v',
      }),
    ).rejects.toMatchObject({
      name: 'TTSClientError',
      kind: 'network',
      message: expect.stringContaining('circuit breaker open'),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(breaker.getSnapshot().rejectedCalls).toBeGreaterThanOrEqual(1);
  });
});
