import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentSpeakCache, computeCacheKey } from './agent-speak-cache.js';
import { CircuitBreaker } from '../core/circuit-breaker.js';
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

describe('computeCacheKey voice', () => {
  test('differs for different voices', () => {
    const base = {
      agentId: 'a1', resolvedMode: 'activity' as const, verbosity: 'medium' as const,
      lastEventSeq: 1, anomalyDetectedAt: null,
    };
    expect(computeCacheKey({ ...base, voice: 'af_heart' })).not.toBe(computeCacheKey({ ...base, voice: 'af_sky' }));
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

  test('speaks the speakable text, and carries rawText on miss and hit', async () => {
    const client = {
      provider: 'test',
      model: 'test-model',
      complete: vi.fn().mockResolvedValue(JSON.stringify({ recap: 'Edited `src/core/foo.ts` for #12.' })),
    };
    const cache = new AgentSpeakCache({ llmClient: client, ttsUrl: 'http://tts', voice: 'matilda' });
    const key = { agentId: 'a1', resolvedMode: 'activity' as const, verbosity: 'medium' as const, lastEventSeq: 1, anomalyDetectedAt: null };

    const first = await cache.get(key, fakeContext);
    expect(first.result.text).toBe('Refactor auth. Edited foo.ts for number 12.');
    expect(first.result.rawText).toBe('Refactor auth. Edited `src/core/foo.ts` for #12.');
    const body = JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0][1]?.body)) as { text: string };
    expect(body.text).toBe(first.result.text);

    const second = await cache.get(key, fakeContext);
    expect(second.cached).toBe(true);
    expect(second.result.rawText).toBe(first.result.rawText);
    expect(cache.getCachedEntry(first.cacheKey)?.rawText).toBe(first.result.rawText);
  });

  test('a different voice misses and synthesizes in that voice; the same voice hits', async () => {
    const cache = new AgentSpeakCache({ llmClient: null, ttsUrl: 'http://tts', voice: 'matilda' });
    const key = { agentId: 'a3', resolvedMode: 'activity' as const, verbosity: 'medium' as const, lastEventSeq: 1, anomalyDetectedAt: null };
    const voiceOfCall = (n: number) =>
      (JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[n][1]?.body)) as { voice: string }).voice;

    const first = await cache.get(key, fakeContext);
    expect(first.cached).toBe(false);
    expect(voiceOfCall(0)).toBe('matilda');

    const heart = await cache.get({ ...key, voice: 'af_heart' }, fakeContext);
    expect(heart.cached).toBe(false);
    expect(heart.cacheKey).not.toBe(first.cacheKey);
    expect(voiceOfCall(1)).toBe('af_heart');

    expect((await cache.get({ ...key, voice: 'af_heart' }, fakeContext)).cached).toBe(true);
    expect((await cache.get(key, fakeContext)).cached).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  test('omits rawText when nothing needed rewriting', async () => {
    const cache = new AgentSpeakCache({ llmClient: null, ttsUrl: 'http://tts', voice: 'matilda' });
    const key = { agentId: 'a2', resolvedMode: 'finding' as const, verbosity: 'terse' as const, lastEventSeq: 1, anomalyDetectedAt: null };
    const ctx: AgentSpeakContext = { ...fakeContext, anomaly: { type: 'needs_input', severity: 'info', explanation: 'x' } };
    const { result } = await cache.get(key, ctx);
    expect(result.text).toBe('Refactor auth needs your input.');
    expect('rawText' in result).toBe(false);
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

  test('joiner re-fetches with its own signal when leader aborts', async () => {
    // Reproduces the singleflight inheritance bug: leader A starts, joiner B
    // joins, leader A's signal aborts. B's signal never aborted, so B must
    // not inherit A's AbortError — instead B should re-run the work.
    const leaderCtrl = new AbortController();
    let fetchCalls = 0;

    globalThis.fetch = vi.fn().mockImplementation(async (_url, init?: RequestInit) => {
      fetchCalls += 1;
      // First call: leader's. Wait for the leader to abort.
      if (fetchCalls === 1) {
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          }, { once: true });
        });
        return mockTtsResponse();
      }
      // Second call: joiner's fresh fetch after leader's failure.
      return mockTtsResponse('JOINER_AUDIO');
    }) as unknown as typeof globalThis.fetch;

    const cache = new AgentSpeakCache({ llmClient: null, ttsUrl: 'http://tts', voice: 'matilda' });
    const key = { agentId: 'a1', resolvedMode: 'activity' as const, verbosity: 'medium' as const, lastEventSeq: 1, anomalyDetectedAt: null };

    const joinerCtrl = new AbortController();
    const leaderPromise = cache.get(key, fakeContext, leaderCtrl.signal);
    // Yield so the leader has registered inflight before joiner attaches.
    await Promise.resolve();
    const joinerPromise = cache.get(key, fakeContext, joinerCtrl.signal);

    // Abort the leader; the joiner's signal stays clear.
    leaderCtrl.abort();

    await expect(leaderPromise).rejects.toBeDefined();
    const joinerResult = await joinerPromise;
    expect(joinerResult.cached).toBe(false);
    expect(joinerResult.result.audioBase64).toBe('JOINER_AUDIO');
    expect(fetchCalls).toBe(2);
  });

  test('joiner that also aborted surfaces the abort to its caller', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init?: RequestInit) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      });
      return mockTtsResponse();
    }) as unknown as typeof globalThis.fetch;

    const cache = new AgentSpeakCache({ llmClient: null, ttsUrl: 'http://tts', voice: 'matilda' });
    const key = { agentId: 'a1', resolvedMode: 'activity' as const, verbosity: 'medium' as const, lastEventSeq: 1, anomalyDetectedAt: null };

    const leaderCtrl = new AbortController();
    const joinerCtrl = new AbortController();
    const leaderPromise = cache.get(key, fakeContext, leaderCtrl.signal);
    await Promise.resolve();
    const joinerPromise = cache.get(key, fakeContext, joinerCtrl.signal);

    // Both abort.
    joinerCtrl.abort();
    leaderCtrl.abort();
    await expect(leaderPromise).rejects.toBeDefined();
    await expect(joinerPromise).rejects.toBeDefined();
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

  test('open TTS breaker fails fresh synthesis fast but still serves cache hits', async () => {
    const breaker = new CircuitBreaker({
      name: 'tts',
      failureThreshold: 1,
      failureWindowMs: 60_000,
      resetTimeoutMs: 60_000,
    });
    const cache = new AgentSpeakCache({
      llmClient: null,
      ttsUrl: 'http://tts',
      voice: 'matilda',
      ttsBreaker: breaker,
    });
    const key = {
      agentId: 'a1',
      resolvedMode: 'activity' as const,
      verbosity: 'brief' as const,
      lastEventSeq: 1,
      anomalyDetectedAt: null,
    };

    const first = await cache.get(key, fakeContext);
    expect(first.cached).toBe(false);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // Trip the breaker with a direct failure so subsequent synthesize is shed.
    breaker.recordFailure();
    expect(breaker.getState()).toBe('open');

    const fetchAfterOpen = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchAfterOpen.mockClear();

    // Same key: cache hit still returns audio without calling TTS.
    const hit = await cache.get(key, fakeContext);
    expect(hit.cached).toBe(true);
    expect(hit.result.audioBase64).toBe(first.result.audioBase64);
    expect(fetchAfterOpen).not.toHaveBeenCalled();

    // Fresh key: miss path fails fast with degraded TTS error and no fetch.
    await expect(
      cache.get({ ...key, lastEventSeq: 2 }, fakeContext),
    ).rejects.toMatchObject({
      name: 'TTSClientError',
      message: expect.stringContaining('circuit breaker open'),
    });
    expect(fetchAfterOpen).not.toHaveBeenCalled();
  });
});
