import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createLlmClient, FallbackLlmClient } from './llm-factory.js';

const created = vi.hoisted(() => ({
  groq: [] as string[],
  google: [] as string[],
  anthropic: [] as string[],
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

const originalEnv = {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
};

function clearEnv(): void {
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
}

describe('createLlmClient', () => {
  beforeEach(() => {
    clearEnv();
    created.groq = [];
    created.google = [];
    created.anthropic = [];
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
});
