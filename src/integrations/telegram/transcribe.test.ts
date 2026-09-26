/**
 * transcribeVoice — unit test against an in-process fake whisper server.
 *
 * The fake server captures the multipart body so we can lock down the wire
 * shape (URL path, multipart field names, file payload bytes). Drift here
 * would silently break voice transcription against the real
 * faster-whisper-server (issue #574).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CorpusMetadata } from '../../../stt/src/transcription-corpus.cjs';
import { transcribeVoice, TranscriptionError } from './transcribe.js';

interface CapturedRequest {
  method: string;
  url: string;
  contentType: string;
  body: Buffer;
}

interface FakeWhisper {
  baseUrl: string;
  captured: CapturedRequest[];
  setResponse(handler: (req: CapturedRequest) => { status: number; body: string; contentType?: string }): void;
  stop(): Promise<void>;
}

async function startFakeWhisper(): Promise<FakeWhisper> {
  const captured: CapturedRequest[] = [];
  let respond: (req: CapturedRequest) => { status: number; body: string; contentType?: string } = () => ({
    status: 200,
    body: JSON.stringify({ text: 'hello world' }),
    contentType: 'application/json',
  });

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const captureItem: CapturedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        contentType: String(req.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks),
      };
      captured.push(captureItem);
      const out = respond(captureItem);
      res.statusCode = out.status;
      res.setHeader('content-type', out.contentType ?? 'application/json');
      res.end(out.body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    captured,
    setResponse(handler) { respond = handler; },
    stop: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

// Plain printable ASCII fixture so the file stays text and `git diff` shows
// the test contents (a leading literal NUL trips git's binary heuristic).
const FIXTURE_OGG = Buffer.from('FAKE-OGG-PAYLOAD-1234567890');

describe('transcribeVoice — wire shape', () => {
  let fake: FakeWhisper;
  let originalWhisperModel: string | undefined;

  beforeEach(async () => {
    originalWhisperModel = process.env.WHISPER_MODEL;
    delete process.env.WHISPER_MODEL;
    fake = await startFakeWhisper();
  });
  afterEach(async () => {
    if (originalWhisperModel === undefined) {
      delete process.env.WHISPER_MODEL;
    } else {
      process.env.WHISPER_MODEL = originalWhisperModel;
    }
    await fake.stop();
  });

  it('POSTs to /v1/audio/transcriptions with multipart file + model fields', async () => {
    const text = await transcribeVoice(FIXTURE_OGG, { whisperUrl: fake.baseUrl });

    expect(text).toBe('hello world');
    expect(fake.captured).toHaveLength(1);
    const req = fake.captured[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v1/audio/transcriptions');
    expect(req.contentType).toMatch(/^multipart\/form-data; boundary=/);

    const body = req.body.toString('binary');
    expect(body).toMatch(/\sname="file"/);
    expect(body).toMatch(/filename="voice\.oga"/);
    expect(body).toMatch(/Content-Type: audio\/ogg/i);
    expect(body).toMatch(/\sname="model"\r?\n\r?\nbase\r?\n/);
    expect(body).toContain('FAKE-OGG-PAYLOAD-1234567890');
  });

  it('uses an explicit faster-whisper model override', async () => {
    await transcribeVoice(FIXTURE_OGG, { whisperUrl: fake.baseUrl, model: 'large-v3' });
    expect(fake.captured[0].body.toString('binary')).toMatch(/\sname="model"\r?\n\r?\nlarge-v3\r?\n/);
  });

  it('uses WHISPER_MODEL when no explicit model is provided', async () => {
    process.env.WHISPER_MODEL = 'small';
    await transcribeVoice(FIXTURE_OGG, { whisperUrl: fake.baseUrl });
    expect(fake.captured[0].body.toString('binary')).toMatch(/\sname="model"\r?\n\r?\nsmall\r?\n/);
  });

  it('respects a custom filename', async () => {
    await transcribeVoice(FIXTURE_OGG, { whisperUrl: fake.baseUrl, filename: 'sample.ogg' });
    expect(fake.captured[0].body.toString('binary')).toMatch(/filename="sample\.ogg"/);
  });

  it('strips trailing slash on whisperUrl', async () => {
    await transcribeVoice(FIXTURE_OGG, { whisperUrl: fake.baseUrl + '/' });
    expect(fake.captured[0].url).toBe('/v1/audio/transcriptions');
  });

  it('returns trimmed text from JSON body', async () => {
    fake.setResponse(() => ({ status: 200, body: JSON.stringify({ text: '  spaced text  ' }) }));
    const text = await transcribeVoice(FIXTURE_OGG, { whisperUrl: fake.baseUrl });
    expect(text).toBe('spaced text');
  });

  it('returns empty string when whisper transcribes silence', async () => {
    fake.setResponse(() => ({ status: 200, body: JSON.stringify({ text: '' }) }));
    const text = await transcribeVoice(FIXTURE_OGG, { whisperUrl: fake.baseUrl });
    expect(text).toBe('');
  });

  it('throws TranscriptionError on HTTP 500', async () => {
    fake.setResponse(() => ({ status: 500, body: 'boom', contentType: 'text/plain' }));
    await expect(
      transcribeVoice(FIXTURE_OGG, { whisperUrl: fake.baseUrl }),
    ).rejects.toBeInstanceOf(TranscriptionError);
  });

  it('throws TranscriptionError on missing text field', async () => {
    fake.setResponse(() => ({ status: 200, body: JSON.stringify({ unrelated: 'no text here' }) }));
    await expect(
      transcribeVoice(FIXTURE_OGG, { whisperUrl: fake.baseUrl }),
    ).rejects.toThrow(/missing "text" field/);
  });

  it('throws TranscriptionError on non-JSON body', async () => {
    fake.setResponse(() => ({ status: 200, body: 'not-json', contentType: 'text/plain' }));
    await expect(
      transcribeVoice(FIXTURE_OGG, { whisperUrl: fake.baseUrl }),
    ).rejects.toThrow(/non-JSON/);
  });

  it('aborts via AbortController on timeout', async () => {
    // Spin up a fresh server that drains the upload but never replies, so
    // the timer in transcribeVoice fires and the AbortController cancels
    // the in-flight fetch. The error message is checked specifically against
    // the abort branch (not the generic catch-all) so a regression that
    // removes the AbortController wiring would fail this test.
    const hanging = createServer((req, res) => {
      req.resume();
      void res;
    });
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', () => resolve()));
    const addr = hanging.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const err = await transcribeVoice(FIXTURE_OGG, {
        whisperUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 100,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TranscriptionError);
      // The abort branch produces "whisper request aborted after 100ms";
      // the connection-failure branch produces "whisper request failed: ...".
      // Asserting the abort message explicitly distinguishes the two.
      expect((err as Error).message).toMatch(/whisper request aborted after 100ms/);
    } finally {
      hanging.closeAllConnections?.();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });
});

describe('transcribeVoice — optional recording corpus', () => {
  let fake: FakeWhisper;
  let temporary: string;
  let directory: string;

  async function records(): Promise<Array<{
    path: string;
    record: { audio: { filename: string }; metadata: CorpusMetadata; reference: unknown };
  }>> {
    const files = await readdir(directory, { recursive: true }).catch(() => []);
    return Promise.all(files.filter((file) => file.endsWith('record.json')).map(async (file) => ({
      path: join(directory, file), record: JSON.parse(await readFile(join(directory, file), 'utf8')),
    })));
  }

  async function waitForRecords(count: number) {
    return vi.waitFor(async () => {
      const captured = await records();
      expect(captured).toHaveLength(count);
      return captured;
    });
  }

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'telegram-corpus-'));
    directory = join(temporary, 'corpus');
    vi.stubEnv('KOOKR_STT_CORPUS', 'true');
    vi.stubEnv('KOOKR_STT_CORPUS_DIR', directory);
    fake = await startFakeWhisper();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fake.stop();
    await rm(temporary, { recursive: true, force: true });
  });

  it('preserves original audio, returned text, and actual reported settings without Telegram identifiers', async () => {
    fake.setResponse(() => ({ status: 200, body: JSON.stringify({
      text: '  Bonjour Kookr.  ', language: 'French', model: 'Qwen/Qwen3-ASR-0.6B',
      recognition: {
        backend: 'qwen', model: 'Qwen/Qwen3-ASR-0.6B', modelRevision: 'pinned-revision',
        vocabulary: 'Kookr', languageHint: 'auto', maxNewTokens: 512,
        debugUrl: 'https://private.invalid/token',
      },
    }) }));
    expect(await transcribeVoice(FIXTURE_OGG, {
      whisperUrl: fake.baseUrl, model: 'Qwen/Qwen3-ASR-0.6B', filename: 'private-filename.oga',
      capture: { durationSeconds: 4, kind: 'voice' },
    })).toBe('Bonjour Kookr.');
    const [{ path, record }] = await waitForRecords(1);
    expect(await readFile(join(dirname(path), record.audio.filename))).toEqual(FIXTURE_OGG);
    expect(record.audio.filename).toBe('audio.ogg');
    expect(record.reference).toBeNull();
    expect(record.metadata).toMatchObject({
      source: 'telegram', status: 'success', transcript: 'Bonjour Kookr.', language: 'French',
      durationSeconds: 4, kind: 'voice', errorCode: null,
      model: { requested: 'Qwen/Qwen3-ASR-0.6B', reported: 'Qwen/Qwen3-ASR-0.6B', recognition: {
        backend: 'qwen', modelRevision: 'pinned-revision', vocabulary: 'Kookr', maxNewTokens: 512,
      } },
    });
    expect(record.metadata.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(Date.parse(record.metadata.startedAt))).toBe(true);
    expect(JSON.stringify(record)).not.toMatch(/private-filename|private\.invalid|127\.0\.0\.1|debugUrl/);
  });

  it('distinguishes silent success from failed recognition and retains both recordings', async () => {
    fake.setResponse(() => ({ status: 200, body: JSON.stringify({ text: '   ' }) }));
    expect(await transcribeVoice(FIXTURE_OGG, { whisperUrl: fake.baseUrl, capture: {} })).toBe('');
    await waitForRecords(1);
    fake.setResponse(() => ({ status: 503, body: 'secret token and https://private.invalid' }));
    await expect(transcribeVoice(FIXTURE_OGG, { whisperUrl: fake.baseUrl, capture: {} })).rejects.toThrow('whisper 503');
    const captured = await waitForRecords(2);
    expect(captured.map(({ record }) => record.metadata)).toEqual(expect.arrayContaining([
      expect.objectContaining({ transcript: '', status: 'success', errorCode: null }),
      expect.objectContaining({ transcript: null, status: 'error', errorCode: 'http_503' }),
    ]));
    for (const { path, record } of captured) {
      expect(await readFile(join(dirname(path), record.audio.filename))).toEqual(FIXTURE_OGG);
      expect(JSON.stringify(record)).not.toContain('private.invalid');
      expect(JSON.stringify(record)).not.toContain('secret token');
    }
  });

  it('never captures warmup or disabled requests, and reads configuration after import', async () => {
    await transcribeVoice(FIXTURE_OGG, { whisperUrl: fake.baseUrl });
    vi.stubEnv('KOOKR_STT_CORPUS', 'false');
    await transcribeVoice(FIXTURE_OGG, { whisperUrl: fake.baseUrl, capture: {} });
    vi.stubEnv('KOOKR_STT_CORPUS', 'true');
    // This queued write also provides a barrier for any earlier accidental capture.
    fake.setResponse(() => ({ status: 200, body: JSON.stringify({ text: 'captured after configuration' }) }));
    await transcribeVoice(FIXTURE_OGG, { whisperUrl: fake.baseUrl, capture: {} });
    await vi.waitFor(async () => {
      const captured = await records();
      expect(captured.some(({ record }) => record.metadata.transcript === 'captured after configuration')).toBe(true);
      expect(captured).toHaveLength(1);
    });
  });

  it('discards externally cancelled audio and uses MIME only when the extension is unknown', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(transcribeVoice(FIXTURE_OGG, {
      whisperUrl: fake.baseUrl, signal: controller.signal, capture: {},
    })).rejects.toBeInstanceOf(TranscriptionError);
    await transcribeVoice(FIXTURE_OGG, {
      whisperUrl: fake.baseUrl, filename: 'private.unknown', mimeType: 'audio/flac', capture: {},
    });
    const [{ record }] = await waitForRecords(1);
    expect(record.audio.filename).toBe('audio.flac');
    expect(record.metadata.status).toBe('success');
  });

  it('retains timed-out recordings with a fixed error code and no request URL', async () => {
    const hanging = createServer((request) => request.resume());
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    const address = hanging.address();
    if (typeof address !== 'object' || !address) throw new Error('Missing test server address');
    try {
      await expect(transcribeVoice(FIXTURE_OGG, {
        whisperUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 50, capture: {},
      })).rejects.toThrow('aborted after 50ms');
      const [{ record }] = await waitForRecords(1);
      expect(record.metadata).toMatchObject({ status: 'error', transcript: null, errorCode: 'timeout' });
      expect(JSON.stringify(record)).not.toContain('127.0.0.1');
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });

  it('keeps transcription working when the capture directory cannot be written', async () => {
    await writeFile(directory, 'a file cannot hold corpus records');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await transcribeVoice(FIXTURE_OGG, { whisperUrl: fake.baseUrl, capture: {} })).toBe('hello world');
      await vi.waitFor(() => expect(warning).toHaveBeenCalledWith('[stt-corpus] corpus_write_failed'));
      expect(await readFile(directory, 'utf8')).toBe('a file cannot hold corpus records');
    } finally {
      warning.mockRestore();
    }
  });
});
