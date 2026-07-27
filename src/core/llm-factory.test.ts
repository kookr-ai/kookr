import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  classifyLlmProviderFailure,
  completeLlmWithFailureAudit,
  FallbackLlmClient,
  getHelperLlmDiagnosticsSnapshot,
  resetHelperLlmDiagnosticsForTest,
  withHelperLlmAccounting,
} from './llm-factory.js';
import type { LlmClient } from './llm-types.js';

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
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

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
    expect(classifyLlmProviderFailure({ statusCode: 502, message: 'bad gateway' })).toBe('server_5xx');
    expect(classifyLlmProviderFailure(new Error('504 Gateway Timeout'))).toBe('server_5xx');
    expect(classifyLlmProviderFailure(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }))).toBe('network_timeout');
    expect(classifyLlmProviderFailure(new SyntaxError('Unexpected end of JSON input'))).toBe('malformed_response');
    expect(classifyLlmProviderFailure(new Error('unclassified provider error'))).toBe('other');
  });
});
