import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createLlmClient, FallbackLlmClient, readLlmProvider } from './llm-factory.js';

const created = vi.hoisted(() => ({
  groq: [] as string[],
  google: [] as string[],
  anthropic: [] as string[],
  openrouter: [] as Array<{
    apiKey: string;
    model?: string;
    baseUrl?: string;
    httpReferer?: string;
    appTitle?: string;
    timeoutMs?: number;
  }>,
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

vi.mock('./openrouter-client.js', () => ({
  OpenRouterLlmClient: class {
    readonly provider = 'openrouter';
    readonly model: string;

    constructor(options: {
      apiKey: string;
      model?: string;
      baseUrl?: string;
      httpReferer?: string;
      appTitle?: string;
      timeoutMs?: number;
    }) {
      created.openrouter.push(options);
      this.model = options.model ?? 'openrouter-model';
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

    const client = await createLlmClient();

    expect(client).toBeInstanceOf(FallbackLlmClient);
    expect(client?.provider).toBe('groq > google > anthropic > openrouter');
    expect(created.openrouter).toEqual([{ apiKey: 'openrouter-key' }]);
  });

  test('uses OpenRouter alone when it is the only configured provider', async () => {
    process.env.KOOKR_OPENROUTER_API_KEY = 'or-key';

    const client = await createLlmClient();

    expect(client?.provider).toBe('openrouter');
    expect(client).not.toBeInstanceOf(FallbackLlmClient);
  });

  test('prefers KOOKR_OPENROUTER_API_KEY over OPENROUTER_API_KEY', async () => {
    process.env.KOOKR_OPENROUTER_API_KEY = 'component-key';
    process.env.OPENROUTER_API_KEY = 'shared-key';

    await createLlmClient();

    expect(created.openrouter).toEqual([{ apiKey: 'component-key' }]);
  });

  test('falls back to OPENROUTER_API_KEY when the component key is unset', async () => {
    process.env.OPENROUTER_API_KEY = 'shared-key';

    await createLlmClient();

    expect(created.openrouter).toEqual([{ apiKey: 'shared-key' }]);
  });

  test('falls back to OPENROUTER_API_KEY when the component key is blank', async () => {
    process.env.KOOKR_OPENROUTER_API_KEY = '   ';
    process.env.OPENROUTER_API_KEY = 'shared-key';

    await createLlmClient();

    expect(created.openrouter).toEqual([{ apiKey: 'shared-key' }]);
  });

  test('passes OpenRouter model and base URL overrides through', async () => {
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.KOOKR_LLM_MODEL = 'deepseek/deepseek-v4-flash';
    process.env.KOOKR_LLM_BASE_URL = 'https://openrouter.ai/api/v1';

    const client = await createLlmClient();

    expect(created.openrouter[0]).toMatchObject({
      apiKey: 'or-key',
      model: 'deepseek/deepseek-v4-flash',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(client?.model).toBe('deepseek/deepseek-v4-flash');
  });

  test('forwards OpenRouter attribution headers from env', async () => {
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.KOOKR_LLM_HTTP_REFERER = 'https://kookr.example';
    process.env.KOOKR_LLM_APP_TITLE = 'Kookr Prod';

    await createLlmClient();

    expect(created.openrouter[0]).toMatchObject({
      httpReferer: 'https://kookr.example',
      appTitle: 'Kookr Prod',
    });
  });

  test('forwards a valid KOOKR_LLM_TIMEOUT_MS to the OpenRouter client', async () => {
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.KOOKR_LLM_TIMEOUT_MS = '30000';

    await createLlmClient();

    expect(created.openrouter[0]).toMatchObject({ timeoutMs: 30_000 });
  });

  test('trims surrounding whitespace from KOOKR_LLM_TIMEOUT_MS', async () => {
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.KOOKR_LLM_TIMEOUT_MS = '  30000  ';

    await createLlmClient();

    expect(created.openrouter[0]).toMatchObject({ timeoutMs: 30_000 });
  });

  test('leaves timeoutMs unset when KOOKR_LLM_TIMEOUT_MS is not configured', async () => {
    process.env.OPENROUTER_API_KEY = 'or-key';

    await createLlmClient();

    expect(created.openrouter[0].timeoutMs).toBeUndefined();
  });

  test('ignores a non-numeric or non-positive KOOKR_LLM_TIMEOUT_MS', async () => {
    process.env.OPENROUTER_API_KEY = 'or-key';

    for (const bad of ['not-a-number', '0', '-500', '  ']) {
      created.openrouter = [];
      process.env.KOOKR_LLM_TIMEOUT_MS = bad;
      await createLlmClient();
      expect(created.openrouter[0].timeoutMs).toBeUndefined();
    }
  });

  test('explicit KOOKR_LLM_PROVIDER=openrouter ignores other configured providers', async () => {
    process.env.KOOKR_LLM_PROVIDER = 'openrouter';
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.OPENROUTER_API_KEY = 'or-key';

    const client = await createLlmClient();

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

    await expect(createLlmClient()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no API key is configured'));
    warn.mockRestore();
  });

  test('explicit provider selection is case-insensitive', async () => {
    process.env.KOOKR_LLM_PROVIDER = 'OpenRouter';
    process.env.OPENROUTER_API_KEY = 'or-key';

    const client = await createLlmClient();

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
