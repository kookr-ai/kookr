import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  classifyLlmProviderFailure,
  completeLlmWithFailureAudit,
  DEFAULT_LLM_AUTH_COOLDOWN_MS,
  DEFAULT_LLM_PROVIDER_ATTEMPT_BUDGET,
  DEFAULT_LLM_PROVIDER_ATTEMPT_WINDOW_MS,
  FallbackLlmClient,
  getHelperLlmDiagnosticsSnapshot,
  getHelperLlmHealthSnapshot,
  resetHelperLlmDiagnosticsForTest,
  resolveLlmAuthCooldownMs,
  resolveLlmProviderAttemptBudget,
  resolveLlmProviderAttemptWindowMs,
  summarizeLlmFailureForLog,
  withHelperLlmAccounting,
} from './llm-factory.js';
import { setLoggerRuntimeLevelGetter } from './logger.js';
import { classifyLlmProviderHttpStatus, type LlmClient } from './llm-types.js';

const ENV_KEYS = [
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'KOOKR_OPENROUTER_API_KEY',
  'OPENROUTER_API_KEY',
  'KOOKR_REQUESTY_API_KEY',
  'REQUESTY_API_KEY',
  'KOOKR_REQUESTY_MODEL',
  'KOOKR_LLM_PROVIDER',
  'KOOKR_LLM_MODEL',
  'KOOKR_LLM_BASE_URL',
  'KOOKR_LLM_HTTP_REFERER',
  'KOOKR_LLM_APP_TITLE',
  'KOOKR_LLM_TIMEOUT_MS',
  'KOOKR_LLM_AUTH_COOLDOWN_MS',
  'KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET',
  'KOOKR_LLM_PROVIDER_ATTEMPT_WINDOW_MS',
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

// Auth pauses are process-global (like helper LLM counters); always clear them
// so an auth-failure case in one describe cannot skip providers in the next.
afterEach(() => {
  resetHelperLlmDiagnosticsForTest();
});

describe('helper LLM accounting', () => {
  beforeEach(() => {
    clearEnv();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearEnv();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
    resetHelperLlmDiagnosticsForTest();
  });

  function accountedClient(provider: string, impl: () => Promise<string | null>): LlmClient {
    return withHelperLlmAccounting({
      provider,
      model: `${provider}-model`,
      complete: vi.fn().mockImplementation(impl),
    });
  }

  test('records success latency by use case and provider', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const client = accountedClient('groq', async () => {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.042Z'));
      return 'ok';
    });

    await expect(client.complete({ useCase: 'task_naming', maxTokens: 10, userMessage: 'hi' })).resolves.toBe('ok');

    const snapshot = getHelperLlmDiagnosticsSnapshot();
    expect(snapshot.totals).toMatchObject({
      requestCount: 1,
      successCount: 1,
      failureCount: 0,
      totalLatencyMs: 42,
      averageLatencyMs: 42,
      maxLatencyMs: 42,
    });
    expect(snapshot.byUseCase).toEqual([expect.objectContaining({ useCase: 'task_naming', requestCount: 1 })]);
    expect(snapshot.byProvider).toEqual([expect.objectContaining({ provider: 'groq', model: 'groq-model', requestCount: 1 })]);
    expect(snapshot.byUseCaseProvider).toEqual([
      expect.objectContaining({ useCase: 'task_naming', provider: 'groq', model: 'groq-model', successCount: 1 }),
    ]);
  });

  test('records null, thrown, and aborted helper calls as failures', async () => {
    const nullClient = accountedClient('nullish', async () => null);
    const errorClient = accountedClient('broken', async () => { throw Object.assign(new Error('bad gateway'), { status: 502 }); });
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const abortClient = accountedClient('aborted', async () => { throw abortErr; });

    await expect(nullClient.complete({ useCase: 'response_suggestion', maxTokens: 10, userMessage: 'hi' })).resolves.toBeNull();
    await expect(errorClient.complete({ useCase: 'response_suggestion', maxTokens: 10, userMessage: 'hi' })).rejects.toThrow('bad gateway');
    await expect(abortClient.complete({ useCase: 'response_suggestion', maxTokens: 10, userMessage: 'hi' })).rejects.toMatchObject({ name: 'AbortError' });

    const snapshot = getHelperLlmDiagnosticsSnapshot();
    expect(snapshot.totals).toMatchObject({
      requestCount: 3,
      successCount: 0,
      failureCount: 3,
      nullResponseCount: 1,
      errorCount: 1,
      abortedCount: 1,
    });
    expect(snapshot.totals.failureCategories).toEqual({
      malformed_response: 1,
      server_5xx: 1,
      other: 1,
    });
    expect(snapshot.byUseCase).toEqual([
      expect.objectContaining({
        useCase: 'response_suggestion',
        requestCount: 3,
        failureCount: 3,
      }),
    ]);
  });

});

