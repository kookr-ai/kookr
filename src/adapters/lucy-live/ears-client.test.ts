import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { earsEndpoint, openEarsTurn, transcribeOnce } from './ears-client.js';

type Behaviour = 'ok' | 'error' | 'silent' | 'drop';

interface Fake {
  url: string;
  received: Array<{ type: string; [k: string]: unknown }>;
  close(): Promise<void>;
}

async function startFake(behaviour: Behaviour = 'ok', reply = ['Hello ', 'world']): Promise<Fake> {
  const wss = new WebSocketServer({ port: 0, path: '/v1/realtime' });
  const received: Fake['received'] = [];
  wss.on('connection', (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: 'session.created' }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { type: string };
      received.push(msg);
      if (msg.type === 'session.update') ws.send(JSON.stringify({ type: 'session.updated' }));
      if (msg.type === 'response.create') {
        if (behaviour === 'error') ws.send(JSON.stringify({ type: 'error', error: { message: 'boom' } }));
        else if (behaviour === 'drop') ws.terminate();
        else if (behaviour === 'ok') {
          for (const d of reply) ws.send(JSON.stringify({ type: 'response.output_text.delta', delta: d }));
          ws.send(JSON.stringify({ type: 'response.done' }));
        }
      }
    });
  });
  await new Promise<void>((r) => wss.on('listening', () => r()));
  const port = (wss.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }),
  };
}

describe('ears client', () => {
  let fake: Fake | undefined;
  afterEach(async () => { await fake?.close(); fake = undefined; });

  it('maps http urls and appends the realtime path', () => {
    expect(earsEndpoint('http://h:1/')).toBe('ws://h:1/v1/realtime');
    expect(earsEndpoint('ws://h:1')).toBe('ws://h:1/v1/realtime');
  });

  it('sets the language, forwards buffered audio in order, then commits', async () => {
    fake = await startFake();
    const turn = openEarsTurn({ url: fake.url, language: 'fr' });
    turn.append(Buffer.from([1, 2]));
    turn.append(Buffer.from([3, 4]));
    const text = await turn.finish();
    expect(text).toBe('Hello world');
    const types = fake.received.map((m) => m.type);
    expect(types).toEqual([
      'session.update', 'input_audio_buffer.append', 'input_audio_buffer.append',
      'input_audio_buffer.commit', 'response.create',
    ]);
    expect((fake.received[0] as { session: { instructions: string } }).session.instructions).toBe('Perform ASR in French.');
    expect(Buffer.from(String(fake.received[1].audio), 'base64')).toEqual(Buffer.from([1, 2]));
  });

  it('transcribeOnce sends the whole buffer', async () => {
    fake = await startFake('ok', ['draft']);
    const text = await transcribeOnce({ url: fake.url, language: 'en', pcm: Buffer.alloc(10, 7) });
    expect(text).toBe('draft');
    expect((fake.received[0] as { session: { instructions: string } }).session.instructions).toBe('Perform ASR in English.');
  });

  it('rejects with the server error message', async () => {
    fake = await startFake('error');
    const turn = openEarsTurn({ url: fake.url, language: 'en' });
    turn.append(Buffer.alloc(4));
    await expect(turn.finish()).rejects.toThrow('boom');
  });

  it('rejects when the connection drops mid-turn', async () => {
    fake = await startFake('drop');
    const turn = openEarsTurn({ url: fake.url, language: 'en' });
    await expect(turn.finish()).rejects.toThrow(/closed|failed/);
  });

  it('times out when no transcript arrives', async () => {
    fake = await startFake('silent');
    const turn = openEarsTurn({ url: fake.url, language: 'en', finishTimeoutMs: 50 });
    await expect(turn.finish()).rejects.toThrow('too long');
  });

  it('rejects when nothing is listening', async () => {
    const turn = openEarsTurn({ url: 'ws://127.0.0.1:1', language: 'en' });
    await expect(turn.finish()).rejects.toThrow(/failed/);
  });

  it('abort rejects a pending finish and an abort before finish is not unhandled', async () => {
    fake = await startFake('silent');
    const t1 = openEarsTurn({ url: fake.url, language: 'en' });
    const p = t1.finish();
    t1.abort();
    await expect(p).rejects.toThrow('aborted');
    const t2 = openEarsTurn({ url: fake.url, language: 'en' });
    t2.abort();
    await expect(t2.finish()).rejects.toThrow('aborted');
  });

  it('transcribeOnce honours an abort signal', async () => {
    fake = await startFake('silent');
    const ac = new AbortController();
    const p = transcribeOnce({ url: fake.url, language: 'en', pcm: Buffer.alloc(4), signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toThrow('aborted');
  });
});
