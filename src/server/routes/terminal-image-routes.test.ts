import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRoutes } from '../routes.js';
import { registerTerminalImageRoutes } from './terminal-image-routes.js';
import type { RouteDeps } from './shared.js';
import {
  TERMINAL_IMAGE_MAX_BYTES,
  TERMINAL_IMAGE_UPLOAD_PATH,
  type TerminalImageUploadError,
  type TerminalImageUploadResponse,
} from '../../shared/contracts/terminal-image.js';
import { TERMINAL_IMAGE_DIR_NAME, TERMINAL_IMAGE_RETENTION_MS } from '../../core/terminal-image-store.js';

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (totalBytes = 64) => {
  const bytes = new Uint8Array(totalBytes);
  bytes.set(PNG_HEAD);
  return bytes;
};

describe('POST /api/terminal-images', () => {
  let kookrDir: string;
  let app: Hono;

  const upload = (body: BodyInit | null, headers: Record<string, string> = { 'content-type': 'image/png' }) =>
    app.request(`http://localhost${TERMINAL_IMAGE_UPLOAD_PATH}`, { method: 'POST', headers, body });

  beforeEach(() => {
    kookrDir = mkdtempSync(join(tmpdir(), 'terminal-image-routes-'));
    app = new Hono();
    registerTerminalImageRoutes(app, { kookrDir });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(kookrDir, { recursive: true, force: true });
  });

  it('saves the image under <kookrDir>/terminal-images and returns its absolute path', async () => {
    const bytes = png(2048);
    const res = await upload(bytes);

    expect(res.status).toBe(201);
    const body = await res.json() as TerminalImageUploadResponse;
    expect(body.mime).toBe('image/png');
    expect(body.size).toBe(2048);
    expect(body.path.startsWith(join(kookrDir, TERMINAL_IMAGE_DIR_NAME) + '/')).toBe(true);
    // The file name is safe to paste into a prompt unquoted: no spaces or shell metacharacters.
    expect(body.path.slice(body.path.lastIndexOf('/') + 1)).toMatch(/^kookr-image-\d{8}-\d{6}-[0-9a-f]{8}\.png$/);
    expect(Buffer.compare(readFileSync(body.path), Buffer.from(bytes))).toBe(0);
  });

  it('writes the file owner-only (0600) in an owner-only directory', async () => {
    const body = await (await upload(png())).json() as TerminalImageUploadResponse;
    expect(statSync(body.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(kookrDir, TERMINAL_IMAGE_DIR_NAME)).mode & 0o777).toBe(0o700);
  });

  it('picks the extension from the sniffed bytes, not from the client Content-Type', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
    const res = await upload(jpeg, { 'content-type': 'image/png' });
    const body = await res.json() as TerminalImageUploadResponse;
    expect(res.status).toBe(201);
    expect(body.mime).toBe('image/jpeg');
    expect(body.path.endsWith('.jpg')).toBe(true);
  });

  it('ignores any client-supplied file name (no path traversal into other directories)', async () => {
    const res = await upload(png(), {
      'content-type': 'image/png',
      'content-disposition': 'attachment; filename="../../../../etc/passwd"',
      'x-filename': '../../evil.png',
    });
    const body = await res.json() as TerminalImageUploadResponse;
    expect(res.status).toBe(201);
    expect(body.path.startsWith(join(kookrDir, TERMINAL_IMAGE_DIR_NAME) + '/')).toBe(true);
    expect(body.path).not.toContain('..');
    expect(body.path).not.toContain('evil');
  });

  it('gives every upload its own file, even within the same second', async () => {
    const a = await (await upload(png())).json() as TerminalImageUploadResponse;
    const b = await (await upload(png())).json() as TerminalImageUploadResponse;
    expect(a.path).not.toBe(b.path);
    expect(readdirSync(join(kookrDir, TERMINAL_IMAGE_DIR_NAME))).toHaveLength(2);
  });

  it('rejects an empty body with 400', async () => {
    const res = await upload(new Uint8Array(0));
    expect(res.status).toBe(400);
    expect((await res.json() as TerminalImageUploadError).error).toBe('empty_body');
  });

  it('rejects non-image bytes even when the client claims image/png (415)', async () => {
    const res = await upload('#!/bin/sh\necho owned\n', { 'content-type': 'image/png' });
    expect(res.status).toBe(415);
    expect((await res.json() as TerminalImageUploadError).error).toBe('unsupported_image_type');
    expect(existsSync(join(kookrDir, TERMINAL_IMAGE_DIR_NAME))).toBe(false);
  });

  it('rejects SVG (text that can carry script) with 415', async () => {
    const res = await upload('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>', {
      'content-type': 'image/svg+xml',
    });
    expect(res.status).toBe(415);
  });

  it('rejects a RIFF container that is not WebP, and a truncated PNG signature', async () => {
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect((await upload(wav)).status).toBe(415);
    expect((await upload(new Uint8Array(PNG_HEAD.slice(0, 5)))).status).toBe(415);
  });

  it('accepts a WebP and a GIF', async () => {
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0]);
    expect((await (await upload(webp)).json() as TerminalImageUploadResponse).mime).toBe('image/webp');
    expect((await (await upload(gif)).json() as TerminalImageUploadResponse).mime).toBe('image/gif');
  });

  it('accepts an image of exactly the size limit and rejects one byte more with 413', async () => {
    expect((await upload(png(TERMINAL_IMAGE_MAX_BYTES))).status).toBe(201);
    const res = await upload(png(TERMINAL_IMAGE_MAX_BYTES + 1));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({
      error: 'request-body-too-large',
      limitBytes: TERMINAL_IMAGE_MAX_BYTES,
    });
  });

  it('prunes only expired, Kookr-named images the next time one is saved', async () => {
    const dir = join(kookrDir, TERMINAL_IMAGE_DIR_NAME);
    mkdirSync(dir, { recursive: true });
    const ancient = new Date(Date.now() - TERMINAL_IMAGE_RETENTION_MS - 60_000);
    const recent = new Date(Date.now() - 60_000);
    const files = {
      expired: 'kookr-image-20200101-000000-aaaaaaaa.png',
      fresh: 'kookr-image-20200101-000001-bbbbbbbb.png',
      // Same age as `expired` but not a name this module creates: must survive.
      foreign: 'notes-from-the-user.png',
    };
    for (const name of Object.values(files)) writeFileSync(join(dir, name), png());
    utimesSync(join(dir, files.expired), ancient, ancient);
    utimesSync(join(dir, files.foreign), ancient, ancient);
    utimesSync(join(dir, files.fresh), recent, recent);

    const saved = await (await upload(png())).json() as TerminalImageUploadResponse;

    const remaining = readdirSync(dir);
    expect(remaining).not.toContain(files.expired);
    expect(remaining).toContain(files.fresh);
    expect(remaining).toContain(files.foreign);
    expect(remaining).toContain(saved.path.slice(saved.path.lastIndexOf('/') + 1));
  });

  it('answers 500 storage_failed (not a crash) when the state dir cannot be written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // A regular file where the directory should be makes mkdir fail.
    writeFileSync(join(kookrDir, TERMINAL_IMAGE_DIR_NAME), 'not a directory');
    const res = await upload(png());
    expect(res.status).toBe(500);
    expect((await res.json() as TerminalImageUploadError).error).toBe('storage_failed');
  });
});

