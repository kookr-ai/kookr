import { afterEach, describe, expect, test, vi } from 'vitest';
import { createRequestyLlmClientFromEnv, RequestyLlmClient } from './requesty-client.js';
import type { LlmCompletionRequest } from '../core/llm-types.js';

const API_KEY = 'req_test-secret-key';

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

describe('RequestyLlmClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('exposes provider name and default model', () => {
    const client = new RequestyLlmClient({ apiKey: API_KEY });
    expect(client.provider).toBe('requesty');
    expect(client.model).toBe('openai/gpt-4o-mini');
  });

  test('honors a custom model id', () => {
    const client = new RequestyLlmClient({ apiKey: API_KEY, model: 'anthropic/claude-sonnet-4-20250514' });
    expect(client.model).toBe('anthropic/claude-sonnet-4-20250514');
  });

  test('targets Requesty endpoint without metadata headers', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: '  Fix login bug  ' } }] }));
    const client = new RequestyLlmClient({ apiKey: API_KEY });

    await expect(client.complete(baseReq)).resolves.toBe('Fix login bug');

    expect(fetchMock.mock.calls[0][0]).toBe('https://router.requesty.ai/v1/chat/completions');
    expect(requestHeaders(fetchMock).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(requestHeaders(fetchMock)['X-Title']).toBeUndefined();
    expect(requestHeaders(fetchMock)['HTTP-Referer']).toBeUndefined();
    expect(requestBody(fetchMock).model).toBe('openai/gpt-4o-mini');
  });

  test('does not retry when response_format is rejected', async () => {
    const fetchMock = stubFetch(jsonResponse(
      { error: { message: 'response_format unsupported' } },
      { ok: false, status: 400, statusText: 'Bad Request' },
    ));
    const client = new RequestyLlmClient({ apiKey: API_KEY });

    await expect(client.complete({
      ...baseReq,
      responseFormat: {
        type: 'json_schema',
        jsonSchema: { name: 'task_name', schema: { type: 'object' } },
      },
    })).rejects.toThrow('Requesty request failed');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('createRequestyLlmClientFromEnv', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('returns null when neither Requesty API key is configured', () => {
    expect(createRequestyLlmClientFromEnv({})).toBeNull();
  });

  test('prefers KOOKR_REQUESTY_API_KEY over REQUESTY_API_KEY', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const client = createRequestyLlmClientFromEnv({
      KOOKR_REQUESTY_API_KEY: ' component-key ',
      REQUESTY_API_KEY: 'shared-key',
    });

    expect(client).toBeInstanceOf(RequestyLlmClient);
    await client?.complete(baseReq);
    expect(requestHeaders(fetchMock).Authorization).toBe('Bearer component-key');
  });

  test('falls back to REQUESTY_API_KEY when the component key is blank', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const client = createRequestyLlmClientFromEnv({
      KOOKR_REQUESTY_API_KEY: '   ',
      REQUESTY_API_KEY: ' shared-key ',
    });

    expect(client).toBeInstanceOf(RequestyLlmClient);
    await client?.complete(baseReq);
    expect(requestHeaders(fetchMock).Authorization).toBe('Bearer shared-key');
  });

  test('applies Requesty model override from env', async () => {
    const client = createRequestyLlmClientFromEnv({
      REQUESTY_API_KEY: API_KEY,
      KOOKR_REQUESTY_MODEL: ' openai/gpt-4o ',
    });

    expect(client?.model).toBe('openai/gpt-4o');
  });
});
