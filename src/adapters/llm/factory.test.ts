import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  FallbackLlmClient,
  getHelperLlmDiagnosticsSnapshot,
  resetHelperLlmDiagnosticsForTest,
} from '../../core/llm-factory.js';
import type { LlmClient } from '../../core/llm-types.js';
import { createLlmClient, readLlmProvider } from './factory.js';
import { createOpenRouterLlmClientFromEnv } from './openrouter-client.js';
import { createRequestyLlmClientFromEnv } from './requesty-client.js';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const created = vi.hoisted(() => ({
  groq: [] as string[],
  google: [] as string[],
  anthropic: [] as string[],
  openrouter: [] as string[],
  requesty: [] as string[],
  baseten: [] as string[],
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
  'KOOKR_BASETEN_API_KEY',
  'BASETEN_API_KEY',
  'KOOKR_BASETEN_MODEL',
  'KOOKR_BASETEN_BASE_URL',
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

function buildBaseten(model = 'baseten-model'): () => LlmClient {
  return () => {
    created.baseten.push(model);
    return {
      provider: 'baseten',
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
    created.baseten = [];
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

  test('does not include Baseten in the auto fallback chain', async () => {
    process.env.BASETEN_API_KEY = 'baseten-key';
    process.env.OPENROUTER_API_KEY = 'openrouter-key';

    const client = await createLlmClient({ buildOpenRouter: buildOpenRouter(), buildBaseten: buildBaseten() });

    expect(client?.provider).toBe('openrouter');
    expect(created.baseten).toEqual([]);
    expect(created.openrouter).toEqual(['openrouter-model']);
  });

  test('explicit KOOKR_LLM_PROVIDER=baseten uses Baseten only', async () => {
    process.env.KOOKR_LLM_PROVIDER = 'baseten';
    process.env.GROQ_API_KEY = 'groq-key';
    process.env.KOOKR_BASETEN_API_KEY = ' baseten-key ';
    process.env.OPENROUTER_API_KEY = 'or-key';

    const client = await createLlmClient({ buildOpenRouter: buildOpenRouter(), buildBaseten: buildBaseten() });

    expect(client?.provider).toBe('baseten');
    expect(client?.model).toBe('baseten-model');
    expect(created.baseten).toEqual(['baseten-model']);
    expect(created.groq).toEqual([]);
    expect(created.openrouter).toEqual([]);
  });

  test('explicit Baseten selection is case-insensitive', async () => {
    process.env.KOOKR_LLM_PROVIDER = ' Baseten ';
    process.env.BASETEN_API_KEY = 'baseten-key';

    const client = await createLlmClient({ buildBaseten: buildBaseten() });

    expect(client?.provider).toBe('baseten');
    expect(created.baseten).toEqual(['baseten-model']);
  });

  test('explicit Baseten provider without an adapter builder warns clearly', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.KOOKR_LLM_PROVIDER = 'baseten';
    process.env.BASETEN_API_KEY = 'baseten-key';

    await expect(createLlmClient()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('provider adapter is not configured'));
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

describe('createLlmClient real adapter builders', () => {
  beforeEach(() => {
    clearEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetHelperLlmDiagnosticsForTest();
    clearEnv();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
  });

  test('explicit Requesty provider uses only the real Requesty env builder', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: ' requesty-ok ' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.KOOKR_LLM_PROVIDER = 'requesty';
    process.env.KOOKR_REQUESTY_API_KEY = ' req-key ';
    process.env.KOOKR_REQUESTY_MODEL = ' openai/gpt-4o-mini ';
    process.env.KOOKR_OPENROUTER_API_KEY = 'or-key';
    process.env.OPENROUTER_API_KEY = 'shared-or-key';
    process.env.GROQ_API_KEY = 'groq-key';

    const client = await createLlmClient({
      buildOpenRouter: createOpenRouterLlmClientFromEnv,
      buildRequesty: createRequestyLlmClientFromEnv,
    });

    expect(client?.provider).toBe('requesty');
    expect(client?.model).toBe('openai/gpt-4o-mini');
    await expect(client?.complete({ maxTokens: 16, userMessage: 'hello' })).resolves.toBe('requesty-ok');
    expect(fetchMock.mock.calls[0][0]).toBe('https://router.requesty.ai/v1/chat/completions');
  });

  test('auto mode appends real OpenRouter builder and leaves Requesty explicit-only', async () => {
    process.env.OPENROUTER_API_KEY = 'or-key';
    process.env.REQUESTY_API_KEY = 'requesty-key';

    const client = await createLlmClient({
      buildOpenRouter: createOpenRouterLlmClientFromEnv,
      buildRequesty: createRequestyLlmClientFromEnv,
    });

    expect(client?.provider).toBe('openrouter');
    expect(client?.model).toBe('deepseek/deepseek-v4-flash');
  });
});

describe('helper LLM accounting through createLlmClient', () => {
  beforeEach(() => {
    clearEnv();
    created.groq = [];
  });

  afterEach(() => {
    clearEnv();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
    resetHelperLlmDiagnosticsForTest();
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
