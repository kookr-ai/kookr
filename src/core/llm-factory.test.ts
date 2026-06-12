import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  classifyLlmProviderFailure,
  completeLlmWithFailureAudit,
  createLlmClient,
  FallbackLlmClient,
  getHelperLlmDiagnosticsSnapshot,
  readLlmProvider,
  resetHelperLlmDiagnosticsForTest,
  withHelperLlmAccounting,
} from './llm-factory.js';
import type { LlmClient } from './llm-types.js';

const created = vi.hoisted(() => ({
  groq: [] as string[],
  google: [] as string[],
  anthropic: [] as string[],
  openrouter: [] as string[],
  requesty: [] as string[],
}));

vi.mock('./groq-client.js', () => ({
  GroqLlmClient: class {
    readonly provider = 'groq';
    readonly model = 'groq-model';

    constructor(apiKey: string) {
      created.groq.push(apiKey);
    }

    async complete(): Promise<string | null> {
      return null;
    }
  },
}));

vi.mock('./google-client.js', () => ({
  GoogleLlmClient: class {
    readonly provider = 'google';
    readonly model = 'google-model';

    constructor(apiKey: string) {
      created.google.push(apiKey);
    }

    async complete(): Promise<string | null> {
      return null;
    }
  },
}));

vi.mock('./anthropic-client.js', () => ({
  AnthropicLlmClient: class {
    readonly provider = 'anthropic';
    readonly model = 'anthropic-model';

    constructor(apiKey: string) {
      created.anthropic.push(apiKey);
    }

    async complete(): Promise<string | null> {
      return null;
    }
  },
}));

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

function buildOpenRouter(model = 'openrouter-model'): () => LlmClient {
  return () => {
    created.openrouter.push(model);
    return {
      provider: 'openrouter',
      model,
      async complete(): Promise<string | null> {
        return null;
      },
    };
  };
}

function buildRequesty(model = 'requesty-model'): () => LlmClient {
  return () => {
    created.requesty.push(model);
    return {
      provider: 'requesty',
      model,
      async complete(): Promise<string | null> {
        return null;
      },
    };
  };
}

describe('createLlmClient', () => {
  beforeEach(() => {
    clearEnv();
    created.groq = [];
    created.google = [];
    created.anthropic = [];
    created.openrouter = [];
    created.requesty = [];
  });

  afterEach(() => {
    resetHelperLlmDiagnosticsForTest();
    clearEnv();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
  });

  test('returns null when no provider API keys are configured', async () => {
    await expect(createLlmClient()).resolves.toBeNull();
  });

  test('returns the single configured provider directly', async () => {
    process.env.GROQ_API_KEY = ' groq-key ';

    const client = await createLlmClient();

    expect(client?.provider).toBe('groq');
    expect(client).not.toBeInstanceOf(FallbackLlmClient);
    expect(created.groq).toEqual(['groq-key']);
  });

  test('chains configured providers in fallback priority order', async () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';
    process.env.GEMINI_API_KEY = 'gemini-key';
    process.env.GROQ_API_KEY = 'groq-key';

    const client = await createLlmClient();

    expect(client).toBeInstanceOf(FallbackLlmClient);
    expect(client?.provider).toBe('groq > google > anthropic');
    expect(created.groq).toEqual(['groq-key']);
    expect(created.google).toEqual(['gemini-key']);
    expect(created.anthropic).toEqual(['anthropic-key']);
  });

  test('ignores blank provider API keys', async () => {
    process.env.GROQ_API_KEY = '   ';
    process.env.GEMINI_API_KEY = 'gemini-key';

    const client = await createLlmClient();

    expect(client?.provider).toBe('google');
    expect(created.groq).toEqual([]);
    expect(created.google).toEqual(['gemini-key']);
  });

  test('appends OpenRouter last in the auto fallback chain', async () => {
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.GEMINI_API_KEY = 'gemini-key';
    process.env.ANTHROPIC_API_KEY = 'anthropic-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';

    const client = await createLlmClient({ buildOpenRouter: buildOpenRouter(), buildRequesty: buildRequesty() });

    expect(client).toBeInstanceOf(FallbackLlmClient);
    expect(client?.provider).toBe('groq > google > anthropic > openrouter');
    expect(created.openrouter).toEqual(['openrouter-model']);
  });

  test('does not include Requesty in the auto fallback chain', async () => {
    process.env.REQUESTY_API_KEY = 'requesty-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';

    const client = await createLlmClient({ buildOpenRouter: buildOpenRouter(), buildRequesty: buildRequesty() });

    expect(client?.provider).toBe('openrouter');
    expect(created.requesty).toEqual([]);
    expect(created.openrouter).toEqual(['openrouter-model']);
  });

  test('uses OpenRouter alone when it is the only configured provider builder', async () => {
    const client = await createLlmClient({ buildOpenRouter: buildOpenRouter(), buildRequesty: buildRequesty() });

    expect(client?.provider).toBe('openrouter');
    expect(client).not.toBeInstanceOf(FallbackLlmClient);
  });

  test('does not construct OpenRouter unless the adapter builder is provided', async () => {
    process.env.OPENROUTER_API_KEY = 'shared-key';

    const client = await createLlmClient();

    expect(client).toBeNull();
    expect(created.openrouter).toEqual([]);
  });

  test('explicit KOOKR_LLM_PROVIDER=openrouter ignores other configured providers', async () => {
    process.env.KOOKR_LLM_PROVIDER = 'openrouter';
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.OPENROUTER_API_KEY = 'or-key';

    const client = await createLlmClient({ buildOpenRouter: buildOpenRouter(), buildRequesty: buildRequesty() });

    expect(client?.provider).toBe('openrouter');
    expect(client).not.toBeInstanceOf(FallbackLlmClient);
    expect(created.groq).toEqual([]);
  });

  test('explicit KOOKR_LLM_PROVIDER=groq ignores OpenRouter even when its key is set', async () => {
    process.env.KOOKR_LLM_PROVIDER = 'groq';
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.OPENROUTER_API_KEY = 'or-key';

    const client = await createLlmClient();

    expect(client?.provider).toBe('groq');
    expect(created.openrouter).toEqual([]);
  });

  test('explicit KOOKR_LLM_PROVIDER=requesty uses Requesty only', async () => {
    process.env.KOOKR_LLM_PROVIDER = 'requesty';
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.KOOKR_REQUESTY_API_KEY = ' requesty-key ';
    process.env.KOOKR_REQUESTY_MODEL = ' openai/gpt-4o ';
    process.env.OPENROUTER_API_KEY = 'or-key';

    const client = await createLlmClient({ buildOpenRouter: buildOpenRouter(), buildRequesty: buildRequesty() });

    expect(client?.provider).toBe('requesty');
    expect(client?.model).toBe('requesty-model');
    expect(created.requesty).toEqual(['requesty-model']);
    expect(created.groq).toEqual([]);
    expect(created.openrouter).toEqual([]);
  });

  test('explicit Requesty provider ignores OpenRouter key variables', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.KOOKR_LLM_PROVIDER = 'requesty';
    process.env.KOOKR_OPENROUTER_API_KEY = 'or-key';
    process.env.OPENROUTER_API_KEY = 'shared-or-key';

    await expect(createLlmClient({ buildOpenRouter: buildOpenRouter(), buildRequesty: () => null })).resolves.toBeNull();
    expect(created.requesty).toEqual([]);
    expect(created.openrouter).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no API key is configured'));
    warn.mockRestore();
  });

  test('explicit provider with no API key returns null and warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.KOOKR_LLM_PROVIDER = 'openrouter';

    await expect(createLlmClient({ buildOpenRouter: () => null })).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no API key is configured'));
    warn.mockRestore();
  });

  test('explicit OpenRouter provider without an adapter builder warns clearly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.KOOKR_LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'or-key';

    await expect(createLlmClient()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('provider adapter is not configured'));
    warn.mockRestore();
  });

  test('explicit provider selection is case-insensitive', async () => {
    process.env.KOOKR_LLM_PROVIDER = 'OpenRouter';
    process.env.OPENROUTER_API_KEY = 'or-key';

    const client = await createLlmClient({ buildOpenRouter: buildOpenRouter() });

    expect(client?.provider).toBe('openrouter');
  });

  test('explicit Requesty selection is case-insensitive', async () => {
    process.env.KOOKR_LLM_PROVIDER = ' Requesty ';
    process.env.REQUESTY_API_KEY = 'requesty-key';

    const client = await createLlmClient({ buildRequesty: buildRequesty() });

    expect(client?.provider).toBe('requesty');
    expect(created.requesty).toEqual(['requesty-model']);
  });

  test('an unknown KOOKR_LLM_PROVIDER falls back to auto selection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.KOOKR_LLM_PROVIDER = 'bogus';
    process.env.GROQ_API_KEY = 'groq-key';

    const client = await createLlmClient();

    expect(client?.provider).toBe('groq');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unknown KOOKR_LLM_PROVIDER'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('requesty'));
    warn.mockRestore();
  });
});

