import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { probeWhisperReachability } from './index.js';

type FakeServerHandler = (path: string) => {
  status: number;
  body?: string;
  contentType?: string;
};

async function startFakeWhisper(handler: FakeServerHandler): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const { status, body, contentType } = handler(req.url ?? '');
    res.writeHead(status, { 'Content-Type': contentType ?? 'application/json' });
    res.end(body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('probeWhisperReachability', () => {
  let cleanup: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = null;
    }
  });

  it('returns ok with model count when /v1/models responds 200 with OpenAI-shaped body', async () => {
    const fake = await startFakeWhisper((path) => {
      if (path === '/v1/models') {
        return { status: 200, body: JSON.stringify({ object: 'list', data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }) };
      }
      return { status: 404 };
    });
    cleanup = fake.close;

    const result = await probeWhisperReachability(fake.url);

    expect(result).toEqual({ ok: true, modelCount: 3 });
  });

  it('strips one or more trailing slashes from whisperUrl before composing /v1/models', async () => {
    const fake = await startFakeWhisper((path) => {
      // A double-slash would be //v1/models; this handler only matches the clean form.
      if (path === '/v1/models') return { status: 200, body: JSON.stringify({ data: [] }) };
      return { status: 404 };
    });
    cleanup = fake.close;

    const single = await probeWhisperReachability(`${fake.url}/`);
    const triple = await probeWhisperReachability(`${fake.url}///`);

    expect(single).toEqual({ ok: true, modelCount: 0 });
    expect(triple).toEqual({ ok: true, modelCount: 0 });
  });

  it('returns ok with null modelCount on 2xx with non-JSON body', async () => {
    const fake = await startFakeWhisper(() => ({ status: 200, body: 'not json', contentType: 'text/plain' }));
    cleanup = fake.close;

    const result = await probeWhisperReachability(fake.url);

    expect(result).toEqual({ ok: true, modelCount: null });
  });

  it('returns ok with null modelCount when JSON body is missing data array', async () => {
    const fake = await startFakeWhisper(() => ({ status: 200, body: JSON.stringify({ object: 'list' }) }));
    cleanup = fake.close;

    const result = await probeWhisperReachability(fake.url);

    expect(result).toEqual({ ok: true, modelCount: null });
  });

  it('returns failure with HTTP status when probe gets 5xx', async () => {
    const fake = await startFakeWhisper(() => ({ status: 503, body: 'unavailable' }));
    cleanup = fake.close;

    const result = await probeWhisperReachability(fake.url);

    expect(result).toEqual({ ok: false, reason: 'HTTP 503' });
  });

  it('returns ECONNREFUSED-shaped failure when nothing is listening', async () => {
    // Bind+release a port to grab one we know is now unused — no flake risk
    // from picking a randomly-busy port.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const result = await probeWhisperReachability(`http://127.0.0.1:${port}`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Pinned to ECONNREFUSED specifically: the target is 127.0.0.1 (no DNS,
      // so ENOTFOUND is impossible) and the operation is a connect (so the
      // bind-time EADDRNOTAVAIL is impossible). Tightening this catches a
      // regression where `cause.code` extraction breaks and we fall through
      // to err.message — that path also contains "ECONNREFUSED" as a
      // substring, so a substring match would mask the bug.
      expect(result.reason).toBe('ECONNREFUSED');
    }
  });

  it('still reports reachable when 2xx headers arrive but body stream aborts', async () => {
    // Half-broken whisper substitute: writes 200 + Content-Type then hangs.
    // The probe's timer fires, AbortController triggers, res.json() throws
    // an AbortError — but the verdict must remain "reachable" because the
    // server already proved it can respond. Otherwise operators would see
    // FAILED for a server that's actually up.
    const server = createServer((_, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"data": [');
      // Never call res.end() — body hangs intentionally.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    cleanup = () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });

    const result = await probeWhisperReachability(`http://127.0.0.1:${port}`, 50);

    expect(result).toEqual({ ok: true, modelCount: null });
  });

  it('returns timeout failure when the server never responds', async () => {
    const server = createServer(() => {
      // Hang the request — never call res.end().
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    cleanup = () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });

    const result = await probeWhisperReachability(`http://127.0.0.1:${port}`, 50);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('timeout after 50ms');
    }
  });
});
