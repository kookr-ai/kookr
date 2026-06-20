/**
 * Contract for the file-viewer endpoints (`GET /api/files/meta`,
 * `GET /api/files/raw`). Lets the dashboard render a file that lives wherever
 * the kookr server (or one of its worktrees) can read it — so it works for
 * remote viewers and SSH-hosted tasks, unlike opening the file in a local app.
 *
 * `/meta` returns this discriminated union; the client picks a renderer from
 * `kind`. `/raw` streams the bytes (used by <img>, the sandboxed HTML iframe,
 * and the download fallback). `serverStartedAt` is echoed like the edit-events
 * contract so the client can detect a restart between open and fetch.
 */

/** Largest text payload we inline into `/meta`. Bigger text -> `too_large`. */
export const FILE_VIEW_MAX_INLINE_BYTES = 512 * 1024;
/** Hard cap on what `/raw` will stream (images, iframe, download). */
export const FILE_VIEW_MAX_RAW_BYTES = 25 * 1024 * 1024;

export type FileViewKind = 'text' | 'html' | 'image' | 'binary' | 'too_large';

export type FileViewMeta =
  | {
      kind: 'text';
      filePath: string;
      /** Hint for the client renderer: 'markdown' -> renderMarkdown, else <pre>. */
      language: string;
      content: string;
      truncated: boolean;
      serverStartedAt: string;
    }
  | { kind: 'html'; filePath: string; size: number; serverStartedAt: string }
  | { kind: 'image'; filePath: string; mime: string; size: number; serverStartedAt: string }
  | { kind: 'binary'; filePath: string; size: number; serverStartedAt: string }
  | { kind: 'too_large'; filePath: string; size: number; serverStartedAt: string };

export type FileViewMiss =
  | { error: 'invalid_param'; field: string }
  | { error: 'forbidden'; reason: 'outside_roots' }
  | { error: 'not_found' }
  | { error: 'too_large'; size: number };
