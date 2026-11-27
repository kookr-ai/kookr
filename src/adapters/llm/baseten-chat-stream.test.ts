import { describe, expect, test } from 'vitest';
import { type LucyModelEvent, type LucyModelRequest } from '../../core/lucy-operator/model-port.js';
import { plainFailureReason } from '../../core/lucy-operator/model-failure.js';
import { buildBasetenChatBody, createBasetenChatStream, type BasetenChatStreamConfig } from './baseten-chat-stream.js';

const CONFIG: BasetenChatStreamConfig = {
  apiKey: 'bt-test-key',
  model: 'deepseek-ai/DeepSeek-V4.1-Flash-Fast',
  baseUrl: 'https://inference.example/v1/',
  reasoningEffort: 'medium',
};

const TOOL = { type: 'function' as const, function: { name: 'read_board', parameters: { type: 'object', properties: {} } } };
const REQUEST: LucyModelRequest = { messages: [{ role: 'user', content: 'hi' }], tools: [TOOL], maxOutputTokens: 1500 };

const data = (chunk: unknown): string => `data: ${JSON.stringify(chunk)}\n\n`;
const textChunk = (content: string): string => data({ choices: [{ delta: { content } }] });

function sseResponse(parts: readonly string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  return new Response(body, { status: 200, ...init });
}

async function collect(events: AsyncIterable<LucyModelEvent>): Promise<LucyModelEvent[]> {
  const out: LucyModelEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const run = (parts: readonly string[], config = CONFIG) => collect(createBasetenChatStream(config, (async () => sseResponse(parts)) as typeof fetch)(REQUEST));

describe('buildBasetenChatBody', () => {
  test('sends the named reasoning level, usage on, tools, and no OpenRouter routing fields', () => {
    expect(buildBasetenChatBody(CONFIG, REQUEST)).toEqual({
      model: 'deepseek-ai/DeepSeek-V4.1-Flash-Fast',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 1500,
      temperature: 0,
      reasoning_effort: 'medium',
      tools: [TOOL],
      tool_choice: 'auto',
    });
  });

  test('a null level leaves the field out, and no tools means no tool fields', () => {
    const body = buildBasetenChatBody({ ...CONFIG, reasoningEffort: null }, { ...REQUEST, tools: [] });
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });
});

describe('createBasetenChatStream', () => {
  test('posts to chat/completions with an Api-Key header and streams text then usage with no cost', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return sseResponse([
        textChunk('Two '),
        textChunk('things.'),
        data({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
        data({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } }),
        'data: [DONE]\n\n',
      ]);
    }) as typeof fetch;

    const events = await collect(createBasetenChatStream(CONFIG, fetchImpl)(REQUEST));

    expect(events).toEqual([
      { type: 'activity' },
      { type: 'text', delta: 'Two ' },
      { type: 'text', delta: 'things.' },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: 12, outputTokens: 4, costUsd: null } },
    ]);
    expect(seen[0]!.url).toBe('https://inference.example/v1/chat/completions');
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Api-Key bt-test-key');
    expect(String(seen[0]!.init.body)).not.toContain('bt-test-key');
  });

  test('a tool call split over several chunks is handed over once, whole, before the finish', async () => {
    const events = await run([
      data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_', arguments: '' } }] } }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'board', arguments: '{"fo' } }] } }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'cus":"all"}' } }] } }] }),
      data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 9 } }),
      'data: [DONE]\n\n',
    ]);
    expect(events).toEqual([
      { type: 'activity' },
      { type: 'tool_call', call: { id: 'call_1', name: 'read_board', arguments: '{"focus":"all"}' } },
      { type: 'finish', finishReason: 'tool_calls', usage: { inputTokens: 20, outputTokens: 9, costUsd: null } },
    ]);
  });

  test.each(['reasoning_content', 'reasoning'])('a chunk with only %s gives one activity and no text, and the thinking is never forwarded', async (field) => {
    const events = await run([
      data({ choices: [{ delta: { [field]: 'The operator wants the board, so I' } }] }),
      data({ choices: [{ delta: { [field]: ' should call read_board.' } }] }),
      data({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n',
    ]);
    expect(events.filter((e) => e.type === 'activity')).toHaveLength(1);
    expect(events.some((e) => e.type === 'text')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('should call');
  });

  test('a malformed chunk is skipped and the rest of the reply still arrives', async () => {
    const events = await run([textChunk('a'), 'data: {not json\n\n', ': keep-alive\n\n', textChunk('b'), 'data: [DONE]\n\n']);
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', delta: 'a' }, { type: 'text', delta: 'b' }]);
    expect(events.at(-1)).toMatchObject({ type: 'finish' });
  });

  test.each([[429, 'is rate-limited (429).'], [500, 'had a server error (500).']])('HTTP %i becomes an http failure with the bounded detail, named Baseten', async (status, tail) => {
    const fetchImpl = (async () => new Response('{"error":{"message":"secret internals <script>"}}', { status })) as typeof fetch;
    const failure = await collect(createBasetenChatStream(CONFIG, fetchImpl)(REQUEST)).then(() => null, (err: unknown) => err);
    expect(failure).toMatchObject({ name: 'LucyModelError', kind: 'http', status, detail: { providerName: 'Baseten', service: 'Baseten', status } });
    expect(JSON.stringify((failure as { detail: unknown }).detail)).not.toContain('secret');
    expect(plainFailureReason(failure)).toBe(`My language model is not answering: Baseten ${tail}`);
  });

  test('an authorisation failure points at the Baseten key', async () => {
    const fetchImpl = (async () => new Response('', { status: 401 })) as typeof fetch;
    const failure = await collect(createBasetenChatStream(CONFIG, fetchImpl)(REQUEST)).then(() => null, (err: unknown) => err);
    expect(plainFailureReason(failure)).toBe('My language model is not answering: Baseten refused the request (401). Check the Baseten key and its credit.');
  });

  test('an error inside the stream is named Baseten too', async () => {
    const failure = await run([data({ error: { code: 503, message: 'overloaded' } })]).then(() => null, (err: unknown) => err);
    expect(failure).toMatchObject({ kind: 'provider', detail: { providerName: 'Baseten', service: 'Baseten', status: 503 } });
  });

  test('aborting the caller\'s signal closes the request and is reported as aborted', async () => {
    const caller = new AbortController();
    let upstream: AbortSignal | undefined;
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
      upstream = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }) as typeof fetch;
    const pending = collect(createBasetenChatStream(CONFIG, fetchImpl)({ ...REQUEST, signal: caller.signal }));
    setTimeout(() => caller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ kind: 'aborted', message: 'Baseten stream aborted by caller' });
    expect(upstream?.aborted).toBe(true);
  });

  test('a stream that goes silent is cut and reported as a timeout', async () => {
    const fetchImpl = ((_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(textChunk('partial')));
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch;
    await expect(collect(createBasetenChatStream({ ...CONFIG, stallTimeoutMs: 20 }, fetchImpl)(REQUEST))).rejects.toMatchObject({ kind: 'timeout' });
  });
});
