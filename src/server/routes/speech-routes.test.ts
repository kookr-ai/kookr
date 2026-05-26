import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { registerSpeechRoutes } from './speech-routes.js';
import { AgentSpeakCache } from '../agent-speak-cache.js';
import { TaskSpeechSummaryCache } from '../task-speech-summary-cache.js';
import type { RouteDeps } from './shared.js';
import type { AgentState } from '../../shared/contracts/agent-state.js';
import type { Anomaly } from '../../shared/contracts/anomalies.js';
import type { AgentSpeakContext } from '../../shared/contracts/speech.js';

function fakeAnomaly(overrides: Partial<Anomaly> = {}): Anomaly {
  return {
    agentId: 'agent-1',
    type: 'permission_blocked',
    severity: 'warning',
    explanation: 'needs approval',
    detectedAt: new Date('2026-05-24T10:00:00Z'),
    ...overrides,
  } as Anomaly;
}

function fakeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    agentId: 'agent-1',
    events: [],
    anomaly: fakeAnomaly(),
    taskName: 'Refactor auth',
    lastEventSeq: 0,
    ...overrides,
  };
}

const baseContext: AgentSpeakContext = {
  taskName: 'Refactor auth',
  agentType: 'claude-code',
  cwd: '/tmp/work',
  descriptionExcerpt: 'Refactor the auth module',
  recentActivity: '(no recent activity)',
  recentMessages: '(no recent messages)',
};

function mkApp(opts: {
  agents?: AgentState[];
  task?: unknown;
  enabled?: boolean;
  cache?: AgentSpeakCache | null;
  taskCache?: TaskSpeechSummaryCache | null;
  ttsUrl?: string;
  defaultVerbosity?: () => 'terse' | 'brief' | 'medium' | 'detailed';
  isDebugEnabled?: () => boolean;
  newRequestId?: () => string;
}): Hono {
  const app = new Hono();
  const deps = {
    monitor: { getSnapshot: () => opts.agents ?? [] },
    taskStore: { getTask: () => opts.task },
  } as unknown as RouteDeps;
  registerSpeechRoutes(app, deps, {
    enabled: opts.enabled ?? true,
    cache: opts.cache ?? null,
    taskCache: opts.taskCache ?? null,
    ttsUrl: opts.ttsUrl,
    defaultVerbosity: opts.defaultVerbosity,
    isDebugEnabled: opts.isDebugEnabled,
    newRequestId: opts.newRequestId ?? (() => 'req-fixed'),
  });
  return app;
}

function fakeCache(result: {
  cacheKey?: string;
  cached?: boolean;
  result: {
    text: string;
    audioBase64: string;
    mimeType: 'audio/wav';
    durationMs: number;
    usedFallback: boolean;
    fallbackReason: import('../../shared/contracts/speech.js').SpeakAgentFallbackReason | null;
    llmMs: number;
    ttsMs: number;
  };
}): AgentSpeakCache {
  return {
    get: vi.fn().mockResolvedValue({
      cacheKey: result.cacheKey ?? 'hash-fixed',
      cachedAt: '2026-05-26T00:00:00Z',
      cached: result.cached ?? false,
      result: result.result,
    }),
    getCachedEntry: vi.fn().mockReturnValue(null),
    listRedactedEntries: vi.fn().mockReturnValue([]),
    getStats: vi.fn().mockReturnValue({
      size: 0, bytes: 0, hits: 0, misses: 0, evictions: 0, insertionSkipped: 0,
      inflight: 0, singleflightJoins: 0,
      byVerbosityByMode: {
        terse: { finding: { hits: 0, misses: 0 }, activity: { hits: 0, misses: 0 } },
        brief: { finding: { hits: 0, misses: 0 }, activity: { hits: 0, misses: 0 } },
        medium: { finding: { hits: 0, misses: 0 }, activity: { hits: 0, misses: 0 } },
        detailed: { finding: { hits: 0, misses: 0 }, activity: { hits: 0, misses: 0 } },
      },
    }),
    clear: vi.fn(),
  } as unknown as AgentSpeakCache;
}

function fakeTaskCache(result: Awaited<ReturnType<TaskSpeechSummaryCache['get']>>): TaskSpeechSummaryCache {
  return {
    get: vi.fn().mockResolvedValue(result),
  } as unknown as TaskSpeechSummaryCache;
}

