import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WebSocket } from 'ws';

// Exercise real WebSockets and multipart HTTP uploads without loading models.
vi.mock('./vad.js', () => ({
  loadVAD: vi.fn(),
  detectSpeech: vi.fn().mockResolvedValue({ hasSpeech: true }),
}));
vi.mock('./model-loader.js', () => ({
  loadModel: vi.fn(),
  transcribe: vi.fn(),
  isModelLoaded: () => false,
  getModelVersion: () => 'test',
  getRuntimeInfo: () => ({ backend: 'test', device: 'cpu' }),
}));
vi.mock('./warmup.js', () => ({ warmupTranscriptionBackend: vi.fn() }));

function nextMessage(ws, predicate) {
  return new Promise((resolve) => {
    const listener = (raw) => {
      const message = JSON.parse(raw.toString());
      if (predicate(message)) {
        ws.off('message', listener);
        resolve(message);
      }
    };
    ws.on('message', listener);
  });
}

async function configure(ws, language, progressive = true) {
  const ack = nextMessage(ws, (message) => message.type === 'config_ack');
  ws.send(JSON.stringify({ type: 'config', language, progressive }));
  return ack;
}

function sendAudio(ws, seconds = 1) {
  ws.send(Buffer.alloc(16000 * seconds * 2));
}

async function stop(ws) {
  const final = nextMessage(ws, (message) => message.type === 'transcription' && message.is_final);
  ws.send(JSON.stringify({ type: 'stop' }));
  return final;
}

