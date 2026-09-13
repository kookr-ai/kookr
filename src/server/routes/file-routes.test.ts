import { describe, test, expect, beforeEach, afterEach, onTestFinished, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, statSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerFileRoutes } from './file-routes.js';
import type { FileRouteDeps } from './shared.js';
import { FILE_VIEW_MAX_INLINE_BYTES, FILE_VIEW_MAX_RAW_BYTES } from '../../shared/contracts/file-view.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat), open: vi.fn(actual.open) };
});

function mkApp(deps: Partial<FileRouteDeps>): Hono {
  const app = new Hono();
  registerFileRoutes(app, { serverStartedAt: 'T0', ...deps } as FileRouteDeps);
  return app;
}

function metaUrl(p: string): string {
  return `/api/files/meta?path=${encodeURIComponent(p)}`;
}
function rawUrl(p: string): string {
  return `/api/files/raw?path=${encodeURIComponent(p)}`;
}

async function trackReads(file: string, maxBytesPerRead = Infinity) {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const handle = await actual.open(file, 'r');
  onTestFinished(async () => { await handle.close(); });
  vi.mocked(open).mockResolvedValueOnce(handle);
  const realRead = handle.read.bind(handle);
  const read = vi.spyOn(handle, 'read').mockImplementation((options = {}) => realRead({
    ...options, length: Math.min(options.length ?? Infinity, maxBytesPerRead),
  }));
  return { read, close: vi.spyOn(handle, 'close'), readFile: vi.spyOn(handle, 'readFile') };
}

