import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  OpenAiCompatibleLlmClient,
  sanitizeProviderErrorDetail,
} from './openai-compatible-client.js';
import type { LlmCompletionRequest } from '../../core/llm-types.js';

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

function stubFetchError(error: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockRejectedValue(error);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubAbortAwareFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    const signal = init.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      const fail = (): void => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    });
  });
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

describe('OpenAiCompatibleLlmClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('posts an OpenAI-style chat-completions request with bearer auth', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: '  ok  ' } }] }));
    const client = new OpenAiCompatibleLlmClient({
      provider: 'requesty',
      apiKey: API_KEY,
      model: 'openai/gpt-4o-mini',
      baseUrl: 'https://router.requesty.ai/v1/',
    });

    await expect(client.complete(baseReq)).resolves.toBe('ok');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://router.requesty.ai/v1/chat/completions');
    expect((init as RequestInit).method).toBe('POST');
    expect(requestHeaders(fetchMock).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(requestHeaders(fetchMock)['Content-Type']).toBe('application/json');
    expect(requestBody(fetchMock)).toEqual({
      model: 'openai/gpt-4o-mini',
      max_tokens: 64,
      messages: [
        { role: 'system', content: 'You are concise.' },
        { role: 'user', content: 'Name this task.' },
      ],
    });
  });

  test('completeDetailed surfaces the provider finish reason (issue #1555)', async () => {
    // Reasoning model burned the whole token budget: empty content, finish_reason=length.
    stubFetch(jsonResponse({ choices: [{ finish_reason: 'length', message: { content: '' } }] }));
    const client = new OpenAiCompatibleLlmClient({
      provider: 'baseten',
      apiKey: API_KEY,
      model: 'nvidia/Nemotron-120B-A12B',
      baseUrl: 'https://inference.baseten.co/v1',
    });

    await expect(client.completeDetailed(baseReq)).resolves.toEqual({
      text: null,
      finishReason: 'length',
    });
  });

  test('completeDetailed returns text with its finish reason on success', async () => {
    stubFetch(jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '  Fix auth bug  ' } }] }));
    const client = new OpenAiCompatibleLlmClient({
      provider: 'baseten',
      apiKey: API_KEY,
      model: 'nvidia/Nemotron-120B-A12B',
      baseUrl: 'https://inference.baseten.co/v1',
    });

    await expect(client.completeDetailed(baseReq)).resolves.toEqual({
      text: 'Fix auth bug',
      finishReason: 'stop',
    });
  });

  test('completeDetailed attaches the finish reason to tool-call arguments', async () => {
    stubFetch(jsonResponse({
      choices: [{
        finish_reason: 'tool_calls',
        message: { content: null, tool_calls: [{ function: { name: 'task_name', arguments: '{"name":"x"}' } }] },
      }],
    }));
    const client = new OpenAiCompatibleLlmClient({
      provider: 'baseten',
      apiKey: API_KEY,
      model: 'nvidia/Nemotron-120B-A12B',
      baseUrl: 'https://inference.baseten.co/v1',
    });

    await expect(client.completeDetailed(baseReq)).resolves.toEqual({
      text: '{"name":"x"}',
      finishReason: 'tool_calls',
    });
  });

  test('forwards extra headers and best-effort response_format', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: '{}' } }] }));
    const client = new OpenAiCompatibleLlmClient({
      provider: 'openrouter',
      apiKey: API_KEY,
      model: 'deepseek/deepseek-v4-flash',
      baseUrl: 'https://openrouter.ai/api/v1',
      extraHeaders: { 'X-Title': 'Kookr' },
    });

    await client.complete({
      ...baseReq,
      responseFormat: {
        type: 'json_schema',
        jsonSchema: { name: 'task_name', schema: { type: 'object' } },
      },
    });

    expect(requestHeaders(fetchMock)['X-Title']).toBe('Kookr');
    expect(requestBody(fetchMock).response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'task_name', strict: false, schema: { type: 'object' } },
    });
  });

  test('forwards json_object response_format', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: '{}' } }] }));
    const client = new OpenAiCompatibleLlmClient({
      provider: 'baseten',
      apiKey: API_KEY,
      model: 'nvidia/Nemotron-120B-A12B',
      baseUrl: 'https://inference.baseten.co/v1',
    });

    await client.complete({
      ...baseReq,
      responseFormat: { type: 'json_object' },
    });

    expect(requestBody(fetchMock).response_format).toEqual({ type: 'json_object' });
  });

  test('forwards tools/tool_choice and returns function arguments as content', async () => {
    const fetchMock = stubFetch(jsonResponse({
      choices: [{
        message: {
          content: null,
          tool_calls: [{
            function: {
              name: 'criteria_completion_verdict',
              arguments: '{"items":[]}',
            },
          }],
        },
      }],
    }));
    const client = new OpenAiCompatibleLlmClient({
      provider: 'baseten',
      apiKey: API_KEY,
      model: 'nvidia/Nemotron-120B-A12B',
      baseUrl: 'https://inference.baseten.co/v1',
    });

    const text = await client.complete({
      ...baseReq,
      tools: [{
        type: 'function',
        function: {
          name: 'criteria_completion_verdict',
          parameters: { type: 'object' },
        },
      }],
      toolChoice: { type: 'function', function: { name: 'criteria_completion_verdict' } },
    });

    expect(text).toBe('{"items":[]}');
    expect(requestBody(fetchMock).tools).toEqual([{
      type: 'function',
      function: {
        name: 'criteria_completion_verdict',
        parameters: { type: 'object' },
      },
    }]);
    expect(requestBody(fetchMock).tool_choice).toEqual({
      type: 'function',
      function: { name: 'criteria_completion_verdict' },
    });
  });

  test('turns internal timeout into provider failure, not AbortError', async () => {
    vi.useFakeTimers();
    try {
      stubAbortAwareFetch();
      const client = new OpenAiCompatibleLlmClient({
        provider: 'requesty',
        apiKey: API_KEY,
        model: 'openai/gpt-4o-mini',
        baseUrl: 'https://router.requesty.ai/v1',
        timeoutMs: 1000,
      });

      const pending = client.complete(baseReq);
      const rejects = expect(pending).rejects.toMatchObject({
        name: 'LlmProviderFailureError',
        providerFailureCategory: 'network_timeout',
        message: expect.stringContaining('Requesty request timed out after 1000ms'),
      });
      await vi.advanceTimersByTimeAsync(1000);
      await rejects;
    } finally {
      vi.useRealTimers();
    }
  });

  test('preserves caller abort as AbortError', async () => {
    stubAbortAwareFetch();
    const client = new OpenAiCompatibleLlmClient({
      provider: 'requesty',
      apiKey: API_KEY,
      model: 'openai/gpt-4o-mini',
      baseUrl: 'https://router.requesty.ai/v1',
    });

    await expect(
      client.complete({ ...baseReq, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('throws provider-specific sanitized HTTP error detail', async () => {
    stubFetch(jsonResponse(
      {
        error: {
          message: 'bad request',
          Authorization: `Bearer ${API_KEY}`,
          messages: [{ role: 'user', content: 'secret prompt text' }],
          api_key: 'req_1234567890abcdef',
        },
      },
      { ok: false, status: 400, statusText: 'Bad Request' },
    ));
    const client = new OpenAiCompatibleLlmClient({
      provider: 'requesty',
      apiKey: API_KEY,
      model: 'openai/gpt-4o-mini',
      baseUrl: 'https://router.requesty.ai/v1',
    });

    let caught: unknown;
    try {
      await client.complete(baseReq);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject({ providerFailureCategory: 'other' });
    expect((caught as Error).message).toContain('Requesty request failed: 400 Bad Request');
    expect((caught as Error).message).toContain('bad request');
    expect((caught as Error).message).not.toContain(API_KEY);
    expect((caught as Error).message).not.toContain('secret prompt text');
  });

  test('classifies HTTP 410 Gone as a cooldown-class (auth) failure', async () => {
    stubFetch(jsonResponse(
      { error: { message: 'model has been removed' } },
      { ok: false, status: 410, statusText: 'Gone' },
    ));
    const client = new OpenAiCompatibleLlmClient({
      provider: 'baseten',
      apiKey: API_KEY,
      model: 'deprecated-namer',
      baseUrl: 'https://inference.baseten.co/v1',
    });

    await expect(client.complete(baseReq)).rejects.toMatchObject({
      providerFailureCategory: 'auth',
      message: expect.stringContaining('410 Gone'),
    });
  });

  test('classifies auth HTTP failures', async () => {
    stubFetch(jsonResponse(
      { error: { message: 'invalid api key', api_key: API_KEY } },
      { ok: false, status: 401, statusText: 'Unauthorized' },
    ));
    const client = new OpenAiCompatibleLlmClient({
      provider: 'openrouter',
      apiKey: API_KEY,
      model: 'deepseek/deepseek-v4-flash',
      baseUrl: 'https://openrouter.ai/api/v1',
    });

    await expect(client.complete(baseReq)).rejects.toMatchObject({
      providerFailureCategory: 'auth',
      message: expect.stringContaining('401 Unauthorized'),
    });
  });

  test('classifies 5xx HTTP failures', async () => {
    stubFetch(jsonResponse(
      { error: { message: 'upstream unavailable' } },
      { ok: false, status: 503, statusText: 'Service Unavailable' },
    ));
    const client = new OpenAiCompatibleLlmClient({
      provider: 'requesty',
      apiKey: API_KEY,
      model: 'openai/gpt-4o-mini',
      baseUrl: 'https://router.requesty.ai/v1',
    });

    await expect(client.complete(baseReq)).rejects.toMatchObject({
      providerFailureCategory: 'server_5xx',
      message: expect.stringContaining('503 Service Unavailable'),
    });
  });

  test('classifies network failures before a response is received', async () => {
    stubFetchError(new TypeError('fetch failed'));
    const client = new OpenAiCompatibleLlmClient({
      provider: 'requesty',
      apiKey: API_KEY,
      model: 'openai/gpt-4o-mini',
      baseUrl: 'https://router.requesty.ai/v1',
    });

    await expect(client.complete(baseReq)).rejects.toMatchObject({
      providerFailureCategory: 'network_timeout',
      message: expect.stringContaining('fetch failed'),
    });
  });

  test('classifies invalid JSON as a malformed provider response', async () => {
    stubFetch({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => { throw new SyntaxError('Unexpected end of JSON input'); },
      text: async () => 'truncated',
    } as unknown as Response);
    const client = new OpenAiCompatibleLlmClient({
      provider: 'requesty',
      apiKey: API_KEY,
      model: 'openai/gpt-4o-mini',
      baseUrl: 'https://router.requesty.ai/v1',
    });

    await expect(client.complete(baseReq)).rejects.toMatchObject({
      name: 'LlmProviderFailureError',
      providerFailureCategory: 'malformed_response',
      message: expect.stringContaining('not valid JSON'),
    });
  });

  test('returns null when a valid JSON response has no message content', async () => {
    stubFetch(jsonResponse({ choices: [{ message: {} }] }));
    const client = new OpenAiCompatibleLlmClient({
      provider: 'openrouter',
      apiKey: API_KEY,
      model: 'deepseek/deepseek-v4-flash',
      baseUrl: 'https://openrouter.ai/api/v1',
    });

    await expect(client.complete(baseReq)).resolves.toBeNull();
  });
});

describe('sanitizeProviderErrorDetail', () => {
  test('redacts key-like values and omits request-derived fields', () => {
    const detail = sanitizeProviderErrorDetail(JSON.stringify({
      Authorization: 'Bearer req_1234567890abcdef',
      error: {
        message: 'upstream rejected response_format',
        content: 'prompt echo',
        messages: [{ role: 'user', content: 'full prompt' }],
      },
    }));

    expect(detail).toContain('upstream rejected response_format');
    expect(detail).not.toContain('req_1234567890abcdef');
    expect(detail).not.toContain('prompt echo');
    expect(detail).not.toContain('full prompt');
  });
});
