import { describe, expect, test } from 'vitest';
import { LucyModelError, type LucyModelEvent, type LucyModelRequest } from '../../core/lucy-operator/model-port.js';
import {
  buildOpenRouterChatBody,
  createOpenRouterChatStream,
  OpenRouterChatStreamParser,
  type OpenRouterChatStreamConfig,
} from './openrouter-chat-stream.js';

const CONFIG: OpenRouterChatStreamConfig = {
  apiKey: 'sk-or-test-key',
  model: 'deepseek/deepseek-v4.1-flash-1017',
  baseUrl: 'https://openrouter.example/api/v1/',
  providers: ['cohere/fp8', 'deepinfra/fp8'],
  reasoning: 'medium',
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

describe('buildOpenRouterChatBody', () => {
  test('sends the measured request shape: pinned providers in order, no other provider, reasoning level, usage', () => {
    expect(buildOpenRouterChatBody(CONFIG, REQUEST)).toEqual({
      model: 'deepseek/deepseek-v4.1-flash-1017',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      max_tokens: 1500,
      temperature: 0,
      usage: { include: true },
      reasoning: { effort: 'medium' },
      tools: [TOOL],
      tool_choice: 'auto',
      provider: { order: ['cohere/fp8', 'deepinfra/fp8'], only: ['cohere', 'deepinfra'] },
    });
  });

  test('two tags of one provider give one entry in "only"', () => {
    const body = buildOpenRouterChatBody({ ...CONFIG, providers: ['deepinfra/fp8', 'deepinfra/fp8/flex'] }, REQUEST);
    expect(body.provider).toEqual({ order: ['deepinfra/fp8', 'deepinfra/fp8/flex'], only: ['deepinfra'] });
  });

  test('no providers means no routing block, and no tools means no tool fields', () => {
    const body = buildOpenRouterChatBody({ ...CONFIG, providers: [] }, { ...REQUEST, tools: [] });
    expect(body).not.toHaveProperty('provider');
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });
});

describe('OpenRouterChatStreamParser', () => {
  test('yields text pieces even when a chunk is split in the middle of a line', () => {
    const parser = new OpenRouterChatStreamParser();
    const whole = textChunk('Hello') + textChunk(' there');
    const cut = 17;
    expect([...parser.push(whole.slice(0, cut)), ...parser.push(whole.slice(cut))]).toEqual(['Hello', ' there']);
  });

  test('assembles a tool call from fragments and reports it only at the end', () => {
    const parser = new OpenRouterChatStreamParser();
    const pieces = [
      data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_task', arguments: '' } }] } }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"task":' } }] } }] }),
      data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"3f2a"}' } }, { index: 1, id: 'call_b', function: { name: 'read_board', arguments: '{}' } }] } }] }),
      data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      data({ provider: 'Cohere', choices: [], usage: { prompt_tokens: 1200, completion_tokens: 45, cost: 0.00031 } }),
      'data: [DONE]\n\n',
    ];
    expect(pieces.flatMap((piece) => parser.push(piece))).toEqual([]);
    expect(parser.done).toBe(true);
    expect(parser.finish()).toEqual([
      { type: 'tool_call', call: { id: 'call_a', name: 'read_task', arguments: '{"task":"3f2a"}' } },
      { type: 'tool_call', call: { id: 'call_b', name: 'read_board', arguments: '{}' } },
      { type: 'finish', finishReason: 'tool_calls', usage: { inputTokens: 1200, outputTokens: 45, costUsd: 0.00031 }, provider: 'Cohere' },
    ]);
  });

  test('a tool-call index that is not a small whole number is dropped, quickly', () => {
    const parser = new OpenRouterChatStreamParser();
    const started = performance.now();
    for (const index of [5e7, -1, 1.5, 'x', '0', 16]) {
      parser.push(data({ choices: [{ delta: { tool_calls: [{ index, id: 'bad', function: { name: 'read_board', arguments: '{}' } }] } }] }));
    }
    parser.push(data({ choices: [{ delta: { tool_calls: [{ id: 'ok', function: { name: 'read_board', arguments: '{}' } }] } }] }));
    const events = parser.finish();
    // A generous limit for a busy machine: an unbounded index held the thread for over a second per fragment.
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(events.filter((e) => e.type === 'tool_call')).toEqual([{ type: 'tool_call', call: { id: 'ok', name: 'read_board', arguments: '{}' } }]);
  });

  test('calls that arrive without an index are told apart by their ids', () => {
    const parser = new OpenRouterChatStreamParser();
    parser.push(data({ choices: [{ delta: { tool_calls: [{ index: null, id: 'a', function: { name: 'read_task', arguments: '{"task":' } }] } }] }));
    parser.push(data({ choices: [{ delta: { tool_calls: [{ function: { arguments: '"3f2a"}' } }] } }] }));
    parser.push(data({ choices: [{ delta: { tool_calls: [{ id: 'b', function: { name: 'read_board', arguments: '{}' } }] } }] }));
    expect(parser.finish().filter((e) => e.type === 'tool_call')).toEqual([
      { type: 'tool_call', call: { id: 'a', name: 'read_task', arguments: '{"task":"3f2a"}' } },
      { type: 'tool_call', call: { id: 'b', name: 'read_board', arguments: '{}' } },
    ]);
  });

  test('never forwards the model\'s reasoning text', () => {
    const parser = new OpenRouterChatStreamParser();
    const out = parser.push(data({ choices: [{ delta: { reasoning: 'The operator wants t1...', reasoning_details: [{ text: 'secret thought' }] } }] }) + textChunk('Two are running.'));
    expect(out).toEqual(['Two are running.']);
  });

  test('ignores keep-alive comments, non-JSON payloads and anything after [DONE]', () => {
    const parser = new OpenRouterChatStreamParser();
    const out = parser.push(`: OPENROUTER PROCESSING\n\ndata: not json\n\n${textChunk('a')}data: [DONE]\n\n${textChunk('late')}`);
    expect(out).toEqual(['a']);
  });

  test('reports missing usage as zero tokens and an unknown cost', () => {
    const parser = new OpenRouterChatStreamParser();
    parser.push(textChunk('hi'));
    expect(parser.finish()).toEqual([{ type: 'finish', finishReason: null, usage: { inputTokens: 0, outputTokens: 0, costUsd: null } }]);
  });

  test('an error reported inside the stream is thrown as a provider failure', () => {
    const parser = new OpenRouterChatStreamParser();
    let thrown: unknown;
    try {
      parser.push(data({ error: { code: 502, message: 'Upstream provider failed' } }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(LucyModelError);
    expect(thrown).toMatchObject({ kind: 'provider' });
  });
});

describe('createOpenRouterChatStream', () => {
  test('posts to chat/completions with the key in a header and streams text, tool calls and usage', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return sseResponse([
        textChunk('Let me '),
        textChunk('check.'),
        data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_board', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }),
        data({ provider: 'DeepInfra', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00001 } }),
        'data: [DONE]\n\n',
      ]);
    }) as typeof fetch;

    const events = await collect(createOpenRouterChatStream(CONFIG, fetchImpl)(REQUEST));

    expect(events).toEqual([
      { type: 'text', delta: 'Let me ' },
      { type: 'text', delta: 'check.' },
      { type: 'tool_call', call: { id: 'c1', name: 'read_board', arguments: '{}' } },
      { type: 'finish', finishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.00001 }, provider: 'DeepInfra' },
    ]);
    expect(seen[0]!.url).toBe('https://openrouter.example/api/v1/chat/completions');
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer sk-or-test-key');
    expect(headers['X-Title']).toBe('Kookr');
    expect(String(seen[0]!.init.body)).not.toContain('sk-or-test-key');
    expect(JSON.parse(String(seen[0]!.init.body))).toMatchObject({ stream: true, reasoning: { effort: 'medium' } });
  });

  test('an HTTP error becomes an http failure carrying the status', async () => {
    const fetchImpl = (async () => new Response('{"error":{"message":"No credits"}}', { status: 402 })) as typeof fetch;
    await expect(collect(createOpenRouterChatStream(CONFIG, fetchImpl)(REQUEST))).rejects.toMatchObject({ name: 'LucyModelError', kind: 'http', status: 402 });
  });

  test('a network failure becomes a network failure', async () => {
    const fetchImpl = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    await expect(collect(createOpenRouterChatStream(CONFIG, fetchImpl)(REQUEST))).rejects.toMatchObject({ kind: 'network' });
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

    const pending = collect(createOpenRouterChatStream(CONFIG, fetchImpl)({ ...REQUEST, signal: caller.signal }));
    setTimeout(() => caller.abort(), 5);

    await expect(pending).rejects.toMatchObject({ kind: 'aborted' });
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

    const events: LucyModelEvent[] = [];
    const run = (async () => {
      for await (const event of createOpenRouterChatStream({ ...CONFIG, stallTimeoutMs: 20 }, fetchImpl)(REQUEST)) events.push(event);
    })();

    await expect(run).rejects.toMatchObject({ kind: 'timeout' });
    expect(events).toEqual([{ type: 'text', delta: 'partial' }]);
  });

  test('a request that is already aborted never reaches the network', async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response(''); }) as typeof fetch;
    const caller = new AbortController();
    caller.abort();
    await expect(collect(createOpenRouterChatStream(CONFIG, fetchImpl)({ ...REQUEST, signal: caller.signal }))).rejects.toMatchObject({ kind: 'aborted' });
    expect(called).toBe(false);
  });
});
