import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRequestyLlmClientFromEnv } from '../adapters/requesty-client.js';
import { createLlmClient } from './llm-factory.js';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(init.body as string);
}

const ENV_KEYS = [
  'KOOKR_LLM_PROVIDER',
  'KOOKR_REQUESTY_API_KEY',
  'REQUESTY_API_KEY',
  'KOOKR_REQUESTY_MODEL',
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe('createLlmClient Requesty adapter integration', () => {
  beforeEach(() => {
    clearEnv();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearEnv();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
  });

  test('constructs the real Requesty adapter and issues a Requesty request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: '  ok  ' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.KOOKR_LLM_PROVIDER = 'requesty';
    process.env.KOOKR_REQUESTY_API_KEY = ' req-integration-key ';
    process.env.KOOKR_REQUESTY_MODEL = ' openai/gpt-4o ';

    const client = await createLlmClient({ buildRequesty: createRequestyLlmClientFromEnv });

    expect(client?.provider).toBe('requesty');
    expect(client?.model).toBe('openai/gpt-4o');
    await expect(client?.complete({ maxTokens: 16, userMessage: 'hello' })).resolves.toBe('ok');
    expect(fetchMock.mock.calls[0][0]).toBe('https://router.requesty.ai/v1/chat/completions');
    expect(requestBody(fetchMock).model).toBe('openai/gpt-4o');
  });
});