describe('FallbackLlmClient.complete abort propagation', () => {
  function client(provider: string, impl: () => Promise<string | null>) {
    return { provider, model: `${provider}-model`, complete: vi.fn().mockImplementation(impl) };
  }

  test('re-throws AbortError instead of advancing to the next provider', async () => {
    const abortErr = Object.assign(new Error('abort'), { name: 'AbortError' });
    const a = client('a', async () => { throw abortErr; });
    const b = client('b', async () => 'should not happen');
    const fb = new FallbackLlmClient([a, b]);
    await expect(fb.complete({ maxTokens: 10, userMessage: 'hi' })).rejects.toMatchObject({ name: 'AbortError' });
    expect(b.complete).not.toHaveBeenCalled();
  });

  test('honors an already-aborted signal before the first provider runs', async () => {
    const a = client('a', async () => 'ignored');
    const fb = new FallbackLlmClient([a]);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(fb.complete({ maxTokens: 10, userMessage: 'hi', signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(a.complete).not.toHaveBeenCalled();
  });

  test('aborts between providers when the signal fires mid-loop', async () => {
    const ctrl = new AbortController();
    const a = client('a', async () => {
      ctrl.abort();
      return null;
    });
    const b = client('b', async () => 'should not run');
    const fb = new FallbackLlmClient([a, b]);
    await expect(fb.complete({ maxTokens: 10, userMessage: 'hi', signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(b.complete).not.toHaveBeenCalled();
  });

  test('non-abort errors still advance to the next provider', async () => {
    const a = client('a', async () => { throw new Error('boom'); });
    const b = client('b', async () => 'final answer');
    const fb = new FallbackLlmClient([a, b]);
    await expect(fb.complete({ maxTokens: 10, userMessage: 'hi' })).resolves.toBe('final answer');
    expect(b.complete).toHaveBeenCalledOnce();
  });

  test('provider timeout errors still advance to the next provider', async () => {
    const a = client('a', async () => { throw new Error('Requesty request timed out after 1000ms'); });
    const b = client('b', async () => 'fallback after timeout');
    const fb = new FallbackLlmClient([a, b]);
    await expect(fb.complete({ maxTokens: 10, userMessage: 'hi' })).resolves.toBe('fallback after timeout');
    expect(b.complete).toHaveBeenCalledOnce();
  });

  test('records categorized provider failures while falling back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const authErr = Object.assign(new Error('invalid api key'), { providerFailureCategory: 'auth' });
    const a = client('a', async () => { throw authErr; });
    const b = client('b', async () => 'fallback after auth failure');
    const fb = new FallbackLlmClient([a, b]);

    const result = await fb.completeWithFailureAudit({ maxTokens: 10, userMessage: 'hi' });

    expect(result).toEqual({
      text: 'fallback after auth failure',
      failureCategory: null,
      failures: [{
        provider: 'a',
        model: 'a-model',
        category: 'auth',
        message: 'invalid api key',
      }],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('category=auth'));
    warn.mockRestore();
  });

  test('returns final failure category when every provider fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = client('a', async () => { throw Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' }); });
    const b = client('b', async () => null);
    const fb = new FallbackLlmClient([a, b]);

    const result = await fb.completeWithFailureAudit({ maxTokens: 10, userMessage: 'hi' });

    expect(result.text).toBeNull();
    expect(result.failureCategory).toBe('malformed_response');
    expect(result.failures).toEqual([
      {
        provider: 'a',
        model: 'a-model',
        category: 'network_timeout',
        message: 'fetch failed',
      },
      {
        provider: 'b',
        model: 'b-model',
        category: 'malformed_response',
        message: 'provider returned empty response',
      },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('category=network_timeout'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('category=malformed_response'));
    warn.mockRestore();
  });
});

// #1555: completeDetailed preserves the finish reason across the provider chain.
describe('FallbackLlmClient.completeDetailed', () => {
  function detailedClient(provider: string, detail: { text: string | null; finishReason: string | null }): LlmClient {
    return {
      provider,
      model: `${provider}-model`,
      complete: vi.fn(),
      completeDetailed: vi.fn().mockResolvedValue(detail),
    };
  }

  test('returns the first provider whose completion has text', async () => {
    const a = detailedClient('a', { text: null, finishReason: 'length' });
    const b = detailedClient('b', { text: 'A good name', finishReason: 'stop' });
    const fb = new FallbackLlmClient([a, b]);
    await expect(fb.completeDetailed({ maxTokens: 10, userMessage: 'hi' }))
      .resolves.toEqual({ text: 'A good name', finishReason: 'stop' });
  });

  test('preserves the last finish reason when every provider is empty', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = detailedClient('a', { text: null, finishReason: 'length' });
    const b = detailedClient('b', { text: null, finishReason: 'content_filter' });
    const fb = new FallbackLlmClient([a, b]);
    await expect(fb.completeDetailed({ maxTokens: 10, userMessage: 'hi' }))
      .resolves.toEqual({ text: null, finishReason: 'content_filter' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('finish_reason=length'));
    warn.mockRestore();
  });

  test('falls back to complete() for a provider without completeDetailed', async () => {
    const a: LlmClient = { provider: 'a', model: 'a-model', complete: vi.fn().mockResolvedValue('legacy name') };
    const fb = new FallbackLlmClient([a]);
    await expect(fb.completeDetailed({ maxTokens: 10, userMessage: 'hi' }))
      .resolves.toEqual({ text: 'legacy name', finishReason: null });
  });

  test('re-throws AbortError instead of advancing to the next provider', async () => {
    const abortErr = Object.assign(new Error('abort'), { name: 'AbortError' });
    const a: LlmClient = {
      provider: 'a', model: 'a-model', complete: vi.fn(),
      completeDetailed: vi.fn().mockRejectedValue(abortErr),
    };
    const b = detailedClient('b', { text: 'unreached', finishReason: 'stop' });
    const fb = new FallbackLlmClient([a, b]);
    await expect(fb.completeDetailed({ maxTokens: 10, userMessage: 'hi' })).rejects.toMatchObject({ name: 'AbortError' });
    expect(b.completeDetailed).not.toHaveBeenCalled();
  });
});

describe('completeLlmWithFailureAudit', () => {
  test('classifies a single raw provider failure without fallback wrapper', async () => {
    const raw: LlmClient = {
      provider: 'raw',
      model: 'raw-model',
      complete: vi.fn().mockRejectedValue(Object.assign(new Error('invalid api key'), { providerFailureCategory: 'auth' })),
    };

    await expect(completeLlmWithFailureAudit(raw, { maxTokens: 10, userMessage: 'hi' })).resolves.toEqual({
      text: null,
      failureCategory: 'auth',
      failures: [{
        provider: 'raw',
        model: 'raw-model',
        category: 'auth',
        message: 'invalid api key',
      }],
    });
  });

  test('delegates to clients with native failure audit support', async () => {
    const audited: LlmClient = {
      provider: 'audited',
      model: 'audited-model',
      complete: vi.fn(),
      completeWithFailureAudit: vi.fn().mockResolvedValue({
        text: null,
        failures: [{ provider: 'audited', model: 'audited-model', category: 'server_5xx', message: 'bad gateway' }],
        failureCategory: 'server_5xx',
      }),
    };

    const result = await completeLlmWithFailureAudit(audited, { maxTokens: 10, userMessage: 'hi' });

    expect(result.failureCategory).toBe('server_5xx');
    expect(audited.complete).not.toHaveBeenCalled();
    expect(audited.completeWithFailureAudit).toHaveBeenCalledOnce();
  });
});

describe('classifyLlmProviderFailure', () => {
  test('honors explicit provider failure category', () => {
    expect(classifyLlmProviderFailure({ providerFailureCategory: 'server_5xx' })).toBe('server_5xx');
  });

  test('classifies common SDK error shapes', () => {
    expect(classifyLlmProviderFailure({ status: 401, message: 'bad key' })).toBe('auth');
    expect(classifyLlmProviderFailure({ status: 403, message: 'forbidden' })).toBe('auth');
    expect(classifyLlmProviderFailure({ status: 410, message: 'model gone' })).toBe('auth');
    expect(classifyLlmProviderFailure({ statusCode: 410, message: 'Gone' })).toBe('auth');
    expect(classifyLlmProviderFailure({ statusCode: 502, message: 'bad gateway' })).toBe('server_5xx');
    expect(classifyLlmProviderFailure(new Error('504 Gateway Timeout'))).toBe('server_5xx');
    expect(classifyLlmProviderFailure(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }))).toBe('network_timeout');
    expect(classifyLlmProviderFailure(new SyntaxError('Unexpected end of JSON input'))).toBe('malformed_response');
    expect(classifyLlmProviderFailure(new Error('unclassified provider error'))).toBe('other');
  });
});

describe('classifyLlmProviderHttpStatus', () => {
  test('maps 401/403/410 to the auth cooldown class and leaves 404/429 as other', () => {
    expect(classifyLlmProviderHttpStatus(401)).toBe('auth');
    expect(classifyLlmProviderHttpStatus(403)).toBe('auth');
    expect(classifyLlmProviderHttpStatus(410)).toBe('auth');
    expect(classifyLlmProviderHttpStatus(404)).toBe('other');
    expect(classifyLlmProviderHttpStatus(429)).toBe('other');
    expect(classifyLlmProviderHttpStatus(400)).toBe('other');
    expect(classifyLlmProviderHttpStatus(500)).toBe('server_5xx');
  });
});

describe('FallbackLlmClient auth cool-down', () => {
  const originalAuthCooldown = process.env.KOOKR_LLM_AUTH_COOLDOWN_MS;

  function client(provider: string, impl: () => Promise<string | null>) {
    return { provider, model: `${provider}-model`, complete: vi.fn().mockImplementation(impl) };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    process.env.KOOKR_LLM_AUTH_COOLDOWN_MS = '60000';
    resetHelperLlmDiagnosticsForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalAuthCooldown === undefined) {
      delete process.env.KOOKR_LLM_AUTH_COOLDOWN_MS;
    } else {
      process.env.KOOKR_LLM_AUTH_COOLDOWN_MS = originalAuthCooldown;
    }
    resetHelperLlmDiagnosticsForTest();
  });

  test('resolveLlmAuthCooldownMs defaults and validates env', () => {
    expect(resolveLlmAuthCooldownMs({})).toBe(DEFAULT_LLM_AUTH_COOLDOWN_MS);
    expect(resolveLlmAuthCooldownMs({ KOOKR_LLM_AUTH_COOLDOWN_MS: '120000' })).toBe(120_000);
    expect(resolveLlmAuthCooldownMs({ KOOKR_LLM_AUTH_COOLDOWN_MS: '0' })).toBe(0);
    expect(resolveLlmAuthCooldownMs({ KOOKR_LLM_AUTH_COOLDOWN_MS: '-5' })).toBe(DEFAULT_LLM_AUTH_COOLDOWN_MS);
    expect(resolveLlmAuthCooldownMs({ KOOKR_LLM_AUTH_COOLDOWN_MS: 'nope' })).toBe(DEFAULT_LLM_AUTH_COOLDOWN_MS);
  });

  test('after one HTTP 410 Gone subsequent complete() calls skip that provider for the cool-down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const goneErr = Object.assign(new Error('Baseten request failed: 410 Gone - model removed'), { status: 410 });
    const a = client('baseten', async () => { throw goneErr; });
    const b = client('gemini', async () => 'from-gemini');
    const fb = new FallbackLlmClient([a, b]);

    await expect(fb.complete({ maxTokens: 10, userMessage: 'hi' })).resolves.toBe('from-gemini');
    expect(a.complete).toHaveBeenCalledOnce();
    expect(b.complete).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('pausing until'));

    await expect(fb.complete({ maxTokens: 10, userMessage: 'again' })).resolves.toBe('from-gemini');
    expect(a.complete).toHaveBeenCalledOnce();
    expect(b.complete).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped category=auth'));
    expect(getHelperLlmDiagnosticsSnapshot().pausedProviders).toEqual([
      expect.objectContaining({
        provider: 'baseten',
        model: 'baseten-model',
        reason: 'auth',
        skipCount: 1,
        lastMessage: 'Baseten request failed: 410 Gone - model removed',
      }),
    ]);
    warn.mockRestore();
  });

  test('after one auth failure subsequent complete() calls skip that provider for the cool-down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const authErr = Object.assign(new Error('expired_api_key'), { providerFailureCategory: 'auth' });
    const a = client('groq', async () => { throw authErr; });
    const b = client('gemini', async () => 'from-gemini');
    const fb = new FallbackLlmClient([a, b]);

    await expect(fb.complete({ maxTokens: 10, userMessage: 'hi' })).resolves.toBe('from-gemini');
    expect(a.complete).toHaveBeenCalledOnce();
    expect(b.complete).toHaveBeenCalledOnce();

    await expect(fb.complete({ maxTokens: 10, userMessage: 'again' })).resolves.toBe('from-gemini');
    // Second call must not re-hit the auth-failed provider.
    expect(a.complete).toHaveBeenCalledOnce();
    expect(b.complete).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped category=auth'));
    warn.mockRestore();
  });

  test('diagnostics snapshot lists paused providers with skip counts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const authErr = Object.assign(new Error('invalid api key'), { status: 401 });
    const a = client('groq', async () => { throw authErr; });
    const b = client('gemini', async () => 'ok');
    const fb = new FallbackLlmClient([a, b]);

    await fb.complete({ maxTokens: 10, userMessage: '1' });
    await fb.complete({ maxTokens: 10, userMessage: '2' });
    await fb.complete({ maxTokens: 10, userMessage: '3' });

    const snapshot = getHelperLlmDiagnosticsSnapshot();
    expect(snapshot.pausedProviders).toEqual([
      expect.objectContaining({
        provider: 'groq',
        model: 'groq-model',
        reason: 'auth',
        pausedAt: Date.parse('2026-01-01T00:00:00.000Z'),
        pausedUntil: Date.parse('2026-01-01T00:01:00.000Z'),
        remainingMs: 60_000,
        skipCount: 2,
        lastMessage: 'invalid api key',
      }),
    ]);

    const health = getHelperLlmHealthSnapshot();
    expect(health.paused).toEqual([
      {
        provider: 'groq',
        model: 'groq-model',
        category: 'auth',
        pausedUntil: '2026-01-01T00:01:00.000Z',
      },
    ]);
    expect(JSON.stringify(health)).not.toMatch(/invalid api key|sk-|api[_-]?key/i);
    expect(health).not.toHaveProperty('lastMessage');
    expect(health.paused[0]).not.toHaveProperty('lastMessage');
    warn.mockRestore();
  });

  test('non-auth failures do not pause the provider', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = client('groq', async () => {
      throw Object.assign(new Error('bad gateway'), { status: 502 });
    });
    const b = client('gemini', async () => 'ok');
    const fb = new FallbackLlmClient([a, b]);

    await fb.complete({ maxTokens: 10, userMessage: '1' });
    await fb.complete({ maxTokens: 10, userMessage: '2' });

    expect(a.complete).toHaveBeenCalledTimes(2);
    expect(getHelperLlmDiagnosticsSnapshot().pausedProviders).toEqual([]);
    warn.mockRestore();
  });

  test('provider is retried after the cool-down window elapses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let groqCalls = 0;
    const a = client('groq', async () => {
      groqCalls += 1;
      if (groqCalls === 1) {
        throw Object.assign(new Error('expired_api_key'), { providerFailureCategory: 'auth' });
      }
      return 'recovered';
    });
    const b = client('gemini', async () => 'fallback');
    const fb = new FallbackLlmClient([a, b]);

    await expect(fb.complete({ maxTokens: 10, userMessage: '1' })).resolves.toBe('fallback');
    await expect(fb.complete({ maxTokens: 10, userMessage: '2' })).resolves.toBe('fallback');
    expect(a.complete).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(60_001);
    await expect(fb.complete({ maxTokens: 10, userMessage: '3' })).resolves.toBe('recovered');
    expect(a.complete).toHaveBeenCalledTimes(2);
    expect(getHelperLlmDiagnosticsSnapshot().pausedProviders).toEqual([]);
    warn.mockRestore();
  });

  test('KOOKR_LLM_AUTH_COOLDOWN_MS=0 disables pausing', async () => {
    process.env.KOOKR_LLM_AUTH_COOLDOWN_MS = '0';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = client('groq', async () => {
      throw Object.assign(new Error('invalid api key'), { providerFailureCategory: 'auth' });
    });
    const b = client('gemini', async () => 'ok');
    const fb = new FallbackLlmClient([a, b]);

    await fb.complete({ maxTokens: 10, userMessage: '1' });
    await fb.complete({ maxTokens: 10, userMessage: '2' });

    expect(a.complete).toHaveBeenCalledTimes(2);
    expect(getHelperLlmDiagnosticsSnapshot().pausedProviders).toEqual([]);
    warn.mockRestore();
  });

  test('health snapshot collapses two models of one provider to one row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const groqA = {
      provider: 'groq',
      model: 'llama-short',
      complete: vi.fn(async () => {
        throw Object.assign(new Error('invalid api key'), { status: 401 });
      }),
    };
    const groqB = {
      provider: 'groq',
      model: 'llama-long',
      complete: vi.fn(async () => {
        throw Object.assign(new Error('invalid api key'), { status: 401 });
      }),
    };
    const gemini = client('gemini', async () => 'ok');
    const first = new FallbackLlmClient([groqA, gemini]);
    await first.complete({ maxTokens: 10, userMessage: '1' });
    vi.advanceTimersByTime(30_000);
    const second = new FallbackLlmClient([groqB, gemini]);
    await second.complete({ maxTokens: 10, userMessage: '2' });

    const health = getHelperLlmHealthSnapshot();
    expect(health.paused).toEqual([
      {
        provider: 'groq',
        model: 'llama-long',
        category: 'auth',
        pausedUntil: '2026-01-01T00:01:30.000Z',
      },
    ]);
    warn.mockRestore();
  });

  test('health snapshot keeps one row per distinct provider', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const groq = client('groq', async () => {
      throw Object.assign(new Error('invalid api key'), { status: 401 });
    });
    const gemini = client('gemini', async () => {
      throw Object.assign(new Error('invalid api key'), { status: 401 });
    });
    const fallback = client('openrouter', async () => 'ok');
    await new FallbackLlmClient([groq, gemini, fallback]).complete({
      maxTokens: 10,
      userMessage: '1',
    });

    const health = getHelperLlmHealthSnapshot();
    expect(health.paused.map((row) => row.provider)).toEqual(['gemini', 'groq']);
    expect(health.paused.every((row) => row.category === 'auth')).toBe(true);
    warn.mockRestore();
  });

  test('health snapshot is empty when nothing is paused', () => {
    expect(getHelperLlmHealthSnapshot()).toEqual({ paused: [], stormsSuppressed: 0 });
  });

  test('logs clearly when every provider is paused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = client('groq', async () => {
      throw Object.assign(new Error('invalid api key'), { providerFailureCategory: 'auth' });
    });
    const fb = new FallbackLlmClient([a]);

    await expect(fb.complete({ maxTokens: 10, userMessage: '1' })).resolves.toBeNull();
    await expect(fb.complete({ maxTokens: 10, userMessage: '2' })).resolves.toBeNull();

    expect(a.complete).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('all 1 provider(s) paused after auth failures'),
    );
    warn.mockRestore();
  });
});