describe('POST /api/terminal-images through createRoutes (middleware stack)', () => {
  let kookrDir: string;

  const makeRoutes = (overrides: Partial<RouteDeps> = {}) => createRoutes({
    frontendDir: '/nonexistent-frontend',
    serverCwd: '/repo',
    serverPort: 4800,
    kookrDir,
    ...overrides,
  } as unknown as RouteDeps);

  beforeEach(() => { kookrDir = mkdtempSync(join(tmpdir(), 'terminal-image-stack-')); });
  afterEach(() => { rmSync(kookrDir, { recursive: true, force: true }); });

  it('is exempt from the 1 MB JSON body limit that every other /api/* route obeys', async () => {
    const app = makeRoutes({ requestBodyLimitBytes: 1024 });
    const big = png(512 * 1024);

    const image = await app.request(`http://localhost${TERMINAL_IMAGE_UPLOAD_PATH}`, {
      method: 'POST', headers: { 'content-type': 'image/png' }, body: big,
    });
    expect(image.status).toBe(201);

    // Control: the same oversized body to any other API path is still refused by the JSON limit.
    const other = await app.request('http://localhost/api/does-not-exist', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: big,
    });
    expect(other.status).toBe(413);
  });

  it('denies a viewer (share) credential — a viewer cannot write files onto the host', async () => {
    const app = makeRoutes({
      apiAuth: {
        required: true,
        token: 'owner-secret',
        resolveViewer: (token: string) => token === 'viewer-tok'
          ? { kind: 'valid', grantId: 'g1', scope: { kind: 'all' } }
          : { kind: 'not-found' },
      },
    });
    const post = (headers: Record<string, string>) => app.request(`http://lan.example${TERMINAL_IMAGE_UPLOAD_PATH}`, {
      method: 'POST', headers: { 'content-type': 'image/png', ...headers }, body: png(),
    });

    expect((await post({ authorization: 'Bearer viewer-tok' })).status).toBe(403);
    expect((await post({})).status).toBe(401);
    expect(existsSync(join(kookrDir, TERMINAL_IMAGE_DIR_NAME))).toBe(false);

    const owner = await post({ authorization: 'Bearer owner-secret' });
    expect(owner.status).toBe(201);
  });

  it('rejects a cross-origin browser POST on the credential-free loopback bind (CSRF)', async () => {
    const app = makeRoutes({ apiAuth: { required: false } });
    const res = await app.request(`http://localhost${TERMINAL_IMAGE_UPLOAD_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'image/png', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
      body: png(),
    });
    expect(res.status).toBe(403);
    expect(existsSync(join(kookrDir, TERMINAL_IMAGE_DIR_NAME))).toBe(false);
  });
});