describe('helper LLM accounting', () => {
  beforeEach(() => {
    clearEnv();
    created.groq = [];
    created.google = [];
    created.anthropic = [];
    created.openrouter = [];
    created.requesty = [];
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

  test('createLlmClient wraps each fallback provider so provider-level attempts are counted', async () => {
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';
    const client = await createLlmClient({
      buildOpenRouter: () => ({
        provider: 'openrouter',
        model: 'openrouter-model',
        complete: vi.fn().mockResolvedValue('fallback answer'),
      }),
    });

    await expect(client!.complete({ useCase: 'criteria_verdict', maxTokens: 10, userMessage: 'hi' })).resolves.toBe('fallback answer');

    const attempts = getHelperLlmDiagnosticsSnapshot().byUseCaseProvider;
    expect(attempts).toEqual([
      expect.objectContaining({
        useCase: 'criteria_verdict',
        provider: 'groq',
        model: 'groq-model',
        nullResponseCount: 1,
      }),
      expect.objectContaining({
        useCase: 'criteria_verdict',
        provider: 'openrouter',
        model: 'openrouter-model',
        successCount: 1,
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

describe('readLlmProvider', () => {
  const original = process.env.KOOKR_LLM_PROVIDER;
  afterEach(() => {
    if (original === undefined) delete process.env.KOOKR_LLM_PROVIDER;
    else process.env.KOOKR_LLM_PROVIDER = original;
  });

  test('defaults to auto when unset', () => {
    delete process.env.KOOKR_LLM_PROVIDER;
    expect(readLlmProvider()).toBe('auto');
  });

  test('normalizes a recognized provider', () => {
    process.env.KOOKR_LLM_PROVIDER = '  ANTHROPIC ';
    expect(readLlmProvider()).toBe('anthropic');
  });

  test('normalizes requesty provider', () => {
    process.env.KOOKR_LLM_PROVIDER = '  REQUESTY ';
    expect(readLlmProvider()).toBe('requesty');
  });

  test('returns auto for an unrecognized value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.KOOKR_LLM_PROVIDER = 'mistral';
    expect(readLlmProvider()).toBe('auto');
    warn.mockRestore();
  });
});