// #2083: process-wide helper-LLM provider-attempt budget under free-tier 429 storms.
describe('FallbackLlmClient provider attempt budget', () => {
  const originalBudget = process.env.KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET;
  const originalWindow = process.env.KOOKR_LLM_PROVIDER_ATTEMPT_WINDOW_MS;
  const originalAuthCooldown = process.env.KOOKR_LLM_AUTH_COOLDOWN_MS;

  function client(provider: string, impl: () => Promise<string | null>) {
    return { provider, model: `${provider}-model`, complete: vi.fn().mockImplementation(impl) };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    process.env.KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET = '4';
    process.env.KOOKR_LLM_PROVIDER_ATTEMPT_WINDOW_MS = '60000';
    resetHelperLlmDiagnosticsForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalBudget === undefined) delete process.env.KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET;
    else process.env.KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET = originalBudget;
    if (originalWindow === undefined) delete process.env.KOOKR_LLM_PROVIDER_ATTEMPT_WINDOW_MS;
    else process.env.KOOKR_LLM_PROVIDER_ATTEMPT_WINDOW_MS = originalWindow;
    if (originalAuthCooldown === undefined) delete process.env.KOOKR_LLM_AUTH_COOLDOWN_MS;
    else process.env.KOOKR_LLM_AUTH_COOLDOWN_MS = originalAuthCooldown;
    resetHelperLlmDiagnosticsForTest();
  });

  test('resolveLlmProviderAttemptBudget defaults and validates env', () => {
    expect(resolveLlmProviderAttemptBudget({})).toBe(DEFAULT_LLM_PROVIDER_ATTEMPT_BUDGET);
    expect(resolveLlmProviderAttemptBudget({ KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET: '30' })).toBe(30);
    expect(resolveLlmProviderAttemptBudget({ KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET: '0' })).toBe(0);
    expect(resolveLlmProviderAttemptBudget({ KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET: '-1' })).toBe(
      DEFAULT_LLM_PROVIDER_ATTEMPT_BUDGET,
    );
    expect(resolveLlmProviderAttemptBudget({ KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET: 'nope' })).toBe(
      DEFAULT_LLM_PROVIDER_ATTEMPT_BUDGET,
    );
    expect(resolveLlmProviderAttemptWindowMs({})).toBe(DEFAULT_LLM_PROVIDER_ATTEMPT_WINDOW_MS);
    expect(resolveLlmProviderAttemptWindowMs({ KOOKR_LLM_PROVIDER_ATTEMPT_WINDOW_MS: '120000' })).toBe(120_000);
    expect(resolveLlmProviderAttemptWindowMs({ KOOKR_LLM_PROVIDER_ATTEMPT_WINDOW_MS: '0' })).toBe(
      DEFAULT_LLM_PROVIDER_ATTEMPT_WINDOW_MS,
    );
  });

  test('under a synthetic 429 storm, network attempts stay ≤ budget and stormsSuppressed increments', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rateLimit = Object.assign(new Error('RESOURCE_EXHAUSTED'), {
      status: 429,
      providerFailureCategory: 'other' as const,
    });
    // Three providers — each complete() would try up to 3 network calls without a budget.
    const a = client('google', async () => { throw rateLimit; });
    const b = client('groq', async () => { throw rateLimit; });
    const c = client('baseten', async () => { throw rateLimit; });
    const fb = new FallbackLlmClient([a, b, c]);

    // Call 1: 3 attempts (a,b,c). Call 2: 1 attempt (a) then budget full → degrade.
    // Call 3+: zero network.
    await expect(fb.complete({ maxTokens: 10, userMessage: '1' })).resolves.toBeNull();
    await expect(fb.complete({ maxTokens: 10, userMessage: '2' })).resolves.toBeNull();
    await expect(fb.complete({ maxTokens: 10, userMessage: '3' })).resolves.toBeNull();
    await expect(fb.complete({ maxTokens: 10, userMessage: '4' })).resolves.toBeNull();

    const totalNetwork =
      (a.complete as ReturnType<typeof vi.fn>).mock.calls.length
      + (b.complete as ReturnType<typeof vi.fn>).mock.calls.length
      + (c.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(totalNetwork).toBe(4);
    expect(a.complete).toHaveBeenCalledTimes(2);
    expect(b.complete).toHaveBeenCalledOnce();
    expect(c.complete).toHaveBeenCalledOnce();

    const snapshot = getHelperLlmDiagnosticsSnapshot();
    // Call2 mid-chain deny (1) + fully suppressed calls 3 and 4 (2) = 3.
    expect(snapshot.stormsSuppressed).toBe(3);
    expect(getHelperLlmHealthSnapshot().stormsSuppressed).toBe(3);
    expect(snapshot.providerAttemptBudget).toEqual({
      limit: 4,
      windowMs: 60_000,
      attemptsInWindow: 4,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('attempt budget exhausted'));
    warn.mockRestore();
  });

  test('budget window slides and allows new attempts after the window elapses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rateLimit = Object.assign(new Error('429 Too Many Requests'), { status: 429 });
    const a = client('google', async () => { throw rateLimit; });
    const fb = new FallbackLlmClient([a]);

    for (let i = 0; i < 4; i += 1) {
      await fb.complete({ maxTokens: 10, userMessage: `burn-${i}` });
    }
    expect(a.complete).toHaveBeenCalledTimes(4);

    // Budget full — no network.
    await fb.complete({ maxTokens: 10, userMessage: 'blocked' });
    expect(a.complete).toHaveBeenCalledTimes(4);

    vi.advanceTimersByTime(60_001);
    await fb.complete({ maxTokens: 10, userMessage: 'recovered' });
    expect(a.complete).toHaveBeenCalledTimes(5);

    const snapshot = getHelperLlmDiagnosticsSnapshot();
    expect(snapshot.providerAttemptBudget.attemptsInWindow).toBe(1);
    expect(snapshot.stormsSuppressed).toBe(1);
    warn.mockRestore();
  });

  test('deterministic degrade returns null without throwing and records audit failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET = '1';
    const a = client('google', async () => {
      throw Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 });
    });
    const b = client('groq', async () => 'should-not-run');
    const fb = new FallbackLlmClient([a, b]);

    // First call spends the only slot on google (fails), then budget blocks groq.
    const first = await fb.completeWithFailureAudit({ maxTokens: 10, userMessage: '1' });
    expect(first.text).toBeNull();
    expect(a.complete).toHaveBeenCalledOnce();
    expect(b.complete).not.toHaveBeenCalled();
    expect(first.failures.some((f) => f.message.includes('attempt budget exhausted'))).toBe(true);

    // Second call is fully suppressed — no network.
    const second = await fb.completeWithFailureAudit({ maxTokens: 10, userMessage: '2' });
    expect(second.text).toBeNull();
    expect(a.complete).toHaveBeenCalledOnce();
    expect(b.complete).not.toHaveBeenCalled();
    expect(second.failureCategory).toBe('other');
    // First call denied groq (1) + second call denied google (2).
    expect(getHelperLlmDiagnosticsSnapshot().stormsSuppressed).toBe(2);
    warn.mockRestore();
  });

  test('process-wide budget is shared across FallbackLlmClient instances', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET = '3';
    const rateLimit = Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 });
    const a = client('google', async () => { throw rateLimit; });
    const b = client('groq', async () => { throw rateLimit; });
    const c = client('baseten', async () => { throw rateLimit; });
    const d = client('openrouter', async () => { throw rateLimit; });
    const fb1 = new FallbackLlmClient([a, b]);
    const fb2 = new FallbackLlmClient([c, d]);

    await fb1.complete({ maxTokens: 10, userMessage: 'from-1' }); // a,b → 2
    await fb2.complete({ maxTokens: 10, userMessage: 'from-2' }); // c only (3rd), d denied

    const totalNetwork =
      (a.complete as ReturnType<typeof vi.fn>).mock.calls.length
      + (b.complete as ReturnType<typeof vi.fn>).mock.calls.length
      + (c.complete as ReturnType<typeof vi.fn>).mock.calls.length
      + (d.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(totalNetwork).toBe(3);
    expect(d.complete).not.toHaveBeenCalled();
    expect(getHelperLlmDiagnosticsSnapshot().stormsSuppressed).toBe(1);
    expect(getHelperLlmDiagnosticsSnapshot().providerAttemptBudget.attemptsInWindow).toBe(3);
    warn.mockRestore();
  });

  test('auth-paused providers do not burn attempt budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET = '2';
    process.env.KOOKR_LLM_AUTH_COOLDOWN_MS = '60000';
    const authErr = Object.assign(new Error('expired_api_key'), { providerFailureCategory: 'auth' as const });
    const rateLimit = Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 });
    const a = client('groq', async () => { throw authErr; });
    const b = client('google', async () => { throw rateLimit; });
    const fb = new FallbackLlmClient([a, b]);

    // Call 1: groq auth-fails (burns 1 attempt + pause), google 429 (burns 2nd).
    await fb.complete({ maxTokens: 10, userMessage: '1' });
    expect(a.complete).toHaveBeenCalledOnce();
    expect(b.complete).toHaveBeenCalledOnce();

    // Call 2: groq is auth-paused (no acquire), google denied by budget.
    await fb.complete({ maxTokens: 10, userMessage: '2' });
    expect(a.complete).toHaveBeenCalledOnce(); // still only the first hit
    expect(b.complete).toHaveBeenCalledOnce(); // budget blocked second hit

    const snapshot = getHelperLlmDiagnosticsSnapshot();
    expect(snapshot.providerAttemptBudget.attemptsInWindow).toBe(2);
    expect(snapshot.stormsSuppressed).toBe(1);
    expect(snapshot.pausedProviders).toEqual([
      expect.objectContaining({ provider: 'groq', reason: 'auth' }),
    ]);
    warn.mockRestore();
  });

  test('KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET=0 disables the budget', async () => {
    process.env.KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET = '0';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = client('google', async () => {
      throw Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 });
    });
    const fb = new FallbackLlmClient([a]);

    for (let i = 0; i < 10; i += 1) {
      await fb.complete({ maxTokens: 10, userMessage: String(i) });
    }
    expect(a.complete).toHaveBeenCalledTimes(10);
    expect(getHelperLlmDiagnosticsSnapshot().stormsSuppressed).toBe(0);
    expect(getHelperLlmDiagnosticsSnapshot().providerAttemptBudget.limit).toBe(0);
    warn.mockRestore();
  });

  test('completeDetailed also honors the attempt budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET = '1';
    const a: LlmClient = {
      provider: 'google',
      model: 'google-model',
      complete: vi.fn(),
      completeDetailed: vi.fn().mockRejectedValue(
        Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 }),
      ),
    };
    const b: LlmClient = {
      provider: 'groq',
      model: 'groq-model',
      complete: vi.fn(),
      completeDetailed: vi.fn().mockResolvedValue({ text: 'never', finishReason: 'stop' }),
    };
    const fb = new FallbackLlmClient([a, b]);

    await expect(fb.completeDetailed({ maxTokens: 10, userMessage: '1' }))
      .resolves.toEqual({ text: null, finishReason: null });
    expect(a.completeDetailed).toHaveBeenCalledOnce();
    expect(b.completeDetailed).not.toHaveBeenCalled();

    await expect(fb.completeDetailed({ maxTokens: 10, userMessage: '2' }))
      .resolves.toEqual({ text: null, finishReason: null });
    expect(a.completeDetailed).toHaveBeenCalledOnce();
    expect(b.completeDetailed).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// #2640: helper-LLM fallback warns must not dump provider HTTP bodies into server.log.
