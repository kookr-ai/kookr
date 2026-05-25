import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { registerSpeechRoutes } from './speech-routes.js';
import { FindingSummaryCache } from '../finding-summary-cache.js';
import { TaskSpeechSummaryCache } from '../task-speech-summary-cache.js';
import type { RouteDeps } from './shared.js';
import type { AgentState } from '../../shared/contracts/agent-state.js';
import type { Anomaly } from '../../shared/contracts/anomalies.js';

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
    ...overrides,
  };
}

function mkApp(opts: {
  agents?: AgentState[];
  task?: unknown;
  enabled?: boolean;
  cache?: FindingSummaryCache | null;
  taskCache?: TaskSpeechSummaryCache | null;
  ttsUrl?: string;
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
  });
  return app;
}

function fakeCache(result: Awaited<ReturnType<FindingSummaryCache['get']>>): FindingSummaryCache {
  return {
    get: vi.fn().mockResolvedValue(result),
    clear: vi.fn(),
    getStats: vi.fn().mockReturnValue({ size: 0, bytes: 0, hits: 0, misses: 0, evictions: 0, inflight: 0 }),
  } as unknown as FindingSummaryCache;
}

function fakeTaskCache(result: Awaited<ReturnType<TaskSpeechSummaryCache['get']>>): TaskSpeechSummaryCache {
  return {
    get: vi.fn().mockResolvedValue(result),
  } as unknown as TaskSpeechSummaryCache;
}

describe('POST /api/findings/:agentId/speak', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('503 feature-disabled when enabled=false', async () => {
    const app = mkApp({ enabled: false });
    const res = await app.request('/api/findings/agent-1/speak', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'feature-disabled' });
  });

  test('503 tts-not-configured when cache is null', async () => {
    const app = mkApp({ enabled: true, cache: null });
    const res = await app.request('/api/findings/agent-1/speak', { method: 'POST' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'tts-not-configured' });
  });

  test('404 agent-not-found when monitor lacks the agent', async () => {
    const app = mkApp({
      agents: [],
      cache: fakeCache({} as never),
      ttsUrl: 'http://tts',
    });
    const res = await app.request('/api/findings/missing/speak', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'agent-not-found' });
  });

  test('409 no-finding when agent has no anomaly', async () => {
    const app = mkApp({
      agents: [fakeAgent({ anomaly: null })],
      cache: fakeCache({} as never),
      ttsUrl: 'http://tts',
    });
    const res = await app.request('/api/findings/agent-1/speak', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'no-finding' });
  });

  test('200 returns audio payload from cache', async () => {
    const cache = fakeCache({
      text: 'Refactor auth. needs approval.',
      audioBase64: 'AUDIO',
      mimeType: 'audio/wav',
      durationMs: 1000,
      usedFallback: false,
      llmMs: 50,
      ttsMs: 200,
      cached: false,
    });
    const app = mkApp({
      agents: [fakeAgent()],
      cache,
      ttsUrl: 'http://tts',
    });
    const res = await app.request('/api/findings/agent-1/speak', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audioBase64).toBe('AUDIO');
    expect(body.text).toContain('Refactor auth');
    expect(body.cached).toBe(false);
  });

  test('500 tts-error when the cache throws', async () => {
    const cache = {
      get: vi.fn().mockRejectedValue(new Error('upstream down')),
      clear: vi.fn(),
      getStats: vi.fn(),
    } as unknown as FindingSummaryCache;
    const app = mkApp({
      agents: [fakeAgent()],
      cache,
      ttsUrl: 'http://tts',
    });
    const res = await app.request('/api/findings/agent-1/speak', { method: 'POST' });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('tts-error');
  });
});

describe('POST /api/tasks/:taskId/speak-summary', () => {
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

  test('200 returns audio payload for completed synthetic task', async () => {
    const cache = fakeTaskCache({
      text: 'Refactor auth is completed: Tests passed.',
      audioBase64: 'AUDIO',
      mimeType: 'audio/wav',
      durationMs: 1000,
      usedFallback: false,
      llmMs: 50,
      ttsMs: 200,
      cached: false,
    });
    const app = mkApp({
      agents: [fakeAgent({
        anomaly: null,
        taskId: 'task-1',
        taskStatus: 'completed',
        completionDigest: { bullets: ['Tests passed'], filesChanged: [] },
      })],
      taskCache: cache,
      ttsUrl: 'http://tts',
    });
    const res = await app.request('/api/tasks/task-1/speak-summary', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.audioBase64).toBe('AUDIO');
    expect(cache.get).toHaveBeenCalledWith(expect.objectContaining({
      taskName: 'Refactor auth',
      taskStatus: 'completed',
      completionDigest: expect.objectContaining({ bullets: ['Tests passed'] }),
    }), expect.any(AbortSignal));
  });
});
