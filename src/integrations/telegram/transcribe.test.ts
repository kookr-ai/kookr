/**
 * transcribeVoice — unit test against an in-process fake whisper server.
 *
 * The fake server captures the multipart body so we can lock down the wire
 * shape (URL path, multipart field names, file payload bytes). Drift here
 * would silently break voice transcription against the real
 * faster-whisper-server (issue #574).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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

  beforeEach(async () => { fake = await startFakeWhisper(); });
  afterEach(async () => { await fake.stop(); });

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
    expect(body).toMatch(/\sname="model"\r?\n\r?\nwhisper-1\r?\n/);
    expect(body).toContain('FAKE-OGG-PAYLOAD-1234567890');
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
