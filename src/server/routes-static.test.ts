import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRoutes } from './routes.js';
import type { RouteDeps } from './routes/shared.js';

function makeDeps(frontendDir: string, serverCwd: string): RouteDeps {
  return { frontendDir, serverCwd, serverPort: 4800 } as unknown as RouteDeps;
}

describe('createRoutes serveStatic gating', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let tempDir: string;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    tempDir = mkdtempSync(join(tmpdir(), 'kookr-routes-static-'));
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Regression: in `pnpm dev` mode the frontend is served by Vite and
  // dist/frontend doesn't exist. serveStatic must not be mounted, otherwise
  // @hono/node-server logs `serveStatic: root path '...' is not found` once
  // at registration time.
  it('skips serveStatic and emits no warning when frontendDir is absent', () => {
    const absentDir = join(tempDir, 'never-created');
    createRoutes(makeDeps(absentDir, tempDir));
    const warned = consoleErrorSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && a.includes('serveStatic') && a.includes('is not found')),
    );
    expect(warned).toBe(false);
  });

  it('mounts serveStatic without warning when frontendDir exists (production layout)', () => {
    const frontendDir = join(tempDir, 'frontend');
    mkdirSync(frontendDir, { recursive: true });
    const app = createRoutes(makeDeps(frontendDir, tempDir));
    const warned = consoleErrorSpy.mock.calls.some((args) =>
      args.some((a) => typeof a === 'string' && a.includes('serveStatic') && a.includes('is not found')),
    );
    expect(warned).toBe(false);
    expect(app).toBeDefined();
  });
});

describe('createRoutes JSON request body limit', () => {
  afterEach(() => {
    delete process.env.KOOKR_REQUEST_BODY_LIMIT_BYTES;
  });

  it('rejects oversized API JSON request bodies before route handlers', async () => {
    const app = createRoutes({
      ...makeDeps('/nonexistent-frontend', '/repo'),
      requestBodyLimitBytes: 32,
    });

    const res = await app.request('http://localhost/api/does-not-exist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 'x'.repeat(64) }),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: 'request-body-too-large',
      message: 'JSON request body exceeds the 32 byte limit',
      limitBytes: 32,
    });
  });

  it('keeps API auth ahead of the body-reading guard on non-loopback binds', async () => {
    const app = createRoutes({
      ...makeDeps('/nonexistent-frontend', '/repo'),
      apiAuth: { required: true, token: 'secret' },
      requestBodyLimitBytes: 32,
    });

    const res = await app.request('http://lan.example/api/does-not-exist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 'x'.repeat(64) }),
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('lets normal-sized API JSON request bodies continue to routing', async () => {
    const app = createRoutes({
      ...makeDeps('/nonexistent-frontend', '/repo'),
      requestBodyLimitBytes: 128,
    });

    const res = await app.request('http://localhost/api/does-not-exist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not Found' });
  });

  it('uses KOOKR_REQUEST_BODY_LIMIT_BYTES when route deps do not override it', async () => {
    process.env.KOOKR_REQUEST_BODY_LIMIT_BYTES = '40';
    const app = createRoutes(makeDeps('/nonexistent-frontend', '/repo'));

    const res = await app.request('http://localhost/api/does-not-exist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: 'x'.repeat(64) }),
    });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({
      error: 'request-body-too-large',
      message: 'JSON request body exceeds the 40 byte limit',
      limitBytes: 40,
    });
  });
});
