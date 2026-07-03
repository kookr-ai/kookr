import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createBasetenLlmClientFromEnv } from './baseten-client.js';
import { createLlmClient } from './factory.js';

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
  'KOOKR_BASETEN_API_KEY',
  'BASETEN_API_KEY',
  'KOOKR_BASETEN_MODEL',
  'KOOKR_BASETEN_BASE_URL',
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe('createLlmClient Baseten adapter integration', () => {
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

  test('constructs the real Baseten adapter and issues a Baseten request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: { content: '  ok  ' } }] }));
    vi.stubGlobal('fetch', fetchMock);
    process.env.KOOKR_LLM_PROVIDER = 'baseten';
    process.env.KOOKR_BASETEN_API_KEY = ' baseten-integration-key ';

    const client = await createLlmClient({ buildBaseten: createBasetenLlmClientFromEnv });

    expect(client?.provider).toBe('baseten');
    expect(client?.model).toBe('nvidia/Nemotron-120B-A12B');
    await expect(client?.complete({ maxTokens: 16, userMessage: 'hello' })).resolves.toBe('ok');
    expect(fetchMock.mock.calls[0][0]).toBe('https://inference.baseten.co/v1/chat/completions');
    expect(requestBody(fetchMock).model).toBe('nvidia/Nemotron-120B-A12B');
  });
});