describe('WebSocket language configuration reaches Whisper', () => {
  let whisperServer;
  let stt;
  let requests;
  let clients;
  let releaseResponses;
  let holdResponses;

  beforeEach(async () => {
    vi.resetModules();
    requests = [];
    clients = [];
    releaseResponses = [];
    holdResponses = false;
    whisperServer = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const multipart = await new Request('http://localhost', {
        method: 'POST',
        headers: req.headers,
        body: Buffer.concat(chunks),
      }).formData();
      requests.push({ method: req.method, url: req.url, multipart });
      if (holdResponses) await new Promise((resolve) => releaseResponses.push(resolve));
      const language = multipart.get('language') || 'auto';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: `Speech in ${language}`, words: [] }));
    });
    whisperServer.listen(0, '127.0.0.1');
    await once(whisperServer, 'listening');
    vi.stubEnv('WHISPER_URL', `http://127.0.0.1:${whisperServer.address().port}`);
    vi.stubEnv('WHISPER_TIMEOUT_MS', '3000');
    vi.stubEnv('STT_BACKEND', 'whisper');
    vi.stubEnv('PORT', '0');
    vi.stubEnv('DEFAULT_LANGUAGE', '');
    vi.stubEnv('STT_SUPPORTED_LANGUAGES', '');
    // Keep the second audio chunk for the stop handler's final inference.
    vi.stubEnv('PROGRESSIVE_INTERVAL', '60');
  });

  afterEach(async () => {
    releaseResponses.forEach((release) => release());
    clients.forEach((ws) => ws.terminate());
    if (stt) {
      for (const ws of stt.wss.clients) ws.terminate();
      await new Promise((resolve) => stt.wss.close(resolve));
      await new Promise((resolve) => stt.httpServer.close(resolve));
      stt = undefined;
    }
    await new Promise((resolve) => whisperServer.close(resolve));
    vi.unstubAllEnvs();
  });

  async function start() {
    stt = await import('./server.js');
    const listening = once(stt.httpServer, 'listening');
    await stt.startServer();
    await listening;
  }

  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${stt.httpServer.address().port}`);
    clients.push(ws);
    await once(ws, 'open');
    return ws;
  }

  test.each(['auto', 'fr', 'en'])('uses %s for progressive and final multipart requests', async (language) => {
    await start();
    const ws = await connect();
    expect(await configure(ws, language)).toMatchObject({ language, progressive: true });
    const progressive = nextMessage(ws, (message) => message.type === 'progressive');
    sendAudio(ws);
    expect(await progressive).toMatchObject({ activeText: `Speech in ${language}` });

    sendAudio(ws, 0.5);
    expect(await stop(ws)).toMatchObject({ language, text: `Speech in ${language}` });

    expect(requests).toHaveLength(2);
    for (const { method, url, multipart } of requests) {
      expect(method).toBe('POST');
      expect(url).toBe('/v1/audio/transcriptions');
      expect(multipart.get('language')).toBe(language === 'auto' ? null : language);
      expect(multipart.get('response_format')).toBe('verbose_json');
      expect(multipart.get('timestamp_granularities[]')).toBe('word');
      const wav = Buffer.from(await multipart.get('file').arrayBuffer());
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
      expect(wav.readUInt32LE(24)).toBe(16000);
    }
  });

  test('defaults to automatic detection without a config message', async () => {
    await start();
    const ws = await connect();
    sendAudio(ws);
    expect(await stop(ws)).toMatchObject({ language: 'auto', text: 'Speech in auto' });
    expect(requests).toHaveLength(1);
    expect(requests[0].multipart.has('language')).toBe(false);
  });

  test('preserves a configured default outside the built-in language choices', async () => {
    vi.stubEnv('DEFAULT_LANGUAGE', 'es');
    await start();
    const ws = await connect();
    sendAudio(ws);
    expect(await stop(ws)).toMatchObject({ language: 'es', text: 'Speech in es' });
    expect(requests[0].multipart.get('language')).toBe('es');
  });

  test('an explicit allowlist also restricts the default and invalid-input fallback', async () => {
    vi.stubEnv('STT_SUPPORTED_LANGUAGES', 'en');
    await start();
    const ws = await connect();
    for (const language of ['fr', 'auto', 'xx', {}, null]) {
      expect(await configure(ws, language)).toMatchObject({ language: 'en' });
    }
    sendAudio(ws);
    expect(await stop(ws)).toMatchObject({ language: 'en' });
    expect(requests[0].multipart.get('language')).toBe('en');
  });

  test('keeps concurrent clients isolated while inference is pending', async () => {
    await start();
    const french = await connect();
    const english = await connect();
    await configure(french, 'fr');
    await configure(english, 'en');
    holdResponses = true;
    const frenchUpdate = nextMessage(french, (message) => message.type === 'progressive');
    const englishUpdate = nextMessage(english, (message) => message.type === 'progressive');
    sendAudio(french);
    sendAudio(english);
    await vi.waitFor(() => expect(releaseResponses).toHaveLength(2));
    expect(requests.map(({ multipart }) => multipart.get('language')).sort()).toEqual(['en', 'fr']);
    releaseResponses.forEach((release) => release());
    expect(await frenchUpdate).toMatchObject({ activeText: 'Speech in fr' });
    expect(await englishUpdate).toMatchObject({ activeText: 'Speech in en' });
    expect(await stop(french)).toMatchObject({ language: 'fr', text: 'Speech in fr' });
    expect(await stop(english)).toMatchObject({ language: 'en', text: 'Speech in en' });
  });

  test('changing language reprocesses cached non-progressive text on stop', async () => {
    await start();
    const ws = await connect();
    await configure(ws, 'en', false);
    const partial = nextMessage(ws, (message) => message.type === 'transcription' && !message.is_final);
    sendAudio(ws);
    expect(await partial).toMatchObject({ language: 'en', text: 'Speech in en' });
    await configure(ws, 'fr', false);

    expect(await stop(ws)).toMatchObject({ language: 'fr', text: 'Speech in fr' });
    expect(requests.map(({ multipart }) => multipart.get('language'))).toEqual(['en', 'fr']);
  });

  test('a config change during inference replaces the old language before finalizing', async () => {
    await start();
    const ws = await connect();
    const messages = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    await configure(ws, 'en', false);
    holdResponses = true;
    sendAudio(ws);
    await vi.waitFor(() => expect(releaseResponses).toHaveLength(1));
    await configure(ws, 'fr', false);
    holdResponses = false;
    releaseResponses[0]();

    expect(await stop(ws)).toMatchObject({ language: 'fr', text: 'Speech in fr' });
    expect(requests.map(({ multipart }) => multipart.get('language'))).toEqual(['en', 'fr']);
    expect(messages.some((message) => message.text === 'Speech in en')).toBe(false);
  });
});
