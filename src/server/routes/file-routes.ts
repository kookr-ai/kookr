import type { Hono } from 'hono';
import { realpath, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileRouteDeps } from './shared.js';
import {
  FILE_VIEW_MAX_INLINE_BYTES,
  FILE_VIEW_MAX_RAW_BYTES,
  type FileViewMeta,
  type FileViewMiss,
} from '../../shared/contracts/file-view.js';

/** Extension -> language hint for inline text rendering. '' picks <pre>. */
const TEXT_LANGS: Record<string, string> = {
  '.md': 'markdown', '.markdown': 'markdown',
  '.txt': '', '.log': '', '.csv': '',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.ini': '',
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.css': 'css', '.xml': 'xml', '.sh': 'bash', '.py': 'python', '.rs': 'rust', '.go': 'go',
};

const IMAGE_MIMES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
};

function rawMime(ext: string): string {
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8';
  if (ext in IMAGE_MIMES) return IMAGE_MIMES[ext];
  if (ext in TEXT_LANGS) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

export function registerFileRoutes(app: Hono, deps: FileRouteDeps): void {
  const { serverCwd, serverStartedAt, worktreeRegistry } = deps;

  // Allow-list: the server cwd plus every active worktree root. realpath'd so a
  // symlinked root still matches the realpath'd target below.
  async function allowedRoots(): Promise<string[]> {
    const raw = [
      serverCwd,
      ...(worktreeRegistry?.all().filter((entry) => !entry.isBare).map((entry) => entry.path) ?? []),
    ];
    const out: string[] = [];
    for (const r of raw) {
      try {
        out.push(await realpath(path.resolve(r)));
      } catch {
        /* a configured root that no longer exists is simply skipped */
      }
    }
    return out;
  }

  // The entire security boundary. Resolves `..` and symlinks, then checks the
  // real path is inside an allowed root. Distinguishes a missing file (404)
  // from one outside the workspace (403) so the client can message correctly.
  type SafePath = { ok: true; abs: string } | { ok: false; status: 403 | 404 };
  async function resolveSafe(raw: string | undefined): Promise<SafePath> {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096 || raw.includes('\0')) {
      return { ok: false, status: 403 };
    }
    let real: string;
    try {
      real = await realpath(path.resolve(serverCwd, raw)); // .. + symlinks; relative -> serverCwd
    } catch {
      return { ok: false, status: 404 }; // ENOENT / unreadable ancestor
    }
    const roots = await allowedRoots();
    const inside = roots.some((root) => real === root || real.startsWith(root + path.sep));
    return inside ? { ok: true, abs: real } : { ok: false, status: 403 };
  }

  function missFor(status: 403 | 404): FileViewMiss {
    return status === 404 ? { error: 'not_found' } : { error: 'forbidden', reason: 'outside_roots' };
  }

  app.get('/api/files/meta', async (c) => {
    const raw = c.req.query('path');
    if (!raw) return c.json<FileViewMiss>({ error: 'invalid_param', field: 'path' }, 400);

    const r = await resolveSafe(raw);
    if (!r.ok) {
      if (r.status === 403) console.warn(`[files] denied meta path=${JSON.stringify(raw)}`);
      return c.json<FileViewMiss>(missFor(r.status), r.status);
    }
    const abs = r.abs;

    const st = await stat(abs).catch(() => null);
    if (!st || !st.isFile()) return c.json<FileViewMiss>({ error: 'not_found' }, 404);

    const ext = path.extname(abs).toLowerCase();
    const filePath = abs;

    if (ext in TEXT_LANGS) {
      if (st.size > FILE_VIEW_MAX_INLINE_BYTES) {
        return c.json<FileViewMeta>({ kind: 'too_large', filePath, size: st.size, serverStartedAt });
      }
      const content = await readFile(abs, 'utf8').catch(() => null);
      if (content === null) return c.json<FileViewMiss>({ error: 'not_found' }, 404);
      return c.json<FileViewMeta>({
        kind: 'text', filePath, language: TEXT_LANGS[ext], content, truncated: false, serverStartedAt,
      });
    }
    if (ext === '.html' || ext === '.htm') {
      if (st.size > FILE_VIEW_MAX_RAW_BYTES) {
        return c.json<FileViewMeta>({ kind: 'too_large', filePath, size: st.size, serverStartedAt });
      }
      return c.json<FileViewMeta>({ kind: 'html', filePath, size: st.size, serverStartedAt });
    }
    if (ext in IMAGE_MIMES) {
      if (st.size > FILE_VIEW_MAX_RAW_BYTES) {
        return c.json<FileViewMeta>({ kind: 'too_large', filePath, size: st.size, serverStartedAt });
      }
      return c.json<FileViewMeta>({ kind: 'image', filePath, mime: IMAGE_MIMES[ext], size: st.size, serverStartedAt });
    }
    return c.json<FileViewMeta>({ kind: 'binary', filePath, size: st.size, serverStartedAt });
  });

  // Streams bytes for <img>, the sandboxed HTML <iframe>, and the download
  // fallback. Capped + read into memory (single user-triggered view).
  app.get('/api/files/raw', async (c) => {
    const r = await resolveSafe(c.req.query('path'));
    if (!r.ok) {
      if (r.status === 403) console.warn(`[files] denied raw path=${JSON.stringify(c.req.query('path'))}`);
      return c.json<FileViewMiss>(missFor(r.status), r.status);
    }
    const abs = r.abs;
    const st = await stat(abs).catch(() => null);
    if (!st || !st.isFile()) return c.json<FileViewMiss>({ error: 'not_found' }, 404);
    if (st.size > FILE_VIEW_MAX_RAW_BYTES) {
      return c.json<FileViewMiss>({ error: 'too_large', size: st.size }, 413);
    }

    const buf = await readFile(abs).catch(() => null);
    if (buf === null) return c.json<FileViewMiss>({ error: 'not_found' }, 404);

    const ext = path.extname(abs).toLowerCase();
    const inline = c.req.query('disposition') !== 'attachment';
    c.header('Content-Type', rawMime(ext));
    c.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(path.basename(abs))}"`);
    // HTML is only ever loaded inside a sandboxed iframe; CSP is belt-and-braces
    // so it can neither run script nor exfiltrate even if embedded elsewhere.
    c.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src 'self' data:");
    c.header('X-Content-Type-Options', 'nosniff');
    return c.body(new Uint8Array(buf));
  });
}