describe('file routes', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'file-routes-root-'));
    outside = mkdtempSync(join(tmpdir(), 'file-routes-outside-'));
    writeFileSync(join(root, 'doc.md'), '# Title\n\nhello');
    writeFileSync(join(root, 'page.html'), '<h1>hi</h1>');
    writeFileSync(join(outside, 'secret.md'), 'TOP SECRET');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(stat).mockClear();
    vi.mocked(open).mockClear();
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  describe.each([
    { route: 'meta', url: metaUrl, limit: FILE_VIEW_MAX_INLINE_BYTES, overflowStatus: 200 },
    { route: 'raw', url: rawUrl, limit: FILE_VIEW_MAX_RAW_BYTES, overflowStatus: 413 },
  ])('$route byte cap', ({ route, url, limit, overflowStatus }) => {
    test.each([1, 64 * 1024])('rejects a file that grows %i bytes past the cap after the size probe', async (overflowBytes) => {
      const file = join(root, 'growing.txt');
      writeFileSync(file, 'small');
      const { read, readFile, close } = await trackReads(file, 64 * 1024);
      vi.mocked(stat).mockImplementationOnce(async () => {
        const beforeGrowth = statSync(file);
        writeFileSync(file, Buffer.alloc(limit + overflowBytes, 'x'));
        return beforeGrowth;
      });

      const res = await mkApp({ serverCwd: root }).request(url(file));
      expect(res.status).toBe(overflowStatus);
      expect(await res.json()).toMatchObject(route === 'meta'
        ? { kind: 'too_large', size: limit + 1 }
        : { error: 'too_large', size: limit + 1 });
      const reads = await Promise.all(read.mock.results.map((result) => result.value));
      expect(reads.reduce((total, result) => total + result.bytesRead, 0)).toBe(limit + 1);
      const buffers = new Set(read.mock.calls.map(([options]) => options?.buffer));
      expect([...buffers].reduce((total, buffer) => total + (buffer?.byteLength ?? 0), 0)).toBeLessThanOrEqual(limit + 1);
      expect(read.mock.calls.every(([options]) =>
        (options?.buffer?.byteLength ?? Infinity) <= 64 * 1024
        && (options?.offset ?? 0) + (options?.length ?? 0) <= (options?.buffer?.byteLength ?? 0)
        && Number(options?.position) + (options?.length ?? 0) <= limit + 1)).toBe(true);
      expect(readFile).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    });

    test.each([0, 9, 64 * 1024, 64 * 1024 + 1, 367_629])('bounds allocations for a %i-byte preview', async (size) => {
      const file = join(root, 'allocation.txt');
      const content = Buffer.alloc(size, 'x');
      writeFileSync(file, content);
      const { close } = await trackReads(file);
      const alloc = vi.spyOn(Buffer, 'alloc');
      const allocUnsafe = vi.spyOn(Buffer, 'allocUnsafe');
      const concat = vi.spyOn(Buffer, 'concat');

      const res = await mkApp({ serverCwd: root }).request(url(file));
      // Include scratch storage and the final concatenation. Allow one unused
      // chunk for the EOF probe, plus bounded request/response bookkeeping.
      const sizes = [...alloc.mock.calls, ...allocUnsafe.mock.calls].map(([bytes]) => bytes);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(size + 64 * 1024);
      expect(sizes.reduce((total, bytes) => total + bytes, 0)).toBeLessThanOrEqual(2 * size + 128 * 1024);
      const copiedBytes = concat.mock.calls.reduce((total, [buffers]) =>
        total + buffers.reduce((length, buffer) => length + buffer.length, 0), 0);
      expect(copiedBytes).toBeLessThanOrEqual(size);
      expect(res.status).toBe(200);
      expect(route === 'meta' ? (await res.json()).content : await res.text()).toBe(content.toString());
      expect(close).toHaveBeenCalledOnce();
    });

    test('accepts exactly the byte limit including multibyte UTF-8', async () => {
      const file = join(root, 'exact.txt');
      const content = 'é'.repeat(limit / 2);
      writeFileSync(file, content);
      const { close } = await trackReads(file);
      const res = await mkApp({ serverCwd: root }).request(url(file));
      expect(res.status).toBe(200);
      if (route === 'meta') {
        expect(await res.json()).toMatchObject({ kind: 'text', content, truncated: false });
      } else {
        const bytes = Buffer.from(await res.arrayBuffer());
        expect(bytes.length).toBe(limit);
        expect(bytes.equals(Buffer.from(content))).toBe(true);
      }
      expect(close).toHaveBeenCalledOnce();
    });

    test.each(['', 'a€🙂z'])('returns all content across short reads: %j', async (content) => {
      const file = join(root, 'short.txt');
      writeFileSync(file, content);
      const { read, close } = await trackReads(file, 2);
      const res = await mkApp({ serverCwd: root }).request(url(file));
      expect(res.status).toBe(200);
      expect(route === 'meta' ? (await res.json()).content : await res.text()).toBe(content);
      expect(read.mock.calls.length).toBeGreaterThan(0);
      expect(close).toHaveBeenCalledOnce();
    });

    test('accepts growth within the cap across chunk and UTF-8 boundaries', async () => {
      const file = join(root, 'growing-within-cap.txt');
      const content = 'a'.repeat(64 * 1024 - 1) + '€🙂z';
      writeFileSync(file, 'small');
      const { close } = await trackReads(file, 8191);
      vi.mocked(stat).mockImplementationOnce(async () => {
        const beforeGrowth = statSync(file);
        writeFileSync(file, content);
        return beforeGrowth;
      });

      const res = await mkApp({ serverCwd: root }).request(url(file));
      expect(res.status).toBe(200);
      expect(route === 'meta' ? (await res.json()).content : await res.text()).toBe(content);
      expect(close).toHaveBeenCalledOnce();
    });

    test('returns only bytes read when the file shrinks after the probe', async () => {
      const file = join(root, 'shrinking.txt');
      writeFileSync(file, 'longer original contents');
      vi.mocked(stat).mockImplementationOnce(async () => {
        const beforeShrink = statSync(file);
        writeFileSync(file, 'short');
        return beforeShrink;
      });
      const { close } = await trackReads(file);
      const res = await mkApp({ serverCwd: root }).request(url(file));
      expect(res.status).toBe(200);
      expect(route === 'meta' ? (await res.json()).content : await res.text()).toBe('short');
      expect(close).toHaveBeenCalledOnce();
    });

    test('closes the handle on a read failure and preserves not_found', async () => {
      const file = join(root, 'doc.md');
      const { read, close } = await trackReads(file);
      read.mockRejectedValueOnce(new Error('read failed'));
      const res = await mkApp({ serverCwd: root }).request(url(file));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
      expect(close).toHaveBeenCalledOnce();
    });

    test('preserves not_found when the file disappears after the probe', async () => {
      const file = join(root, 'doc.md');
      vi.mocked(stat).mockImplementationOnce(async () => {
        const beforeRemoval = statSync(file);
        rmSync(file);
        return beforeRemoval;
      });
      const res = await mkApp({ serverCwd: root }).request(url(file));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    });

    test('rejects a file already over the limit without opening it', async () => {
      const file = join(root, 'large.txt');
      writeFileSync(file, Buffer.alloc(limit + 1, 'x'));
      const res = await mkApp({ serverCwd: root }).request(url(file));
      expect(res.status).toBe(overflowStatus);
      expect(await res.json()).toMatchObject(route === 'meta'
        ? { kind: 'too_large', size: limit + 1 }
        : { error: 'too_large', size: limit + 1 });
      expect(open).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/files/meta', () => {
    test('returns text + content for a markdown file in root', async () => {
      const res = await mkApp({ serverCwd: root }).request(metaUrl(join(root, 'doc.md')));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ kind: 'text', language: 'markdown', content: '# Title\n\nhello', truncated: false });
    });

    test('returns html kind (no content) for an html file', async () => {
      const res = await mkApp({ serverCwd: root }).request(metaUrl(join(root, 'page.html')));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.kind).toBe('html');
      expect(body.size).toBeGreaterThan(0);
      expect(body.content).toBeUndefined();
    });

    test('400 when path param is missing', async () => {
      const res = await mkApp({ serverCwd: root }).request('/api/files/meta');
      expect(res.status).toBe(400);
    });

    test('403 for a path that traverses outside the root', async () => {
      const res = await mkApp({ serverCwd: root }).request(metaUrl(join(root, '..', '..', 'etc', 'passwd')));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('forbidden');
    });

    test('403 for an absolute path in a sibling dir outside roots', async () => {
      const res = await mkApp({ serverCwd: root }).request(metaUrl(join(outside, 'secret.md')));
      expect(res.status).toBe(403);
    });

    test('404 for a missing file inside the root', async () => {
      const res = await mkApp({ serverCwd: root }).request(metaUrl(join(root, 'nope.md')));
      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe('not_found');
    });

    test('403 for a symlink inside root pointing outside (no escape)', async () => {
      symlinkSync(join(outside, 'secret.md'), join(root, 'link.md'));
      const res = await mkApp({ serverCwd: root }).request(metaUrl(join(root, 'link.md')));
      expect(res.status).toBe(403);
    });

    test('allows files inside a registered worktree root', async () => {
      const wt = mkdtempSync(join(tmpdir(), 'file-routes-wt-'));
      writeFileSync(join(wt, 'in-wt.md'), 'worktree file');
      try {
        const res = await mkApp({
          serverCwd: root,
          worktreeRegistry: { all: () => [{ path: wt } as never] },
        }).request(metaUrl(join(wt, 'in-wt.md')));
        expect(res.status).toBe(200);
        expect((await res.json()).content).toBe('worktree file');
      } finally {
        rmSync(wt, { recursive: true, force: true });
      }
    });

    test('does not allow files inside a bare registry root', async () => {
      const bare = mkdtempSync(join(tmpdir(), 'file-routes-bare-'));
      writeFileSync(join(bare, 'config-secret.md'), 'private Git metadata');
      try {
        const res = await mkApp({
          serverCwd: root,
          worktreeRegistry: { all: () => [{ path: bare, isBare: true } as never] },
        }).request(metaUrl(join(bare, 'config-secret.md')));
        expect(res.status).toBe(403);
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    });

    test('too_large for a text file over the inline cap', async () => {
      const big = 'x'.repeat(600 * 1024); // > 512 KiB inline cap
      writeFileSync(join(root, 'big.txt'), big);
      const res = await mkApp({ serverCwd: root }).request(metaUrl(join(root, 'big.txt')));
      expect(res.status).toBe(200);
      expect((await res.json()).kind).toBe('too_large');
    });
  });

  describe('GET /api/files/raw', () => {
    test('streams html with text/html, CSP and nosniff headers', async () => {
      const res = await mkApp({ serverCwd: root }).request(rawUrl(join(root, 'page.html')));
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(await res.text()).toBe('<h1>hi</h1>');
    });

    test('attachment disposition when requested', async () => {
      const res = await mkApp({ serverCwd: root }).request(`${rawUrl(join(root, 'doc.md'))}&disposition=attachment`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-disposition')).toContain('attachment');
    });

    test('403 for traversal on raw', async () => {
      const res = await mkApp({ serverCwd: root }).request(rawUrl(join(outside, 'secret.md')));
      expect(res.status).toBe(403);
    });
  });
});
