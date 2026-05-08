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

  // Issue #188: shutdown raced startup warmup — STT containers were being
  // stopped while the in-flight whisper request was still on the wire, so the
  // resulting `TypeError: fetch failed` was logged as a user-facing warmup
  // regression. The lifecycleSignal cascade demoted that to an info-level log.
  describe('shutdown lifecycle integration', () => {
    it('logs cancellation distinctly when shutdown aborts an in-flight warmup', async () => {
      // A stalling whisper server reproduces the bug: by the time the SIGTERM
      // path aborts the lifecycle signal, the fetch is mid-flight. Without
      // the fix, the fetch error path would emit the user-facing FAILED log.
      const sockets: import('node:net').Socket[] = [];
      const stalling = createServer((req: IncomingMessage, _res: ServerResponse) => {
        sockets.push(req.socket);
        // Never respond.
      });
      await new Promise<void>((resolve) => stalling.listen(0, '127.0.0.1', () => resolve()));
      const addr = stalling.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      const audit = vi.fn();
      const logger = { log: vi.fn(), warn: vi.fn() };
      const lifecycle = new AbortController();
      try {
        const handle = startVoiceWarmup({
          whisperUrl: `http://127.0.0.1:${port}`,
          timeoutMs: 5_000,
          audit,
          logger,
          lifecycleSignal: lifecycle.signal,
        });

        // Wait for the request to be in-flight on the stalling server before
        // aborting. The 0ms setTimeout inside startVoiceWarmup defers the
        // fetch one tick, and Node's HTTP client needs time to send headers.
        await waitFor(() => sockets.length > 0, 1000);

        // Mimic SIGTERM ordering from start.ts: lifecycleAc.abort() runs
        // BEFORE sttManager.stop() — i.e. while the fetch is still pending.
        lifecycle.abort();
        await handle.done;

        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.log).toHaveBeenCalledWith(
          expect.stringMatching(/voice warmup cancelled by shutdown/),
        );
        expect(audit).toHaveBeenCalledWith(expect.objectContaining({
          kind: 'voice_warmup',
          cancelled: 'shutdown',
          cancelledMs: expect.any(Number),
        }));
        // The user-facing "first user message will pay the cold-start cost"
        // wording must NOT appear on a clean shutdown — that's the regression
        // signal from issue #188.
        for (const call of logger.log.mock.calls) {
          expect(String(call[0])).not.toMatch(/first user message will pay the cold-start cost/);
        }
      } finally {
        for (const s of sockets) { try { s.destroy(); } catch { /* noop */ } }
        await new Promise<void>((resolve) => stalling.close(() => resolve()));
      }
    });

    it('does not start the request when lifecycleSignal is already aborted', async () => {
      vi.useFakeTimers();
      const audit = vi.fn();
      const logger = { log: vi.fn(), warn: vi.fn() };
      const lifecycle = new AbortController();
      lifecycle.abort();
      try {
        const handle = startVoiceWarmup({
          whisperUrl: 'http://127.0.0.1:1',
          timeoutMs: 5_000,
          audit,
          logger,
          lifecycleSignal: lifecycle.signal,
        });

        await vi.runAllTimersAsync();
        await handle.done;

        // Pre-aborted shutdown means the warmup never ran — no audit, no log.
        expect(audit).not.toHaveBeenCalled();
        expect(logger.log).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not affect the success path when lifecycleSignal is provided but not aborted', async () => {
      const fake = await startFakeWhisper();
      const audit = vi.fn();
      const logger = { log: vi.fn(), warn: vi.fn() };
      const lifecycle = new AbortController();
      try {
        startVoiceWarmup({
          whisperUrl: fake.baseUrl,
          timeoutMs: 1000,
          audit,
          logger,
          lifecycleSignal: lifecycle.signal,
        });
        await waitFor(() => audit.mock.calls.some(([event]) => typeof event.okMs === 'number'));
        expect(logger.log).toHaveBeenCalledWith(expect.stringMatching(/\[telegram\] voice warmup: ok/));
        expect(logger.warn).not.toHaveBeenCalled();
      } finally {
        await fake.stop();
      }
    });

    it('aborting lifecycleSignal before the timer fires skips the request entirely', async () => {
      vi.useFakeTimers();
      const audit = vi.fn();
      const logger = { log: vi.fn(), warn: vi.fn() };
      const lifecycle = new AbortController();
      try {
        const handle = startVoiceWarmup({
          whisperUrl: 'http://127.0.0.1:1',
          timeoutMs: 5_000,
          audit,
          logger,
          lifecycleSignal: lifecycle.signal,
        });

        // Fire shutdown before the 0ms setTimeout drains.
        lifecycle.abort();
        await vi.runAllTimersAsync();
        await handle.done;

        expect(audit).not.toHaveBeenCalled();
        expect(logger.log).not.toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
