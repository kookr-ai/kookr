import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentSpeakCache, computeCacheKey } from './agent-speak-cache.js';
import type { AgentSpeakContext } from '../shared/contracts/speech.js';

const fakeContext: AgentSpeakContext = {
  taskName: 'Refactor auth',
  agentType: 'claude-code',
  cwd: '/tmp/work',
  descriptionExcerpt: 'short description',
  recentActivity: '(no recent activity)',
  recentMessages: '(no recent messages)',
};

function mockTtsResponse(audioBase64 = 'AUDIO'): Response {
  return new Response(JSON.stringify({ audioBase64, durationMs: 1000, generationTimeMs: 200 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('computeCacheKey', () => {
  test('differs for different verbosity rungs', () => {
    const base = {
      agentId: 'a1', resolvedMode: 'finding' as const, lastEventSeq: 5,
      anomalyDetectedAt: new Date('2026-05-26T00:00:00Z'),
    };
    const k1 = computeCacheKey({ ...base, verbosity: 'medium' });
    const k2 = computeCacheKey({ ...base, verbosity: 'detailed' });
    expect(k1).not.toBe(k2);
  });

  test('differs for different resolved modes', () => {
    const base = {
      agentId: 'a1', verbosity: 'medium' as const, lastEventSeq: 5,
      anomalyDetectedAt: new Date('2026-05-26T00:00:00Z'),
    };
    expect(computeCacheKey({ ...base, resolvedMode: 'finding' }))
      .not.toBe(computeCacheKey({ ...base, resolvedMode: 'activity' }));
  });

  test('differs for different lastEventSeq', () => {
    const base = {
      agentId: 'a1', verbosity: 'medium' as const, resolvedMode: 'activity' as const,
      anomalyDetectedAt: null,
    };
    expect(computeCacheKey({ ...base, lastEventSeq: 0 }))
      .not.toBe(computeCacheKey({ ...base, lastEventSeq: 1 }));
  });

  test('falsy anomalyDetectedAt collapses to a constant sentinel', () => {
    const base = {
      agentId: 'a1', verbosity: 'medium' as const, resolvedMode: 'activity' as const, lastEventSeq: 0,
    };
    expect(computeCacheKey({ ...base, anomalyDetectedAt: null }))
      .toBe(computeCacheKey({ ...base, anomalyDetectedAt: undefined }));
  });
});

describe('AgentSpeakCache.get', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Return a *fresh* Response per call — Response bodies can only be read
    // once, so a shared instance breaks on the second `fetch` invocation.
    globalThis.fetch = vi.fn().mockImplementation(async () => mockTtsResponse()) as unknown as typeof globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('first call is a miss; second call with the same key is a hit', async () => {
    const cache = new AgentSpeakCache({ llmClient: null, ttsUrl: 'http://tts', voice: 'matilda' });
    const key = { agentId: 'a1', resolvedMode: 'activity' as const, verbosity: 'brief' as const, lastEventSeq: 1, anomalyDetectedAt: null };

    const first = await cache.get(key, fakeContext);
    expect(first.cached).toBe(false);

    const second = await cache.get(key, fakeContext);
    expect(second.cached).toBe(true);
    expect(second.result.text).toContain('Refactor auth');

    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.byVerbosityByMode.brief.activity.hits).toBe(1);
    expect(stats.byVerbosityByMode.brief.activity.misses).toBe(1);
  });

  test('different verbosity rungs produce distinct cache entries', async () => {
    const cache = new AgentSpeakCache({ llmClient: null, ttsUrl: 'http://tts', voice: 'matilda' });
    const base = { agentId: 'a1', resolvedMode: 'activity' as const, lastEventSeq: 1, anomalyDetectedAt: null };
    await cache.get({ ...base, verbosity: 'brief' }, fakeContext);
    await cache.get({ ...base, verbosity: 'medium' }, fakeContext);
    const stats = cache.getStats();
    expect(stats.size).toBe(2);
    expect(stats.misses).toBe(2);
    expect(stats.hits).toBe(0);
  });

  test('lastEventSeq change busts the cache', async () => {
    const cache = new AgentSpeakCache({ llmClient: null, ttsUrl: 'http://tts', voice: 'matilda' });
    const base = { agentId: 'a1', resolvedMode: 'activity' as const, verbosity: 'medium' as const, anomalyDetectedAt: null };
    await cache.get({ ...base, lastEventSeq: 1 }, fakeContext);
    await cache.get({ ...base, lastEventSeq: 2 }, fakeContext);
    expect(cache.getStats().size).toBe(2);
    expect(cache.getStats().misses).toBe(2);
  });

  test('singleflight: concurrent gets share one underlying fetch', async () => {
    const cache = new AgentSpeakCache({ llmClient: null, ttsUrl: 'http://tts', voice: 'matilda' });
    const key = { agentId: 'a1', resolvedMode: 'activity' as const, verbosity: 'medium' as const, lastEventSeq: 1, anomalyDetectedAt: null };
    const [a, b, c] = await Promise.all([
      cache.get(key, fakeContext),
      cache.get(key, fakeContext),
      cache.get(key, fakeContext),
    ]);
    expect(a.cached).toBe(false);
    expect(b.cached).toBe(true);
    expect(c.cached).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const stats = cache.getStats();
    expect(stats.singleflightJoins).toBe(2);
  });

  test('byte cap evicts oldest entries until under cap', async () => {
    // Maximum bytes is small enough to force eviction; insert two entries that
    // together exceed it so the older one is dropped.
    const big = 'A'.repeat(500);
    globalThis.fetch = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ audioBase64: big, durationMs: 1, generationTimeMs: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof globalThis.fetch;
    const cache = new AgentSpeakCache({ llmClient: null, ttsUrl: 'http://tts', voice: 'matilda', maxBytes: 700 });
    const base = { agentId: 'a1', resolvedMode: 'activity' as const, verbosity: 'medium' as const, anomalyDetectedAt: null };
    await cache.get({ ...base, lastEventSeq: 1 }, fakeContext);
    await cache.get({ ...base, lastEventSeq: 2 }, fakeContext);
    const stats = cache.getStats();
    expect(stats.evictions).toBeGreaterThanOrEqual(1);
    expect(stats.size).toBeLessThanOrEqual(1);
  });

  test('entry larger than cap is not inserted; insertionSkipped increments', async () => {
    const huge = 'B'.repeat(2000);
    globalThis.fetch = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ audioBase64: huge, durationMs: 1, generationTimeMs: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof globalThis.fetch;
    const cache = new AgentSpeakCache({ llmClient: null, ttsUrl: 'http://tts', voice: 'matilda', maxBytes: 500 });
    const result = await cache.get(
      { agentId: 'a1', resolvedMode: 'activity', verbosity: 'medium', lastEventSeq: 1, anomalyDetectedAt: null },
      fakeContext,
    );
    expect(result.cached).toBe(false);
    const stats = cache.getStats();
    expect(stats.insertionSkipped).toBe(1);
    expect(stats.size).toBe(0);
  });

  test('cached entry retains AgentSpeakContext for preview lookups', async () => {
    const cache = new AgentSpeakCache({ llmClient: null, ttsUrl: 'http://tts', voice: 'matilda' });
    const key = { agentId: 'a1', resolvedMode: 'finding' as const, verbosity: 'brief' as const, lastEventSeq: 1, anomalyDetectedAt: new Date('2026-05-26T00:00:00Z') };
    const first = await cache.get(key, fakeContext);
    const stored = cache.getCachedEntry(first.cacheKey);
    expect(stored).not.toBeNull();
    expect(stored!.context.taskName).toBe('Refactor auth');
    expect(stored!.resolvedMode).toBe('finding');
    expect(stored!.verbosity).toBe('brief');
  });
});
