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

test('transcribes even a short trailing chunk before sending a successful final', async () => {
  const ws = await connect();
  const ack = nextMessage(ws, 'config_ack');
  ws.send(JSON.stringify({ type: 'config', progressive: false }));
  await ack;
  ws.send(Buffer.alloc(32000));
  await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
  const partial = nextMessage(ws, 'transcription');
  complete[0]({ text: 'Before the last word', sentences: [] });
  await partial;
  ws.send(Buffer.alloc(3200)); // 100ms is still unprocessed recording content.
  ws.send(JSON.stringify({ type: 'stop' }));
  await ping(ws);
  expect(transcribe).toHaveBeenCalledTimes(2);
  const final = nextMessage(ws, 'transcription');
  complete[1]({ text: 'Before the last word END', sentences: [] });
  expect(await final).toMatchObject({ text: 'Before the last word END', is_final: true });
});

test('final inference failure reports incomplete progressive text instead of a successful final', async () => {
  const ws = await connect();
  ws.send(Buffer.alloc(32000));
  await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
  const partial = nextMessage(ws, 'progressive');
  complete[0]({ text: 'Preserve this preview', sentences: [] });
  await partial;
  transcribe.mockRejectedValueOnce(new Error('upstream unavailable'));
  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  ws.send(Buffer.alloc(32000));
  ws.send(JSON.stringify({ type: 'stop' }));
  await ping(ws);
  await vi.waitFor(() => expect(messages.some((message) => message.type === 'error')).toBe(true));
  expect(messages.find((message) => message.type === 'error'))
    .toMatchObject({ partial_text: 'Preserve this preview', code: 'inference_failed' });
  expect(messages.some((message) => message.is_final)).toBe(false);
});

test('clear aborts the old inference and suppresses its late preview', async () => {
  const ws = await connect();
  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  ws.send(Buffer.alloc(32000));
  await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
  const oldSignal = transcribe.mock.calls[0][1].signal;
  const cleared = nextMessage(ws, 'cleared');
  ws.send(JSON.stringify({ type: 'clear' }));
  await cleared;
  expect(oldSignal?.aborted).toBe(true);
  complete[0]({ text: 'Old recording', sentences: [] });
  await ping(ws);
  expect(messages.some((message) => message.activeText === 'Old recording')).toBe(false);
  ws.send(Buffer.alloc(32000));
  await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2));
  const partial = nextMessage(ws, 'progressive');
  complete[1]({ text: 'New recording', sentences: [] });
  expect(await partial).toMatchObject({ fixedText: '', activeText: 'New recording' });
});

test.each([45, 120, 290, 310, 610])('preserves each encoded segment once across %is of audio and the final 100ms', async (duration) => {
  // CPU lifecycle fixture: each second is an integer marker, decoded by the
  // fake backend. This accelerated run tests segment ownership, not ASR quality
  // or live latency (the separate browser experiment covers real speech).
  transcribe.mockImplementation(async (audio) => {
    const sentences = [];
    for (let sample = 0; sample < audio.length; sample += 16000) {
      const marker = Math.round(audio[sample] * 32768);
      sentences.push({
        text: marker === 30000 ? 'END.' : `Segment${marker}.`,
        start: sample / 16000,
        end: Math.min(sample + 16000, audio.length) / 16000,
      });
    }
    return { text: sentences.map(({ text }) => text).join(' '), sentences };
  });
  const ws = await connect();
  const messages = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  const ack = nextMessage(ws, 'config_ack');
  ws.send(JSON.stringify({ type: 'config', progressive: false }));
  await ack;
  vi.useFakeTimers({ toFake: ['Date'] });
  for (let second = 0; second < duration; second += 30) {
    const seconds = Math.min(30, duration - second);
    const pcm = new Int16Array(seconds * 16000);
    for (let n = 0; n < seconds; n++) pcm.fill(second + n + 1, n * 16000, (n + 1) * 16000);
    const partial = nextMessage(ws, 'transcription');
    ws.send(Buffer.from(pcm.buffer));
    await partial;
    vi.setSystemTime(Date.now() + 61_000);
  }
  // Keep the tiny tail out of incremental processing and require stop to
  // consume it, even when the physical rolling-buffer length is unchanged.
  vi.setSystemTime(Date.now() - 61_000);
  ws.send(Buffer.from(new Int16Array(1600).fill(30000).buffer));
  const final = nextMessage(ws, 'transcription');
  ws.send(JSON.stringify({ type: 'stop' }));
  expect((await final).text).toBe([
    ...Array.from({ length: duration }, (_, n) => `Segment${n + 1}.`), 'END.',
  ].join(' '));
  ws.send(JSON.stringify({ type: 'stop' }));
  await ping(ws);
  expect(messages.filter((message) => message.is_final)).toHaveLength(1);
  expect(Math.max(...transcribe.mock.calls.map(([audio]) => audio.length)))
    .toBeLessThanOrEqual(16000 * 300);
});

test('clear while stop is draining cannot reset or finalize the next recording', async () => {
  const ws = await connect();
  ws.send(Buffer.alloc(32000));
  await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
  ws.send(JSON.stringify({ type: 'stop' }));
  await ping(ws);
  const cleared = nextMessage(ws, 'cleared');
  ws.send(JSON.stringify({ type: 'clear' }));
  await cleared;
  ws.send(Buffer.alloc(32000));
  await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2));
  complete[0]({ text: 'Retired', sentences: [] });
  const partial = nextMessage(ws, 'progressive');
  complete[1]({ text: 'Current', sentences: [] });
  expect(await partial).toMatchObject({ activeText: 'Current' });
  const final = nextMessage(ws, 'transcription');
  ws.send(JSON.stringify({ type: 'stop' }));
  expect(await final).toMatchObject({ text: 'Current', is_final: true });
});

test('disconnect aborts pending inference', async () => {
  const ws = await connect();
  ws.send(Buffer.alloc(32000));
  await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
  const signal = transcribe.mock.calls[0][1].signal;
  ws.close();
  await once(ws, 'close');
  await vi.waitFor(() => expect(signal.aborted).toBe(true));
});