describe('POST /api/agents/:agentId/speak', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('503 feature-disabled when enabled=false', async () => {
    const app = mkApp({ enabled: false });
    const res = await app.request('/api/agents/agent-1/speak', { method: 'POST' });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('feature-disabled');
    expect(body.requestId).toBe('req-fixed');
  });

  test('503 tts-not-configured when cache is null', async () => {
    const app = mkApp({ enabled: true, cache: null });
    const res = await app.request('/api/agents/agent-1/speak', { method: 'POST' });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('tts-not-configured');
    expect(body.requestId).toBe('req-fixed');
  });

  test('404 agent-not-found when monitor lacks the agent', async () => {
    const app = mkApp({
      agents: [],
      cache: fakeCache({ result: { text: '', audioBase64: '', mimeType: 'audio/wav', durationMs: 0, usedFallback: false, fallbackReason: null, llmMs: 0, ttsMs: 0 } }),
      ttsUrl: 'http://tts',
    });
    const res = await app.request('/api/agents/missing/speak', { method: 'POST' });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('agent-not-found');
    expect(body.requestId).toBe('req-fixed');
  });

  test('200 returns SpeakAgentResponse with cacheKey, requestId, resolvedMode', async () => {
    const cache = fakeCache({
      cacheKey: 'abc123',
      cached: false,
      result: {
        text: 'Refactor auth. needs approval.',
        audioBase64: 'AUDIO',
        mimeType: 'audio/wav',
        durationMs: 1000,
        usedFallback: false,
        fallbackReason: null,
        llmMs: 50,
        ttsMs: 200,
      },
    });
    const app = mkApp({ agents: [fakeAgent()], cache, ttsUrl: 'http://tts' });
    const res = await app.request('/api/agents/agent-1/speak', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audioBase64).toBe('AUDIO');
    expect(body.cacheKey).toBe('abc123');
    expect(body.requestId).toBe('req-fixed');
    expect(body.resolvedMode).toBe('finding');
    expect(body.effectiveVerbosity).toBe('medium');
    expect(body.cached).toBe(false);
    expect(body.usedFallback).toBe(false);
  });

  test('resolved mode falls back to activity for anomaly-free agent', async () => {
    const cache = fakeCache({
      result: { text: 'ok', audioBase64: 'a', mimeType: 'audio/wav', durationMs: 0, usedFallback: false, fallbackReason: null, llmMs: 0, ttsMs: 0 },
    });
    const app = mkApp({ agents: [fakeAgent({ anomaly: null })], cache, ttsUrl: 'http://tts' });
    const res = await app.request('/api/agents/agent-1/speak', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolvedMode).toBe('activity');
  });

  test('explicit verbosity in body overrides server default', async () => {
    const cache = fakeCache({
      result: { text: 'ok', audioBase64: 'a', mimeType: 'audio/wav', durationMs: 0, usedFallback: false, fallbackReason: null, llmMs: 0, ttsMs: 0 },
    });
    const app = mkApp({ agents: [fakeAgent()], cache, ttsUrl: 'http://tts' });
    const res = await app.request('/api/agents/agent-1/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verbosity: 'terse' }),
    });
    const body = await res.json();
    expect(body.effectiveVerbosity).toBe('terse');
  });

  test('invalid verbosity body value clamps to default', async () => {
    const cache = fakeCache({
      result: { text: 'ok', audioBase64: 'a', mimeType: 'audio/wav', durationMs: 0, usedFallback: false, fallbackReason: null, llmMs: 0, ttsMs: 0 },
    });
    const app = mkApp({
      agents: [fakeAgent()],
      cache,
      ttsUrl: 'http://tts',
      defaultVerbosity: () => 'brief',
    });
    const res = await app.request('/api/agents/agent-1/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verbosity: 'epic' }),
    });
    const body = await res.json();
    expect(body.effectiveVerbosity).toBe('brief');
  });

  test('explicit mode=activity in body overrides auto resolution for anomaly-bearing agent', async () => {
    const cache = fakeCache({
      result: { text: 'ok', audioBase64: 'a', mimeType: 'audio/wav', durationMs: 0, usedFallback: false, fallbackReason: null, llmMs: 0, ttsMs: 0 },
    });
    const app = mkApp({ agents: [fakeAgent()], cache, ttsUrl: 'http://tts' });
    const res = await app.request('/api/agents/agent-1/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'activity' }),
    });
    const body = await res.json();
    expect(body.resolvedMode).toBe('activity');
  });

  test('500 tts-error when the cache throws', async () => {
    const cache = {
      get: vi.fn().mockRejectedValue(new Error('upstream down')),
      clear: vi.fn(),
      getStats: vi.fn(),
      getCachedEntry: vi.fn().mockReturnValue(null),
      listRedactedEntries: vi.fn().mockReturnValue([]),
    } as unknown as AgentSpeakCache;
    const app = mkApp({ agents: [fakeAgent()], cache, ttsUrl: 'http://tts' });
    const res = await app.request('/api/agents/agent-1/speak', { method: 'POST' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('tts-error');
    expect(body.requestId).toBe('req-fixed');
  });

  test('503 aborted when the cache rejects with AbortError on a pre-aborted signal', async () => {
    const cache = {
      get: vi.fn().mockImplementation(async (_keyInput, _ctx, signal: AbortSignal) => {
        // Yield once so the route's catch block sees `signal.aborted === true`
        // before deciding the status, instead of fixing it before the abort.
        await Promise.resolve();
        if (signal.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
        throw new Error('did not receive expected aborted signal');
      }),
      clear: vi.fn(),
      getStats: vi.fn(),
      getCachedEntry: vi.fn().mockReturnValue(null),
      listRedactedEntries: vi.fn().mockReturnValue([]),
    } as unknown as AgentSpeakCache;
    const app = mkApp({ agents: [fakeAgent()], cache, ttsUrl: 'http://tts' });

    const controller = new AbortController();
    controller.abort();
    const res = await app.request('/api/agents/agent-1/speak', {
      method: 'POST',
      signal: controller.signal,
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('aborted');
    expect(body.requestId).toBe('req-fixed');
  });

  test('legacy /api/findings/:agentId/speak alias routes to the same handler', async () => {
    const cache = fakeCache({
      result: { text: 'Refactor auth. needs approval.', audioBase64: 'AUDIO', mimeType: 'audio/wav', durationMs: 1, usedFallback: false, fallbackReason: null, llmMs: 0, ttsMs: 0 },
    });
    const app = mkApp({ agents: [fakeAgent()], cache, ttsUrl: 'http://tts' });
    const res = await app.request('/api/findings/agent-1/speak', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audioBase64).toBe('AUDIO');
    expect(body.requestId).toBe('req-fixed');
  });
});

describe('GET /api/agents/:agentId/speak/preview', () => {
  test('404 when KOOKR_DEBUG is off', async () => {
    const app = mkApp({ agents: [fakeAgent()], ttsUrl: 'http://tts', cache: fakeCache({ result: { text: '', audioBase64: '', mimeType: 'audio/wav', durationMs: 0, usedFallback: false, fallbackReason: null, llmMs: 0, ttsMs: 0 } }), isDebugEnabled: () => false });
    const res = await app.request('/api/agents/agent-1/speak/preview');
    expect(res.status).toBe(404);
  });

  test('404 agent-not-found when monitor lacks the agent', async () => {
    const app = mkApp({ agents: [], ttsUrl: 'http://tts', cache: fakeCache({ result: { text: '', audioBase64: '', mimeType: 'audio/wav', durationMs: 0, usedFallback: false, fallbackReason: null, llmMs: 0, ttsMs: 0 } }), isDebugEnabled: () => true });
    const res = await app.request('/api/agents/missing/speak/preview');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('agent-not-found');
  });

  test('happy path returns system prompt + context', async () => {
    const app = mkApp({
      agents: [fakeAgent({ anomaly: null, taskName: 'Hello world', cwd: '/tmp', agentType: 'claude-code' })],
      ttsUrl: 'http://tts',
      cache: fakeCache({ result: { text: '', audioBase64: '', mimeType: 'audio/wav', durationMs: 0, usedFallback: false, fallbackReason: null, llmMs: 0, ttsMs: 0 } }),
      isDebugEnabled: () => true,
    });
    const res = await app.request('/api/agents/agent-1/speak/preview?verbosity=medium&mode=auto&path=happy');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe('happy');
    expect(typeof body.prompt).toBe('string');
    expect(body.context.taskName).toBe('Hello world');
    expect(body.cached).toBe(false);
  });

  test('fallback path returns the rung-aware fallback text', async () => {
    const app = mkApp({
      agents: [fakeAgent({ anomaly: null, taskName: 'Quiet task' })],
      ttsUrl: 'http://tts',
      cache: fakeCache({ result: { text: '', audioBase64: '', mimeType: 'audio/wav', durationMs: 0, usedFallback: false, fallbackReason: null, llmMs: 0, ttsMs: 0 } }),
      isDebugEnabled: () => true,
    });
    const res = await app.request('/api/agents/agent-1/speak/preview?path=fallback&verbosity=terse');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.path).toBe('fallback');
    expect(body.prompt).toContain('Quiet task');
  });

  test('cacheKey lookup returns stored entry', async () => {
    const cache = fakeCache({ result: { text: 'stored', audioBase64: '', mimeType: 'audio/wav', durationMs: 0, usedFallback: false, fallbackReason: null, llmMs: 0, ttsMs: 0 } });
    (cache.getCachedEntry as ReturnType<typeof vi.fn>).mockReturnValue({
      cacheKey: 'stored-key',
      cachedAt: '2026-05-26T01:00:00Z',
      context: { ...baseContext, taskName: 'Stored task' },
      resolvedMode: 'finding',
      verbosity: 'brief',
      text: 'stored',
      audioBase64: '',
      mimeType: 'audio/wav',
      durationMs: 0,
      usedFallback: true,
      fallbackReason: 'denylist',
      llmMs: 0,
      ttsMs: 0,
    });
    const app = mkApp({
      agents: [fakeAgent()],
      ttsUrl: 'http://tts',
      cache,
      isDebugEnabled: () => true,
    });
    const res = await app.request('/api/agents/agent-1/speak/preview?cacheKey=stored-key&path=fallback');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cached).toBe(true);
    expect(body.cachedAt).toBe('2026-05-26T01:00:00Z');
    expect(body.context.taskName).toBe('Stored task');
  });
});

describe('GET /api/diagnostics/speak-cache', () => {
  test('404 when KOOKR_DEBUG is off', async () => {
    const app = mkApp({ cache: fakeCache({ result: { text: '', audioBase64: '', mimeType: 'audio/wav', durationMs: 0, usedFallback: false, fallbackReason: null, llmMs: 0, ttsMs: 0 } }), ttsUrl: 'http://tts', isDebugEnabled: () => false });
    const res = await app.request('/api/diagnostics/speak-cache');
    expect(res.status).toBe(404);
  });

  test('returns stats + entries + flags when KOOKR_DEBUG is on', async () => {
    const cache = fakeCache({ result: { text: '', audioBase64: '', mimeType: 'audio/wav', durationMs: 0, usedFallback: false, fallbackReason: null, llmMs: 0, ttsMs: 0 } });
    (cache.listRedactedEntries as ReturnType<typeof vi.fn>).mockReturnValue([
      { cacheKey: 'k', cachedAt: '2026-05-26T00:00:00Z', resolvedMode: 'finding', verbosity: 'medium', usedFallback: false, fallbackReason: null, recapPrefix: 'Hello' },
    ]);
    const app = mkApp({ cache, ttsUrl: 'http://tts', isDebugEnabled: () => true });
    const res = await app.request('/api/diagnostics/speak-cache');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries.length).toBe(1);
    expect(body.entries[0].cacheKey).toBe('k');
    expect(body.featureEnabled).toBe(true);
    expect(body.ttsConfigured).toBe(true);
  });
});

describe('POST /api/tasks/:taskId/speak-summary (unchanged from PR1)', () => {
  test('503 feature-disabled when enabled=false', async () => {
    const app = mkApp({ enabled: false });
    const res = await app.request('/api/tasks/task-1/speak-summary', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'feature-disabled' });
  });

  test('503 tts-not-configured when task cache is null', async () => {
    const app = mkApp({ enabled: true, taskCache: null });
    const res = await app.request('/api/tasks/task-1/speak-summary', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'tts-not-configured' });
  });

  test('404 task-not-found when neither snapshot nor store has task', async () => {
    const app = mkApp({
      agents: [],
      taskCache: fakeTaskCache({} as never),
      ttsUrl: 'http://tts',
    });
    const res = await app.request('/api/tasks/missing/speak-summary', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'task-not-found' });
  });
});
