import { describe, expect, it } from 'vitest';
import {
  BasetenStreamError,
  readBasetenStreamConfig,
  SseDeltaParser,
  streamBasetenChat,
  type BasetenStreamConfig,
} from './baseten-stream.js';
import { DEFAULT_MODEL } from './baseten-client.js';

const CONFIG: BasetenStreamConfig = { apiKey: 'k', model: 'm', baseUrl: 'https://example.test/v1/' };

function sse(...payloads: string[]): string {
  return payloads.map((p) => `data: ${p}\n\n`).join('');
}
function delta(content: string): string {
  return JSON.stringify({ choices: [{ delta: { content } }] });
}
function streamOf(chunks: string[], signal?: AbortSignal): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (signal?.aborted) { controller.error(new Error('aborted')); return; }
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
  return new Response(body, { status: 200 });
}
async function collect(gen: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of gen) out.push(d);
  return out;
}

describe('SseDeltaParser', () => {
  it('reassembles lines split across chunks and stops at [DONE]', () => {
    const p = new SseDeltaParser();
    const text = sse(delta('Hel'), delta('lo'), '[DONE]', delta('ignored'));
    const out: string[] = [];
    for (let i = 0; i < text.length; i += 7) out.push(...p.push(text.slice(i, i + 7)));
    expect(out).toEqual(['Hel', 'lo']);
    expect(p.done).toBe(true);
  });

  it('ignores comments, role-only deltas, empty choices and non-JSON data', () => {
    const p = new SseDeltaParser();
    const out = p.push([
      ': keep-alive',
      'event: message',
      `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}`,
      `data: ${JSON.stringify({ choices: [] })}`,
      'data: not json',
      `data: ${delta('ok')}`,
      '',
    ].join('\r\n'));
    expect(out).toEqual(['ok']);
  });

  it('end() flushes a final line without newline', () => {
    const p = new SseDeltaParser();
    expect(p.push(`data: ${delta('tail')}`)).toEqual([]);
    expect(p.end()).toEqual(['tail']);
  });
});

describe('streamBasetenChat', () => {
  it('posts a streaming request with reasoning off and yields deltas', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return streamOf([sse(delta('Hi '), delta('there')), sse('[DONE]')]);
    }) as unknown as typeof fetch;
    const out = await collect(streamBasetenChat(CONFIG, { messages: [{ role: 'user', content: 'yo' }] }, fetchImpl));
    expect(out).toEqual(['Hi ', 'there']);
    expect(seen?.url).toBe('https://example.test/v1/chat/completions');
    const body = JSON.parse(String(seen?.init.body));
    expect(body).toMatchObject({ model: 'm', stream: true, max_tokens: 200, temperature: 0.3, reasoning_effort: 'none' });
    expect((seen?.init.headers as Record<string, string>).authorization).toBe('Bearer k');
  });

  it('throws an http error without leaking the key', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const err = await collect(streamBasetenChat(CONFIG, { messages: [] }, fetchImpl)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BasetenStreamError);
    expect((err as BasetenStreamError).kind).toBe('http');
    expect((err as Error).message).not.toContain('Bearer');
  });

  it('aborts mid-stream when the caller aborts', async () => {
    const ac = new AbortController();
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(sse(delta('first'))));
          init.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const got: string[] = [];
    const run = (async () => {
      for await (const d of streamBasetenChat(CONFIG, { messages: [], signal: ac.signal }, fetchImpl)) {
        got.push(d);
        ac.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ kind: 'aborted' });
    expect(got).toEqual(['first']);
  });

  it('refuses to start when already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const fetchImpl = (async () => { throw new Error('should not fetch'); }) as unknown as typeof fetch;
    await expect(collect(streamBasetenChat(CONFIG, { messages: [], signal: ac.signal }, fetchImpl)))
      .rejects.toMatchObject({ kind: 'aborted' });
  });

  it('times out a stalled stream', async () => {
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) { init.signal?.addEventListener('abort', () => controller.error(new Error('x'))); },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    await expect(collect(streamBasetenChat(CONFIG, { messages: [], timeoutMs: 20 }, fetchImpl)))
      .rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('readBasetenStreamConfig', () => {
  it('returns null without a key and prefers the Kookr-scoped key', () => {
    expect(readBasetenStreamConfig({})).toBeNull();
    const cfg = readBasetenStreamConfig({ KOOKR_BASETEN_API_KEY: 'a', BASETEN_API_KEY: 'b' });
    expect(cfg).toMatchObject({ apiKey: 'a', model: DEFAULT_MODEL });
    expect(readBasetenStreamConfig({ BASETEN_API_KEY: 'b', KOOKR_BASETEN_MODEL: 'x' })).toMatchObject({ apiKey: 'b', model: 'x' });
  });
});
