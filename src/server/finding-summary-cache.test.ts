import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { FindingSummaryCache, computeCacheKey } from './finding-summary-cache.js';
import type { LlmClient } from '../core/llm-client.js';

const ttsResponse = (text: string) => ({
  audioBase64: Buffer.from(`AUDIO:${text}`).toString('base64'),
  durationMs: 1000,
  generationTimeMs: 50,
});

function mockFetch(responder: (req: Request) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const req = new Request(url, init);
    return responder(req);
  });
}

function mockClient(recap: string | null): LlmClient {
  return {
    provider: 'test',
    model: 'test-model',
    complete: vi.fn().mockResolvedValue(recap ? JSON.stringify({ recap }) : null),
  };
}

const baseRequestKey = {
  agentId: 'agent-1',
  anomalyType: 'permission_blocked',
  severity: 'warning',
  explanation: 'needs approval',
  detectedAt: new Date('2026-05-24T10:00:00Z'),
  taskName: 'Refactor auth',
  freshness: 42,
};

const baseSummaryInput = {
  taskName: 'Refactor auth',
  anomalyType: 'permission_blocked',
  anomalySeverity: 'warning',
  explanation: 'needs approval',
};

describe('computeCacheKey', () => {
  test('produces stable hash for identical inputs', () => {
    expect(computeCacheKey(baseRequestKey)).toBe(computeCacheKey(baseRequestKey));
  });

  test('differs when explanation changes', () => {
    expect(computeCacheKey(baseRequestKey)).not.toBe(
      computeCacheKey({ ...baseRequestKey, explanation: 'different' }),
    );
  });

  test('Date and equivalent ISO string produce same hash', () => {
    const isoKey = { ...baseRequestKey, detectedAt: baseRequestKey.detectedAt.toISOString() };
    expect(computeCacheKey(baseRequestKey)).toBe(computeCacheKey(isoKey));
  });

  test('Date and equivalent epoch ms produce same hash', () => {
    const epochKey = { ...baseRequestKey, detectedAt: baseRequestKey.detectedAt.getTime() };
    expect(computeCacheKey(baseRequestKey)).toBe(computeCacheKey(epochKey));
  });

  test('falsy detectedAt does not collide with valid detectedAt', () => {
    const nullKey = { ...baseRequestKey, detectedAt: null };
    expect(computeCacheKey(baseRequestKey)).not.toBe(computeCacheKey(nullKey));
  });

  test('different freshness for same detectedAt produces different hash', () => {
    expect(computeCacheKey(baseRequestKey)).not.toBe(
      computeCacheKey({ ...baseRequestKey, freshness: 999 }),
    );
  });

  test('shifting bytes between adjacent fields does NOT collide (separator regression guard)', () => {
    // If the field separator were the empty string (or stripped), these two
    // keys would hash identically — the implementation must use a real,
    // non-printable separator byte.
    const a = computeCacheKey({ ...baseRequestKey, anomalyType: 'ab', severity: 'cd' });
    const b = computeCacheKey({ ...baseRequestKey, anomalyType: 'a', severity: 'bcd' });
    expect(a).not.toBe(b);
  });
});

describe('FindingSummaryCache', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('cache miss triggers LLM + TTS, caches result; cache hit skips both', async () => {
    const client = mockClient('all clear');
    const fetchSpy = mockFetch(async () => new Response(JSON.stringify(ttsResponse('all clear')), { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const cache = new FindingSummaryCache({
      llmClient: client,
      ttsUrl: 'http://tts.local',
      voice: 'matilda',
    });

    const first = await cache.get(baseRequestKey, baseSummaryInput);
    expect(first.cached).toBe(false);
    expect(first.usedFallback).toBe(false);
    expect(client.complete).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledOnce();

    const second = await cache.get(baseRequestKey, baseSummaryInput);
    expect(second.cached).toBe(true);
    expect(second.audioBase64).toBe(first.audioBase64);
    expect(client.complete).toHaveBeenCalledOnce(); // no new call
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  test('singleflight: concurrent requests for same key share one underlying call', async () => {
    const client = mockClient('shared');
    let ttsCalls = 0;
    const fetchSpy = mockFetch(async () => {
      ttsCalls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify(ttsResponse('shared')), { status: 200 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const cache = new FindingSummaryCache({
      llmClient: client,
      ttsUrl: 'http://tts.local',
      voice: 'matilda',
    });

    const [a, b, c] = await Promise.all([
      cache.get(baseRequestKey, baseSummaryInput),
      cache.get(baseRequestKey, baseSummaryInput),
      cache.get(baseRequestKey, baseSummaryInput),
    ]);

    expect(ttsCalls).toBe(1);
    expect(client.complete).toHaveBeenCalledOnce();
    expect(a.audioBase64).toBe(b.audioBase64);
    expect(b.audioBase64).toBe(c.audioBase64);
  });

  test('FIFO eviction when maxEntries exceeded', async () => {
    const fetchSpy = mockFetch(async (req) => {
      const body = (await req.json()) as { text: string };
      return new Response(JSON.stringify(ttsResponse(body.text)), { status: 200 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const cache = new FindingSummaryCache({
      llmClient: null, // fallback path so each key triggers one TTS call
      ttsUrl: 'http://tts.local',
      voice: 'matilda',
      maxEntries: 2,
    });

    await cache.get({ ...baseRequestKey, agentId: 'a' }, baseSummaryInput);
    await cache.get({ ...baseRequestKey, agentId: 'b' }, baseSummaryInput);
    await cache.get({ ...baseRequestKey, agentId: 'c' }, baseSummaryInput);

    const stats = cache.getStats();
    expect(stats.size).toBe(2);
    expect(stats.evictions).toBe(1);
  });

  test('byte cap evicts oldest entry first', async () => {
    const big = 'x'.repeat(2_000);
    const fetchSpy = mockFetch(async () =>
      new Response(JSON.stringify({ audioBase64: big, durationMs: 100, generationTimeMs: 10 }), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const cache = new FindingSummaryCache({
      llmClient: null,
      ttsUrl: 'http://tts.local',
      voice: 'matilda',
      maxBytes: 2_500, // forces eviction after the 2nd insert
    });

    await cache.get({ ...baseRequestKey, agentId: 'a' }, baseSummaryInput);
    await cache.get({ ...baseRequestKey, agentId: 'b' }, baseSummaryInput);

    const stats = cache.getStats();
    expect(stats.evictions).toBeGreaterThanOrEqual(1);
    expect(stats.bytes).toBeLessThanOrEqual(2_500);
  });

  test('TTS error propagates and is not cached', async () => {
    const client = mockClient('x');
    const fetchSpy = mockFetch(async () => new Response('boom', { status: 500 }));
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const cache = new FindingSummaryCache({
      llmClient: client,
      ttsUrl: 'http://tts.local',
      voice: 'matilda',
    });

    await expect(cache.get(baseRequestKey, baseSummaryInput)).rejects.toThrow();
    // Re-issuing must NOT cache-hit on the failed state.
    const fetchCallsAfter = fetchSpy.mock.calls.length;
    await expect(cache.get(baseRequestKey, baseSummaryInput)).rejects.toThrow();
    expect(fetchSpy.mock.calls.length).toBeGreaterThan(fetchCallsAfter);
  });
});

