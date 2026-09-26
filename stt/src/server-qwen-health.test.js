import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('./vad.js', () => ({ loadVAD: vi.fn() }));
vi.mock('./model-loader.js', () => ({
  loadModel: vi.fn(), isModelLoaded: () => false,
  getModelVersion: () => 'unused-parakeet-model',
  getRuntimeInfo: () => ({ backend: 'wasm', device: 'cpu' }),
}));
vi.mock('./warmup.js', () => ({ warmupTranscriptionBackend: vi.fn() }));

let upstream;
let stt;
let upstreamHealth;
let upstreamStatus;

beforeEach(async () => {
  vi.resetModules();
  upstreamStatus = 200;
  upstreamHealth = {
    status: 'ok', model_loaded: true, model_name: 'Qwen/Qwen3-ASR-0.6B',
    device: 'cuda', runtime_backend: 'transformers', config_id: 'managed-vocabulary-fingerprint',
  };
  upstream = createServer((req, res) => {
    expect(req.url).toBe('/health');
    res.writeHead(upstreamStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(upstreamHealth));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  vi.stubEnv('QWEN_ASR_URL', `http://127.0.0.1:${upstream.address().port}`);
  vi.stubEnv('QWEN_ASR_MODEL', 'Qwen/Qwen3-ASR-0.6B');
  vi.stubEnv('STT_BACKEND', 'qwen');
  vi.stubEnv('PORT', '0');
  const { warmupTranscriptionBackend } = await import('./warmup.js');
  warmupTranscriptionBackend.mockResolvedValue({ ok: true, attempts: 1 });
});

afterEach(async () => {
  if (stt) {
    await new Promise((resolve) => stt.wss.close(resolve));
    if (stt.httpServer.listening) await new Promise((resolve) => stt.httpServer.close(resolve));
    stt = undefined;
  }
  if (upstream.listening) await new Promise((resolve) => upstream.close(resolve));
  vi.unstubAllEnvs();
});

async function start() {
  stt = await import('./server.js');
  const listening = once(stt.httpServer, 'listening');
  await stt.startServer();
  await listening;
  return `http://127.0.0.1:${stt.httpServer.address().port}/health`;
}

test('reports the actual upstream model, CUDA runtime and managed configuration', async () => {
  const response = await fetch(await start());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    status: 'ok', backend: 'qwen', model_loaded: true, model_name: 'Qwen/Qwen3-ASR-0.6B',
    device: 'cuda', runtime_backend: 'transformers', runtime_device: 'cuda',
    config_id: 'managed-vocabulary-fingerprint',
  });
});

test.each([
  ['different model', { model_name: 'Qwen/Qwen3-ASR-1.7B' }, 200],
  ['unloaded model', { model_loaded: false }, 200],
  ['CPU runtime', { device: 'cpu' }, 200],
  ['upstream rejection', {}, 503],
])('returns unavailable for %s and preserves actual upstream metadata', async (_name, changes, status) => {
  Object.assign(upstreamHealth, changes);
  upstreamStatus = status;
  const response = await fetch(await start());
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    status: 'unavailable', model_loaded: false,
    model_name: upstreamHealth.model_name, device: upstreamHealth.device,
  });
});

test('becomes unavailable if the upstream disappears after startup', async () => {
  const url = await start();
  expect((await fetch(url)).status).toBe(200);
  await new Promise((resolve) => upstream.close(resolve));
  const response = await fetch(url);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ status: 'unavailable', model_loaded: false, model_name: 'unknown' });
});

test('never opens the listener when Qwen warmup fails', async () => {
  const { warmupTranscriptionBackend } = await import('./warmup.js');
  warmupTranscriptionBackend.mockResolvedValue({ ok: false, attempts: 2 });
  stt = await import('./server.js');
  await expect(stt.startServer()).rejects.toThrow('Qwen ASR warmup failed');
  expect(stt.httpServer.listening).toBe(false);
});
