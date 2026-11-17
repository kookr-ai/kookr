import { afterEach, describe, expect, test, vi } from 'vitest';
import { GEMINI_API_VERSION, GoogleLlmClient } from './google-client.js';

function stubGenerateContent(text: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestUrl(fetchMock: ReturnType<typeof vi.fn>): URL {
  const [input] = fetchMock.mock.calls[0] as [string | URL | Request];
  return new URL(input instanceof Request ? input.url : String(input));
}

describe('GoogleLlmClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  test('calls the default preview model on the v1beta API, not the SDK default version', async () => {
    const fetchMock = stubGenerateContent('  ok  ');
    const client = new GoogleLlmClient('test-key');

    const reply = await client.complete({ userMessage: 'Say ok.', maxTokens: 16 });

    expect(reply).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(GEMINI_API_VERSION).toBe('v1beta');
    expect(requestUrl(fetchMock).pathname).toBe('/v1beta/models/gemini-3-flash-preview:generateContent');
  });

  test('stays on v1beta when GOOGLE_GENAI_API_VERSION asks for another version', async () => {
    vi.stubEnv('GOOGLE_GENAI_API_VERSION', 'v1');
    const fetchMock = stubGenerateContent('ok');
    const client = new GoogleLlmClient('test-key');

    await client.complete({ userMessage: 'Say ok.', maxTokens: 16 });

    expect(requestUrl(fetchMock).pathname).toBe('/v1beta/models/gemini-3-flash-preview:generateContent');
  });
});