const GEMINI_429_BODY = [
  'got status: 429 RESOURCE_EXHAUSTED. ',
  '{"error":{"code":429,"message":"You exceeded your current quota.",',
  '"quotaMetric":"generativelanguage.googleapis.com/generate_content_free_tier_requests",',
  '"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure",',
  '"violations":[{"subject":"project:kookr-dev-482913",',
  '"description":"Quota exceeded for consumer project_number:482913."}]}]}}',
].join('');

const GROQ_401_BODY = '401 {"error":{"message":"Invalid API Key","type":"invalid_request_error","code":"invalid_api_key"}}';

const GEMINI_410_BODY = [
  '410 Gone {"error":{"message":"model gemini-1.5-pro-002 is not found or retired",',
  '"status":"NOT_FOUND","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo",',
  '"metadata":{"model":"gemini-1.5-pro-002","project":"kookr-dev-482913"}}]}}',
].join('');

const GEMINI_LEAK_MARKERS = [
  'generativelanguage.googleapis.com/generate_content_free_tier_requests',
  'project:kookr-dev-482913',
  'project_number:482913',
  '"error":{',
];

const GROQ_LEAK_MARKERS = [
  'invalid_api_key',
  '"error":{',
  'Invalid API Key',
];

describe('helper LLM failure log redaction', () => {
  const originalAuthCooldown = process.env.KOOKR_LLM_AUTH_COOLDOWN_MS;
  const originalBudget = process.env.KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET;

  function client(provider: string, impl: () => Promise<string | null>) {
    return { provider, model: `${provider}-model`, complete: vi.fn().mockImplementation(impl) };
  }

  function loggedWarns(warn: ReturnType<typeof vi.spyOn>): string[] {
    return warn.mock.calls.map((args) => args.map((arg) => String(arg)).join(' '));
  }

  afterEach(() => {
    setLoggerRuntimeLevelGetter(() => 'info');
    vi.useRealTimers();
    if (originalAuthCooldown === undefined) delete process.env.KOOKR_LLM_AUTH_COOLDOWN_MS;
    else process.env.KOOKR_LLM_AUTH_COOLDOWN_MS = originalAuthCooldown;
    if (originalBudget === undefined) delete process.env.KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET;
    else process.env.KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET = originalBudget;
    resetHelperLlmDiagnosticsForTest();
  });

  test('summarizeLlmFailureForLog keeps status and category without the HTTP body', () => {
    const gemini = summarizeLlmFailureForLog(
      { provider: 'google', model: 'gemini-2.0-flash', category: 'other', message: GEMINI_429_BODY },
      Object.assign(new Error(GEMINI_429_BODY), { status: 429 }),
    );
    expect(gemini).toEqual({ status: 429, reason: 'rate limited' });
    expect(gemini.reason).not.toMatch(/generativelanguage|project_number|kookr-dev/);

    const groq = summarizeLlmFailureForLog(
      { provider: 'groq', model: 'llama-4-scout', category: 'auth', message: GROQ_401_BODY },
      Object.assign(new Error(GROQ_401_BODY), { status: 401 }),
    );
    expect(groq).toEqual({ status: 401, reason: 'unauthorized' });
    expect(groq.reason).not.toContain('{');
    expect(groq.reason).not.toContain('invalid_api_key');

    const gone = summarizeLlmFailureForLog(
      { provider: 'google', model: 'gemini-1.5-pro-002', category: 'other', message: GEMINI_410_BODY },
      Object.assign(new Error(GEMINI_410_BODY), { status: 410 }),
    );
    expect(gone).toEqual({ status: 410, reason: 'gone' });

    const requesty = summarizeLlmFailureForLog(
      {
        provider: 'requesty',
        model: 'openai/gpt-4o-mini',
        category: 'other',
        message: `Requesty request failed: 429 Too Many Requests - ${GEMINI_429_BODY}`,
      },
    );
    expect(requesty).toEqual({ status: 429, reason: 'rate limited' });
  });

  test('a Gemini 429 fixture logged through the fallback path has no quota-metric or project identifiers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const geminiErr = Object.assign(new Error(GEMINI_429_BODY), { status: 429 });
    const a = client('google', async () => { throw geminiErr; });
    const b = client('groq', async () => 'ok');
    const fb = new FallbackLlmClient([a, b]);

    const result = await fb.completeWithFailureAudit({ maxTokens: 10, userMessage: 'name this' });

    expect(result.text).toBe('ok');
    expect(result.failures[0]).toEqual({
      provider: 'google',
      model: 'google-model',
      category: 'other',
      message: GEMINI_429_BODY,
    });

    const lines = loggedWarns(warn);
    expect(lines.some((line) => line.includes('category=other') && line.includes('status=429'))).toBe(true);
    expect(lines.some((line) => line.includes('rate limited'))).toBe(true);
    for (const line of lines) {
      for (const marker of GEMINI_LEAK_MARKERS) {
        expect(line).not.toContain(marker);
      }
    }
    expect(debug).not.toHaveBeenCalled();
    warn.mockRestore();
    debug.mockRestore();
  });

  test('a Groq 401 fixture logged through the fallback path has no raw error JSON', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const groqErr = Object.assign(new Error(GROQ_401_BODY), { status: 401 });
    const a = client('groq', async () => { throw groqErr; });
    const b = client('google', async () => 'ok');
    const fb = new FallbackLlmClient([a, b]);

    await expect(fb.complete({ maxTokens: 10, userMessage: 'name this' })).resolves.toBe('ok');

    const lines = loggedWarns(warn);
    expect(lines.some((line) => line.includes('category=auth') && line.includes('status=401'))).toBe(true);
    expect(lines.some((line) => line.includes('unauthorized'))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain(GROQ_401_BODY);
      for (const marker of GROQ_LEAK_MARKERS) {
        expect(line).not.toContain(marker);
      }
    }
    warn.mockRestore();
  });

  test('a 410 fixture logged through completeDetailed keeps status without the body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const goneErr = Object.assign(new Error(GEMINI_410_BODY), { status: 410 });
    const a: LlmClient = {
      provider: 'google',
      model: 'google-model',
      complete: vi.fn(),
      completeDetailed: vi.fn().mockRejectedValue(goneErr),
    };
    const b: LlmClient = {
      provider: 'groq',
      model: 'groq-model',
      complete: vi.fn(),
      completeDetailed: vi.fn().mockResolvedValue({ text: 'ok', finishReason: 'stop' }),
    };
    const fb = new FallbackLlmClient([a, b]);

    await expect(fb.completeDetailed({ maxTokens: 10, userMessage: 'hi' }))
      .resolves.toEqual({ text: 'ok', finishReason: 'stop' });

    const lines = loggedWarns(warn);
    expect(lines.some((line) => line.includes('status=410') && line.includes('gone'))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain('kookr-dev-482913');
      expect(line).not.toContain('"error"');
    }
    warn.mockRestore();
  });

  test('debug log level still records the raw provider body on console.debug', async () => {
    setLoggerRuntimeLevelGetter(() => 'debug');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const groqErr = Object.assign(new Error(GROQ_401_BODY), { status: 401 });
    const a = client('groq', async () => { throw groqErr; });
    const b = client('google', async () => 'ok');
    const fb = new FallbackLlmClient([a, b]);

    await fb.complete({ maxTokens: 10, userMessage: 'hi' });

    expect(loggedWarns(warn).join('\n')).not.toContain(GROQ_401_BODY);
    expect(debug).toHaveBeenCalledWith(expect.stringContaining(GROQ_401_BODY));
    warn.mockRestore();
    debug.mockRestore();
    setLoggerRuntimeLevelGetter(() => 'info');
  });

  test('auth-pause and attempt-budget still fire after a leaking HTTP body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.KOOKR_LLM_AUTH_COOLDOWN_MS = '60000';
    process.env.KOOKR_LLM_PROVIDER_ATTEMPT_BUDGET = '2';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const groqErr = Object.assign(new Error(GROQ_401_BODY), { status: 401 });
    const rateLimit = Object.assign(new Error(GEMINI_429_BODY), { status: 429 });
    const a = client('groq', async () => { throw groqErr; });
    const b = client('google', async () => { throw rateLimit; });
    const fb = new FallbackLlmClient([a, b]);

    await fb.complete({ maxTokens: 10, userMessage: '1' });
    await fb.complete({ maxTokens: 10, userMessage: '2' });

    expect(a.complete).toHaveBeenCalledOnce();
    expect(b.complete).toHaveBeenCalledOnce();
    const snapshot = getHelperLlmDiagnosticsSnapshot();
    expect(snapshot.pausedProviders).toEqual([
      expect.objectContaining({ provider: 'groq', reason: 'auth', skipCount: 1 }),
    ]);
    expect(snapshot.stormsSuppressed).toBe(1);
    const lines = loggedWarns(warn);
    expect(lines.some((line) => line.includes('skipped category=auth'))).toBe(true);
    expect(lines.some((line) => line.includes('attempt budget exhausted'))).toBe(true);
    for (const line of lines) {
      for (const marker of [...GEMINI_LEAK_MARKERS, ...GROQ_LEAK_MARKERS]) {
        expect(line).not.toContain(marker);
      }
    }
    warn.mockRestore();
  });
});
