import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { transcribe } = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock('./backends/index.js', () => ({
  createTranscriptionBackend: () => ({ name: 'qwen', modelName: 'test-model', transcribe }),
}));
vi.mock('./vad.js', () => ({ loadVAD: vi.fn(), detectSpeech: vi.fn().mockResolvedValue({ hasSpeech: true }) }));
vi.mock('./model-loader.js', () => ({
  loadModel: vi.fn(), isModelLoaded: () => false, getModelVersion: () => 'unused',
  getRuntimeInfo: () => ({ backend: 'wasm', device: 'cpu' }),
}));
vi.mock('./warmup.js', () => ({ warmupTranscriptionBackend: vi.fn().mockResolvedValue({ ok: true }) }));

let root;
let stt;
let clients;

function next(ws, predicate) {
  return new Promise((resolve) => {
    const listener = (bytes) => {
      const frame = JSON.parse(bytes);
      if (predicate(frame)) { ws.off('message', listener); resolve(frame); }
    };
    ws.on('message', listener);
  });
}

async function control(ws, message, response) {
  const pending = next(ws, response);
  ws.send(JSON.stringify(message));
  return pending;
}

async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${stt.httpServer.address().port}`);
  clients.push(ws);
  await once(ws, 'open');
  await control(ws, { type: 'config', language: 'fr', progressive: true }, (f) => f.type === 'config_ack');
  return ws;
}

async function records() {
  await stt.transcriptionCorpus.flush();
  const result = [];
  for (const date of await readdir(root)) {
    for (const id of await readdir(join(root, date))) {
      const directory = join(root, date, id);
      result.push({ directory, record: JSON.parse(await readFile(join(directory, 'record.json'))) });
    }
  }
  return result;
}

beforeEach(async () => {
  vi.resetModules();
  root = await mkdtemp(join(tmpdir(), 'stt-corpus-ws-'));
  clients = [];
  vi.stubEnv('KOOKR_STT_CORPUS', 'true');
  vi.stubEnv('KOOKR_STT_CORPUS_DIR', root);
  vi.stubEnv('STT_MAX_BUFFER_SECONDS', '1');
  vi.stubEnv('PROGRESSIVE_INTERVAL', '60');
  vi.stubEnv('PORT', '0');
  transcribe.mockReset().mockResolvedValue({
    text: 'Bonjour Kookr.', sentences: [], recognition: { model: 'test-model', vocabulary: 'Kookr' },
  });
});

async function start() {
  stt = await import('./server.js');
  const listening = once(stt.httpServer, 'listening');
  await stt.startServer();
  await listening;
}

afterEach(async () => {
  clients.forEach((ws) => ws.terminate());
  if (stt) {
    for (const ws of stt.wss.clients) ws.terminate();
    await new Promise((resolve) => stt.wss.close(resolve));
    await new Promise((resolve) => stt.httpServer.close(resolve));
    await stt.transcriptionCorpus.flush();
  }
  stt = null;
  await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

test('saves full original PCM once with final text despite rolling-window trimming', async () => {
  vi.stubEnv('STT_MAX_BUFFER_SECONDS', '2');
  vi.stubEnv('MAX_WINDOW_SIZE', '1');
  vi.stubEnv('SENTENCE_BUFFER', '0.5');
  transcribe
    .mockResolvedValueOnce({ text: 'Bonjour. Provisional preview.', sentences: [
      { text: 'Bonjour.', start: 0, end: 1 }, { text: 'Provisional preview.', start: 1, end: 2 },
    ] })
    .mockResolvedValueOnce({ text: 'Provisional preview.', sentences: [] })
    .mockResolvedValueOnce({ text: 'Kookr.', sentences: [], recognition: { vocabulary: 'Kookr' } });
  await start();
  const ws = await connect();
  const audio = Buffer.alloc(16000 * 3 * 2);
  for (let n = 0; n < audio.length / 2; n++) audio.writeInt16LE((n % 64000) - 32000, n * 2);
  const partial = next(ws, (f) => f.type === 'progressive');
  ws.send(audio.subarray(0, 64000));
  expect((await partial).activeText).toBe('Provisional preview.');
  expect(await records()).toEqual([]);
  ws.send(audio.subarray(64000));
  const final = await control(ws, { type: 'stop' }, (f) => f.is_final);
  ws.send(JSON.stringify({ type: 'stop' }));
  await control(ws, { type: 'ping' }, (f) => f.type === 'pong');
  expect(final.text).toBe('Bonjour. Kookr.');
  const saved = await records();
  expect(saved).toHaveLength(1);
  expect(saved[0].record.metadata).toMatchObject({
    source: 'browser', status: 'success', transcript: final.text, durationSeconds: 3,
    language: 'fr', model: { requested: 'test-model', recognition: { vocabulary: 'Kookr' } },
  });
  const wav = await readFile(join(saved[0].directory, saved[0].record.audio.filename));
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.readUInt32LE(24)).toBe(16000);
  expect(wav.subarray(44)).toEqual(audio);
});

test('disabled collection writes nothing and preserves transcription', async () => {
  vi.stubEnv('KOOKR_STT_CORPUS', 'false');
  await start();
  const ws = await connect();
  ws.send(Buffer.alloc(32000));
  const final = await control(ws, { type: 'stop' }, (f) => f.is_final);
  expect(final.text).toBe('Bonjour Kookr.');
  expect(await records()).toEqual([]);
});

test('clear and disconnected recordings are excluded, including preceding warmup', async () => {
  await start();
  expect(await records()).toEqual([]);
  const ws = await connect();
  ws.send(Buffer.alloc(32000));
  await control(ws, { type: 'clear' }, (f) => f.type === 'cleared');
  ws.send(Buffer.alloc(32000));
  ws.close();
  await once(ws, 'close');
  expect(await records()).toEqual([]);
});

test('clearing a pending inference excludes its audio and provenance from the next recording', async () => {
  let release;
  transcribe.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  await start();
  const ws = await connect();
  ws.send(Buffer.alloc(32000, 1));
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await control(ws, { type: 'clear' }, (f) => f.type === 'cleared');
  const nextAudio = Buffer.alloc(32000, 2);
  ws.send(nextAudio);
  release({ text: 'Old recording.', sentences: [], recognition: { vocabulary: 'old' } });
  await control(ws, { type: 'ping' }, (f) => f.type === 'pong');
  const final = await control(ws, { type: 'stop' }, (f) => f.is_final);
  const saved = await records();
  expect(saved).toHaveLength(1);
  expect(saved[0].record.metadata.transcript).toBe(final.text);
  expect(saved[0].record.metadata.transcript).toBe('Bonjour Kookr.');
  expect(saved[0].record.metadata.model.recognition.vocabulary).toBe('Kookr');
  const wav = await readFile(join(saved[0].directory, saved[0].record.audio.filename));
  expect(wav.subarray(44)).toEqual(nextAudio);
});

test('empty successful recognition is retained as an empty prediction', async () => {
  transcribe.mockResolvedValue({ text: '', sentences: [] });
  await start();
  const ws = await connect();
  ws.send(Buffer.alloc(32000));
  await control(ws, { type: 'stop' }, (f) => f.is_final);
  const saved = await records();
  expect(saved).toHaveLength(1);
  expect(saved[0].record.metadata).toMatchObject({ transcript: '', status: 'success' });
  expect(saved[0].record.reference).toBeNull();
});

test('inference failure is distinguished from a successful empty prediction', async () => {
  transcribe.mockRejectedValue(new Error('inference unavailable'));
  await start();
  const ws = await connect();
  ws.send(Buffer.alloc(32000));
  await control(ws, { type: 'stop' }, (f) => f.type === 'error');
  const saved = await records();
  expect(saved).toHaveLength(1);
  expect(saved[0].record.metadata).toMatchObject({ status: 'error', errorCode: 'inference_failed' });
});
