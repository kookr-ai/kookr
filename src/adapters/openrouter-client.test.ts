import { afterEach, describe, expect, test, vi } from 'vitest';
import { createOpenRouterLlmClientFromEnv, OpenRouterLlmClient } from './openrouter-client.js';
import type { LlmCompletionRequest } from '../core/llm-types.js';

const API_KEY = 'sk-or-test-secret-key';

/** Build a fake `fetch` Response with a JSON body. */
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

/**
 * Stub `fetch` with a promise that never resolves on its own and only rejects
 * when the request's `AbortSignal` fires — so timeout/abort paths are exercised
 * rather than papered over by an instantly-resolving mock.
 */
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

/** Decode the JSON body passed to a mocked fetch call. */
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

describe('OpenRouterLlmClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('exposes provider name and default model', () => {
    const client = new OpenRouterLlmClient({ apiKey: API_KEY });
    expect(client.provider).toBe('openrouter');
    expect(client.model).toBe('deepseek/deepseek-v4-flash');
  });

  test('honors a custom model id', () => {
    const client = new OpenRouterLlmClient({ apiKey: API_KEY, model: 'openai/gpt-5-mini' });
    expect(client.model).toBe('openai/gpt-5-mini');
  });

  test('sends Bearer auth and OpenAI-style request body', async () => {
    const fetchMock = stubFetch(
      jsonResponse({ choices: [{ message: { content: '  Fix login bug  ' } }] }),
    );
    const client = new OpenRouterLlmClient({ apiKey: API_KEY });

    const result = await client.complete(baseReq);

    expect(result).toBe('Fix login bug');
    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect((init as RequestInit).method).toBe('POST');

    const headers = requestHeaders(fetchMock);
    expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Title']).toBe('Kookr');

    const body = requestBody(fetchMock);
    expect(body.model).toBe('deepseek/deepseek-v4-flash');
    expect(body.max_tokens).toBe(64);
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'Name this task.' },
    ]);
    expect(body.response_format).toBeUndefined();
  });

  test('omits the system message when no system prompt is given', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const client = new OpenRouterLlmClient({ apiKey: API_KEY });

    await client.complete({ maxTokens: 16, userMessage: 'hi' });

    expect(requestBody(fetchMock).messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  test('omits HTTP-Referer unless configured, and includes it when set', async () => {
    const noRefererMock = stubFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    await new OpenRouterLlmClient({ apiKey: API_KEY }).complete(baseReq);
    expect(requestHeaders(noRefererMock)['HTTP-Referer']).toBeUndefined();

    vi.unstubAllGlobals();

    const refererMock = stubFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    await new OpenRouterLlmClient({
      apiKey: API_KEY,
      httpReferer: 'https://kookr.example',
      appTitle: 'Kookr Dev',
    }).complete(baseReq);
    const headers = requestHeaders(refererMock);
    expect(headers['HTTP-Referer']).toBe('https://kookr.example');
    expect(headers['X-Title']).toBe('Kookr Dev');
  });

  test('targets a custom base URL without a doubled slash', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const client = new OpenRouterLlmClient({
      apiKey: API_KEY,
      baseUrl: 'https://proxy.internal/api/v1/',
    });

    await client.complete(baseReq);

    expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.internal/api/v1/chat/completions');
  });

  test('sends best-effort response_format when responseFormat is requested', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: '{}' } }] }));
    const client = new OpenRouterLlmClient({ apiKey: API_KEY });

    await client.complete({
      ...baseReq,
      responseFormat: {
        type: 'json_schema',
        jsonSchema: { name: 'task_name', schema: { type: 'object' } },
      },
    });

    expect(requestBody(fetchMock).response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'task_name', strict: false, schema: { type: 'object' } },
    });
  });

  test('returns null when the response has empty content', async () => {
    stubFetch(jsonResponse({ choices: [{ message: { content: '   ' } }] }));
    const client = new OpenRouterLlmClient({ apiKey: API_KEY });
    expect(await client.complete(baseReq)).toBeNull();
  });

  test('returns null when the response has no choices', async () => {
    stubFetch(jsonResponse({ choices: [] }));
    const client = new OpenRouterLlmClient({ apiKey: API_KEY });
    expect(await client.complete(baseReq)).toBeNull();
  });

  test('throws on an HTTP error and never leaks the API key', async () => {
    stubFetch(
      jsonResponse(
        { error: { message: 'rate limited' } },
        { ok: false, status: 429, statusText: 'Too Many Requests' },
      ),
    );
    const client = new OpenRouterLlmClient({ apiKey: API_KEY });

    let caught: unknown;
    try {
      await client.complete(baseReq);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('429');
    // The error surfaces the response-body detail but never the API key.
    expect((caught as Error).message).toContain('rate limited');
    expect((caught as Error).message).not.toContain(API_KEY);
  });

  test('propagates a network failure as a thrown error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    const client = new OpenRouterLlmClient({ apiKey: API_KEY });

    await expect(client.complete(baseReq)).rejects.toThrow('network down');
  });

  test('rejects when the caller signal is already aborted', async () => {
    // Fetch only settles when the request signal aborts, so this would hang
    // (and fail the test) if the client did not propagate the caller's signal.
    stubAbortAwareFetch();
    const client = new OpenRouterLlmClient({ apiKey: API_KEY });

    await expect(
      client.complete({ ...baseReq, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });

  test('aborts the request when the caller signal fires mid-flight', async () => {
    stubAbortAwareFetch();
    const controller = new AbortController();
    const client = new OpenRouterLlmClient({ apiKey: API_KEY });

    const pending = client.complete({ ...baseReq, signal: controller.signal });
    const rejects = expect(pending).rejects.toThrow();
    controller.abort();
    await rejects;
  });

  test('aborts the request when an explicit timeoutMs override elapses', async () => {
    vi.useFakeTimers();
    try {
      stubAbortAwareFetch();
      // An explicit override (KOOKR_LLM_TIMEOUT_MS) is used verbatim, even
      // below the default floor.
      const client = new OpenRouterLlmClient({ apiKey: API_KEY, timeoutMs: 1000 });

      const pending = client.complete(baseReq);
      const settled = vi.fn();
      void pending.then(settled, settled);

      // Still pending just before the override elapses...
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).not.toHaveBeenCalled();

      // ...and aborted exactly when it does.
      const rejects = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(1);
      await rejects;
    } finally {
      vi.useRealTimers();
    }
  });

  test('floors a short caller timeout up to the OpenRouter default', async () => {
    vi.useFakeTimers();
    try {
      stubAbortAwareFetch();
      const client = new OpenRouterLlmClient({ apiKey: API_KEY });

      // A 1s caller budget (tuned for the fast free-tier providers) must not
      // abort OpenRouter — the client floors it up to DEFAULT_TIMEOUT_MS (20s).
      const pending = client.complete({ ...baseReq, timeoutMs: 1000 });
      const settled = vi.fn();
      void pending.then(settled, settled);

      await vi.advanceTimersByTimeAsync(5000);
      expect(settled).not.toHaveBeenCalled();

      // The 20s floor still fires.
      const rejects = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(15_000);
      await rejects;
    } finally {
      vi.useRealTimers();
    }
  });

  test('honors a caller timeout longer than the OpenRouter default floor', async () => {
    vi.useFakeTimers();
    try {
      stubAbortAwareFetch();
      const client = new OpenRouterLlmClient({ apiKey: API_KEY });

      // A 30s caller budget is above the 20s floor, so it is used as-is —
      // the floor must not clamp it down.
      const pending = client.complete({ ...baseReq, timeoutMs: 30_000 });
      const settled = vi.fn();
      void pending.then(settled, settled);

      await vi.advanceTimersByTimeAsync(20_000);
      expect(settled).not.toHaveBeenCalled();

      const rejects = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(10_000);
      await rejects;
    } finally {
      vi.useRealTimers();
    }
  });

  test('ignores a non-positive timeoutMs option and applies the floor', async () => {
    vi.useFakeTimers();
    try {
      stubAbortAwareFetch();
      // A non-positive override is rejected by the constructor, so the 20s
      // floor applies just as if no override were set.
      const client = new OpenRouterLlmClient({ apiKey: API_KEY, timeoutMs: 0 });

      const pending = client.complete({ ...baseReq, timeoutMs: 1000 });
      const settled = vi.fn();
      void pending.then(settled, settled);

      await vi.advanceTimersByTimeAsync(5000);
      expect(settled).not.toHaveBeenCalled();

      const rejects = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(15_000);
      await rejects;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createOpenRouterLlmClientFromEnv', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('returns null when neither OpenRouter API key is configured', () => {
    expect(createOpenRouterLlmClientFromEnv({})).toBeNull();
  });

  test('prefers KOOKR_OPENROUTER_API_KEY over OPENROUTER_API_KEY', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const client = createOpenRouterLlmClientFromEnv({
      KOOKR_OPENROUTER_API_KEY: ' component-key ',
      OPENROUTER_API_KEY: 'shared-key',
    });

    expect(client).toBeInstanceOf(OpenRouterLlmClient);
    expect(client?.provider).toBe('openrouter');
    await client?.complete(baseReq);
    expect(requestHeaders(fetchMock).Authorization).toBe('Bearer component-key');
  });

  test('falls back to OPENROUTER_API_KEY when the component key is blank', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const client = createOpenRouterLlmClientFromEnv({
      KOOKR_OPENROUTER_API_KEY: '   ',
      OPENROUTER_API_KEY: ' shared-key ',
    });

    expect(client).toBeInstanceOf(OpenRouterLlmClient);
    await client?.complete(baseReq);
    expect(requestHeaders(fetchMock).Authorization).toBe('Bearer shared-key');
  });

  test('applies model, base URL, and attribution overrides from env', async () => {
    const fetchMock = stubFetch(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const client = createOpenRouterLlmClientFromEnv({
      OPENROUTER_API_KEY: API_KEY,
      KOOKR_LLM_MODEL: ' openai/gpt-5-mini ',
      KOOKR_LLM_BASE_URL: ' https://proxy.internal/api/v1/ ',
      KOOKR_LLM_HTTP_REFERER: ' https://kookr.example ',
      KOOKR_LLM_APP_TITLE: ' Kookr Dev ',
    });

    expect(client?.model).toBe('openai/gpt-5-mini');
    await client?.complete(baseReq);

    expect(fetchMock.mock.calls[0][0]).toBe('https://proxy.internal/api/v1/chat/completions');
    expect(requestHeaders(fetchMock)['HTTP-Referer']).toBe('https://kookr.example');
    expect(requestHeaders(fetchMock)['X-Title']).toBe('Kookr Dev');
  });

  test('applies a valid timeout override from env', async () => {
    vi.useFakeTimers();
    try {
      stubAbortAwareFetch();
      const client = createOpenRouterLlmClientFromEnv({
        OPENROUTER_API_KEY: API_KEY,
        KOOKR_LLM_TIMEOUT_MS: ' 1000 ',
      });

      const pending = client!.complete({ ...baseReq, timeoutMs: 20_000 });
      const settled = vi.fn();
      void pending.then(settled, settled);

      await vi.advanceTimersByTimeAsync(999);
      expect(settled).not.toHaveBeenCalled();

      const rejects = expect(pending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(1);
      await rejects;
    } finally {
      vi.useRealTimers();
    }
  });

  test('ignores non-numeric and non-positive timeout overrides', async () => {
    vi.useFakeTimers();
    try {
      for (const bad of ['not-a-number', '0', '-500', '  ']) {
        vi.unstubAllGlobals();
        stubAbortAwareFetch();
        const client = createOpenRouterLlmClientFromEnv({
          OPENROUTER_API_KEY: API_KEY,
          KOOKR_LLM_TIMEOUT_MS: bad,
        });

        const pending = client!.complete({ ...baseReq, timeoutMs: 1000 });
        const settled = vi.fn();
        void pending.then(settled, settled);

        await vi.advanceTimersByTimeAsync(5000);
        expect(settled).not.toHaveBeenCalled();

        const rejects = expect(pending).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(15_000);
        await rejects;
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
