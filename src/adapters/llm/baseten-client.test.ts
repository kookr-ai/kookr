import { afterEach, describe, expect, test, vi } from 'vitest';
import { createBasetenLlmClientFromEnv, BasetenLlmClient } from './baseten-client.js';
import type { LlmCompletionRequest } from '../../core/llm-types.js';

const API_KEY = 'baseten_test-secret-key';

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function stubFetch(response: Response | Promise<Response>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return JSON.parse(init.body as string);
}

function requestHeaders(fetchMock: ReturnType<typeof vi.fn>): Record<string, string> {
  const init = fetchMock.mock.calls[0][1] as RequestInit;
  return init.headers as Record<string, string>;
}

const baseReq: LlmCompletionRequest = {
  maxTokens: 64,
  system: 'You are concise.',
  userMessage: 'Name this task.',
};

describe('BasetenLlmClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('exposes provider name and default model', () => {
    const client = new BasetenLlmClient({ apiKey: API_KEY });
    expect(client.provider).toBe('baseten');
    expect(client.model).toBe('nvidia/Nemotron-120B-A12B');
  });

  test('honors a custom model id', () => {
    const client = new BasetenLlmClient({ apiKey: API_KEY, model: 'openai/gpt-oss-120b' });
    expect(client.model).toBe('openai/gpt-oss-120b');
  });

  test('targets the Baseten OpenAI-compatible endpoint without metadata headers', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: '  Fix login bug  ' } }] }));
    const client = new BasetenLlmClient({ apiKey: API_KEY });

    await expect(client.complete(baseReq)).resolves.toBe('Fix login bug');

    expect(fetchMock.mock.calls[0][0]).toBe('https://inference.baseten.co/v1/chat/completions');
    expect(requestHeaders(fetchMock).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(requestHeaders(fetchMock)['X-Title']).toBeUndefined();
    expect(requestHeaders(fetchMock)['HTTP-Referer']).toBeUndefined();
    expect(requestBody(fetchMock).model).toBe('nvidia/Nemotron-120B-A12B');
  });

  test('surfaces provider failures with the Baseten label', async () => {
    const fetchMock = stubFetch(jsonResponse(
      { error: { message: 'model overloaded' } },
      { ok: false, status: 503, statusText: 'Service Unavailable' },
    ));
    const client = new BasetenLlmClient({ apiKey: API_KEY });

    await expect(client.complete(baseReq)).rejects.toThrow('Baseten request failed');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('createBasetenLlmClientFromEnv', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('returns null when neither Baseten API key is configured', () => {
    expect(createBasetenLlmClientFromEnv({})).toBeNull();
  });

  test('prefers KOOKR_BASETEN_API_KEY over BASETEN_API_KEY', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const client = createBasetenLlmClientFromEnv({
      KOOKR_BASETEN_API_KEY: ' component-key ',
      BASETEN_API_KEY: 'shared-key',
    });

    expect(client).toBeInstanceOf(BasetenLlmClient);
    await client?.complete(baseReq);
    expect(requestHeaders(fetchMock).Authorization).toBe('Bearer component-key');
  });

  test('falls back to BASETEN_API_KEY when the component key is blank', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const client = createBasetenLlmClientFromEnv({
      KOOKR_BASETEN_API_KEY: '   ',
      BASETEN_API_KEY: ' shared-key ',
    });

    expect(client).toBeInstanceOf(BasetenLlmClient);
    await client?.complete(baseReq);
    expect(requestHeaders(fetchMock).Authorization).toBe('Bearer shared-key');
  });

  test('applies Baseten model and base-url overrides from env', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const client = createBasetenLlmClientFromEnv({
      BASETEN_API_KEY: API_KEY,
      KOOKR_BASETEN_MODEL: ' openai/gpt-oss-120b ',
      KOOKR_BASETEN_BASE_URL: ' https://example.baseten.co/v1 ',
    });

    expect(client?.model).toBe('openai/gpt-oss-120b');
    await client?.complete(baseReq);
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.baseten.co/v1/chat/completions');
  });
});
