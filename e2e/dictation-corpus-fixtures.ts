import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test as base, expect } from './fixtures.js';
import { sanitizedChildServerEnv } from './child-server-env.js';

interface CorpusService {
  url: string;
  root: string;
  prediction: string;
  control(action: 'hold' | 'release' | 'fail'): Promise<void>;
}

async function ready(proc: ChildProcess, marker: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = '';
    let errors = '';
    const timeout = setTimeout(() => reject(new Error(`Fixture startup timed out: ${output}\n${errors}`)), 20_000);
    proc.stdout!.on('data', (bytes: Buffer) => {
      output += bytes.toString();
      const match = output.match(new RegExp(`${marker}=(\\d+)`));
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    });
    proc.stderr!.on('data', (bytes: Buffer) => { errors += bytes.toString(); });
    proc.once('error', error => { clearTimeout(timeout); reject(error); });
    proc.once('exit', code => { clearTimeout(timeout); reject(new Error(`Fixture exited ${code}: ${output}\n${errors}`)); });
  });
}

async function stop(proc: ChildProcess) {
  if (proc.exitCode !== null) return;
  const exited = once(proc, 'exit');
  proc.kill('SIGTERM');
  const timeout = setTimeout(() => proc.kill('SIGKILL'), 5_000);
  await exited;
  clearTimeout(timeout);
}

export const test = base.extend<object, { corpus: CorpusService; corpusEnabled: boolean }>({
  corpusEnabled: [true, { scope: 'worker', option: true }],
  corpus: [async ({ corpusEnabled }, use) => {
    const root = await mkdtemp(join(tmpdir(), 'kookr-browser-corpus-'));
    const state = { prediction: 'Bonjour, ceci est la prédiction originale.' };
    const inference = createServer(async (request, response) => {
      for await (const _chunk of request) { /* Consume controlled WAV multipart data. */ }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(request.url === '/health'
        ? { status: 'ok', model_loaded: true, model_name: 'corpus-cpu-fixture', device: 'cuda' }
        : { text: state.prediction, words: [], recognition: {
          model: 'corpus-cpu-fixture', revision: 'fixture-revision-1',
          vocabulary: 'Kookr', decoding: { temperature: 0 },
        } }));
    });
    inference.listen(0, '127.0.0.1');
    await once(inference, 'listening');
    const address = inference.address();
    if (!address || typeof address === 'string') throw new Error('Inference fixture did not bind a TCP port');
    const proc = spawn('node', [join(__dirname, 'dictation-corpus-sidecar.mjs')], {
      cwd: join(__dirname, '..'),
      env: sanitizedChildServerEnv({
        STT_BACKEND: 'qwen', QWEN_ASR_MODEL: 'corpus-cpu-fixture',
        QWEN_ASR_URL: `http://127.0.0.1:${address.port}`,
        KOOKR_STT_CORPUS: String(corpusEnabled), KOOKR_STT_CORPUS_DIR: root,
        PROGRESSIVE_INTERVAL: '60', MIN_AUDIO_SECONDS: '1',
      }),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    try {
      const port = await ready(proc, 'CORPUS_STT_PORT');
      await use({
        url: `ws://127.0.0.1:${port}`, root,
        get prediction() { return state.prediction; },
        set prediction(value) { state.prediction = value; },
        control: (action) => new Promise<void>((resolve, reject) => {
          const id = randomUUID();
          const timeout = setTimeout(() => { proc.off('message', listener); reject(new Error('Sidecar control timed out')); }, 5_000);
          const listener = (message: unknown) => {
            if (typeof message === 'object' && message !== null && 'id' in message && message.id === id) {
              clearTimeout(timeout); proc.off('message', listener); resolve();
            }
          };
          proc.on('message', listener);
          proc.send({ id, action });
        }),
      });
    } finally {
      await stop(proc);
      await new Promise<void>(resolve => inference.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],
  serverURL: [async ({ corpus }, use) => {
    const proc = spawn('node', ['--import', 'tsx', join(__dirname, 'test-server.ts')], {
      cwd: join(__dirname, '..'),
      env: sanitizedChildServerEnv({ E2E_PORT: '0', E2E_STT_URL: corpus.url, KOOKR_PROMPT_SUBMIT_BRACKETED_PASTE: '0' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await use(`http://127.0.0.1:${await ready(proc, 'E2E_PORT')}`);
    } finally { await stop(proc); }
  }, { scope: 'worker' }],
});

export { expect };
