import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, expect, test, vi } from 'vitest';

const { transcribe } = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock('./backends/index.js', () => ({ createTranscriptionBackend: () => ({ name: 'qwen', transcribe }) }));
vi.mock('./vad.js', () => ({ loadVAD: vi.fn(), detectSpeech: vi.fn().mockResolvedValue({ hasSpeech: true }) }));
vi.mock('./model-loader.js', () => ({
  loadModel: vi.fn(), isModelLoaded: () => false, getModelVersion: () => 'unused',
  getRuntimeInfo: () => ({ backend: 'wasm', device: 'cpu' }),
}));
vi.mock('./warmup.js', () => ({ warmupTranscriptionBackend: vi.fn().mockResolvedValue({ ok: true }) }));

let stt;
let client;
let releaseInference;

function nextMessage(type) {
  return new Promise((resolve) => {
    const listener = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === type) { client.off('message', listener); resolve(message); }
    };
    client.on('message', listener);
  });
}

afterEach(async () => {
  releaseInference?.();
  client?.terminate();
  if (stt) {
    for (const ws of stt.wss.clients) ws.terminate();
    await new Promise((resolve) => stt.wss.close(resolve));
    await new Promise((resolve) => stt.httpServer.close(resolve));
  }
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test('stop reports incomplete preview when slow inference lets unfixed audio leave the buffer', async () => {
  vi.stubEnv('PORT', '0');
  vi.stubEnv('PROGRESSIVE_INTERVAL', '0');
  vi.stubEnv('STT_MAX_BUFFER_SECONDS', '3');
  transcribe
    .mockResolvedValueOnce({ text: 'Earlier preview.', sentences: [] })
    .mockImplementationOnce(() => new Promise((_resolve, reject) => {
      releaseInference = () => reject(new Error('Delayed inference failed'));
    }));
  stt = await import('./server.js');
  const listening = once(stt.httpServer, 'listening');
  await stt.startServer();
  await listening;
  client = new WebSocket(`ws://127.0.0.1:${stt.httpServer.address().port}`);
  await once(client, 'open');
  const messages = [];
  client.on('message', (raw) => messages.push(JSON.parse(raw.toString())));

  const preview = nextMessage('progressive');
  client.send(Buffer.alloc(32000));
  expect(await preview).toMatchObject({ activeText: 'Earlier preview.' });
  client.send(Buffer.alloc(32000));
  await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(2));
  // Four seconds total in a three-second buffer; the pending request has
  // only the first two seconds, and no sentence has been fixed yet.
  client.send(Buffer.alloc(64000));
  const error = nextMessage('error');
  const closed = once(client, 'close');
  client.send(JSON.stringify({ type: 'stop' }));
  const pong = nextMessage('pong');
  client.send(JSON.stringify({ type: 'ping' }));
  await pong;
  expect(messages.some((message) => message.type === 'error')).toBe(false);

  releaseInference();
  expect(await error).toMatchObject({ code: 'audio_window_exhausted', partial_text: 'Earlier preview.' });
  expect((await closed)[0]).toBe(1011);
  expect(messages.some((message) => message.is_final)).toBe(false);
  expect(transcribe).toHaveBeenCalledTimes(2);
});
