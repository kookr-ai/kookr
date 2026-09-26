import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { transcribe } = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock('./backends/index.js', () => ({ createTranscriptionBackend: () => ({ name: 'qwen', transcribe }) }));
vi.mock('./vad.js', () => ({ loadVAD: vi.fn(), detectSpeech: vi.fn().mockResolvedValue({ hasSpeech: true }) }));
vi.mock('./model-loader.js', () => ({
  loadModel: vi.fn(), isModelLoaded: () => false, getModelVersion: () => 'unused',
  getRuntimeInfo: () => ({ backend: 'wasm', device: 'cpu' }),
}));
vi.mock('./warmup.js', () => ({ warmupTranscriptionBackend: vi.fn().mockResolvedValue({ ok: true }) }));

let stt;
let clients;
let complete;

function nextMessage(ws, type) {
  return new Promise((resolve) => {
    const listener = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === type) { ws.off('message', listener); resolve(message); }
    };
    ws.on('message', listener);
  });
}

async function ping(ws) {
  const pong = nextMessage(ws, 'pong');
  ws.send(JSON.stringify({ type: 'ping' }));
  await pong;
}

async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${stt.httpServer.address().port}`);
  clients.push(ws);
  await once(ws, 'open');
  return ws;
}

beforeEach(async () => {
  vi.resetModules();
  transcribe.mockReset();
  complete = [];
  transcribe.mockImplementation(() => new Promise((resolve) => complete.push(resolve)));
  clients = [];
  vi.stubEnv('PORT', '0');
  vi.stubEnv('PROGRESSIVE_INTERVAL', '60');
  stt = await import('./server.js');
  const listening = once(stt.httpServer, 'listening');
  await stt.startServer();
  await listening;
});

afterEach(async () => {
  vi.useRealTimers();
  complete.forEach((resolve) => resolve({ text: '', sentences: [] }));
  clients.forEach((ws) => ws.terminate());
  for (const ws of stt.wss.clients) ws.terminate();
  await new Promise((resolve) => stt.wss.close(resolve));
  await new Promise((resolve) => stt.httpServer.close(resolve));
  vi.unstubAllEnvs();
});

test('drains a slow inference before finalizing, ignoring duplicate stop and late audio', async () => {
  const ws = await connect();
  const ack = nextMessage(ws, 'config_ack');
  ws.send(JSON.stringify({ type: 'config', language: 'fr' }));
  expect(await ack).toMatchObject({ finalization_timeout_ms: 125_000 });
  ws.send(Buffer.alloc(16000 * 2));
  await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
  ws.send(Buffer.alloc(16000 * 2));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  ws.send(JSON.stringify({ type: 'stop' }));
  ws.send(JSON.stringify({ type: 'stop' }));
  ws.send(Buffer.alloc(16000 * 2));
  await ping(ws);
  await vi.advanceTimersByTimeAsync(31_000);
  expect(transcribe).toHaveBeenCalledTimes(1);

  const progressive = nextMessage(ws, 'progressive');
  complete[0]({ text: 'Première partie.', sentences: [] });
  await progressive;
  expect(transcribe).toHaveBeenCalledTimes(2);
  expect(transcribe.mock.calls[1][0]).toHaveLength(32000);
  const final = nextMessage(ws, 'transcription');
  complete[1]({ text: 'Première partie et fin.', sentences: [] });
  expect(await final).toMatchObject({ text: 'Première partie et fin.', is_final: true });
  await ping(ws);
  expect(transcribe).toHaveBeenCalledTimes(2);
});

test.each(['draining', 'final inference'])('closes on the total deadline while %s and isolates late results', async (phase) => {
  const ws = await connect();
  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  ws.send(Buffer.alloc(16000 * 2));
  await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
  if (phase === 'final inference') {
    const progressive = nextMessage(ws, 'progressive');
    complete[0]({ text: 'Earlier preview.', sentences: [] });
    await progressive;
    ws.send(Buffer.alloc(16000 * 2));
  }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  ws.send(JSON.stringify({ type: 'stop' }));
  await ping(ws);
  const error = nextMessage(ws, 'error');
  const closed = once(ws, 'close');
  await vi.advanceTimersByTimeAsync(120_000);
  expect(await error).toMatchObject({ error: 'Transcription timed out. Please try again.' });
  expect((await closed)[0]).toBe(1011);
  complete.at(-1)({ text: 'Late result.', sentences: [] });
  await Promise.resolve();
  expect(messages.some((message) => message.is_final)).toBe(false);

  // A new connection owns a fresh handler even if the retired inference settles.
  const next = await connect();
  next.send(Buffer.alloc(16000 * 2));
  await ping(next);
  const fresh = nextMessage(next, 'progressive');
  complete.at(-1)({ text: 'Fresh recording.', sentences: [] });
  expect(await fresh).toMatchObject({ fixedText: '', activeText: 'Fresh recording.' });
});
