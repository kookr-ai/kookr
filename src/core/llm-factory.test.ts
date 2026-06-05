import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createLlmClient, FallbackLlmClient, readLlmProvider } from './llm-factory.js';
import type { LlmClient } from './llm-types.js';

const created = vi.hoisted(() => ({
  groq: [] as string[],
  google: [] as string[],
  anthropic: [] as string[],
  openrouter: [] as string[],
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

describe('createLlmClient', () => {
  beforeEach(() => {
    clearEnv();
    created.groq = [];
    created.google = [];
    created.anthropic = [];
    created.openrouter = [];
  });

  afterEach(() => {
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

    const client = await createLlmClient({ buildOpenRouter: buildOpenRouter() });

    expect(client).toBeInstanceOf(FallbackLlmClient);
    expect(client?.provider).toBe('groq > google > anthropic > openrouter');
    expect(created.openrouter).toEqual(['openrouter-model']);
  });

  test('uses OpenRouter alone when it is the only configured provider builder', async () => {
    const client = await createLlmClient({ buildOpenRouter: buildOpenRouter() });

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

    const client = await createLlmClient({ buildOpenRouter: buildOpenRouter() });

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

  test('an unknown KOOKR_LLM_PROVIDER falls back to auto selection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.KOOKR_LLM_PROVIDER = 'bogus';
    process.env.GROQ_API_KEY = 'groq-key';

    const client = await createLlmClient();

    expect(client?.provider).toBe('groq');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Unknown KOOKR_LLM_PROVIDER'));
    warn.mockRestore();
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

  test('returns auto for an unrecognized value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.KOOKR_LLM_PROVIDER = 'mistral';
    expect(readLlmProvider()).toBe('auto');
    warn.mockRestore();
  });
});
