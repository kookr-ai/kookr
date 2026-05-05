import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { startVoiceWarmup } from './warmup.js';

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
    body: JSON.stringify({ text: '' }),
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

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}

function extractMultipartFile(body: Buffer, filename: string): Buffer {
  const filenameAt = body.indexOf(Buffer.from(`filename="${filename}"`));
  expect(filenameAt).toBeGreaterThanOrEqual(0);
  const dataStart = body.indexOf(Buffer.from('\r\n\r\n'), filenameAt) + 4;
  const dataEnd = body.indexOf(Buffer.from('\r\n--'), dataStart);
  expect(dataStart).toBeGreaterThanOrEqual(4);
  expect(dataEnd).toBeGreaterThan(dataStart);
  return body.subarray(dataStart, dataEnd);
}

describe('Telegram voice warmup', () => {
  it('POSTs the bundled fixture to whisper and records success timing', async () => {
    const fake = await startFakeWhisper();
    const audit = vi.fn();
    const logger = { log: vi.fn(), warn: vi.fn() };
    try {
      startVoiceWarmup({
        whisperUrl: fake.baseUrl,
        timeoutMs: 1000,
        audit,
        logger,
      });
      await waitFor(() => audit.mock.calls.some(([event]) => typeof event.okMs === 'number'));

      expect(fake.captured).toHaveLength(1);
      const req = fake.captured[0];
      expect(req.method).toBe('POST');
      expect(req.url).toBe('/v1/audio/transcriptions');
      expect(req.contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(req.body.toString('binary')).toContain('filename="kookr-warmup.ogg"');
      const file = extractMultipartFile(req.body, 'kookr-warmup.ogg');
      expect(file.length).toBe(1773);
      expect(file.subarray(0, 4).toString('ascii')).toBe('OggS');
      expect(createHash('sha256').update(file).digest('hex')).toBe(
        'c860f8e70886daee8191b66b2c7819ad7840e136a21f091f28f0c668ead83193',
      );
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'voice_warmup',
        okMs: expect.any(Number),
      }));
      expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/\[telegram\] voice warmup: ok/));
    } finally {
      await fake.stop();
    }
  });

  it('records failure timing without throwing', async () => {
    const fake = await startFakeWhisper();
    const audit = vi.fn();
    const logger = { log: vi.fn(), warn: vi.fn() };
    fake.setResponse(() => ({ status: 500, body: 'model failed', contentType: 'text/plain' }));
    try {
      startVoiceWarmup({
        whisperUrl: fake.baseUrl,
        timeoutMs: 1000,
        audit,
        logger,
      });
      await waitFor(() => audit.mock.calls.some(([event]) => typeof event.errMs === 'number'));

      expect(audit).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'voice_warmup',
        errMs: expect.any(Number),
        reason: expect.stringContaining('whisper 500'),
      }));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/voice warmup FAILED/));
    } finally {
      await fake.stop();
    }
  });

  it('starts the warmup in the background', async () => {
    const fake = await startFakeWhisper();
    const audit = vi.fn();
    const logger = { log: vi.fn(), warn: vi.fn() };
    try {
      const startedAt = Date.now();
      startVoiceWarmup({
        whisperUrl: fake.baseUrl,
        timeoutMs: 1000,
        audit,
        logger,
      });

      expect(Date.now() - startedAt).toBeLessThan(50);
      await waitFor(() => audit.mock.calls.some(([event]) => typeof event.okMs === 'number'));
      expect(fake.captured).toHaveLength(1);
    } finally {
      await fake.stop();
    }
  });

  it('can cancel a scheduled warmup before it posts', async () => {
    vi.useFakeTimers();
    const audit = vi.fn();
    const logger = { log: vi.fn(), warn: vi.fn() };
    try {
      const handle = startVoiceWarmup({
        whisperUrl: 'http://127.0.0.1:1',
        timeoutMs: 1,
        audit,
        logger,
      });

      await handle.stop();
      await vi.runAllTimersAsync();

      expect(audit).not.toHaveBeenCalled();
      expect(logger.log).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
