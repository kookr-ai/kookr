import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerFileRoutes } from './file-routes.js';
import type { FileRouteDeps } from './shared.js';

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
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
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
