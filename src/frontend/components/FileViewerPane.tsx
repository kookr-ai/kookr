import React, { useEffect, useRef, useState } from 'react';
import { renderMarkdown } from '../markdown.js';
import type { FileViewMeta, FileViewMiss } from '../../shared/contracts/file-view.js';

interface Props {
  /** Absolute (or serverCwd-relative) path to view. */
  filePath: string;
  /** Server start time captured when the pane opened — detects a restart. */
  openedAt: string | null;
  /** User hit the close button (Escape is owned by DetailPanel, like DiffPane). */
  onClose: () => void;
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'ok'; meta: FileViewMeta }
  | { kind: 'err'; message: string };

function rawUrl(filePath: string, attachment = false): string {
  const base = `/api/files/raw?path=${encodeURIComponent(filePath)}`;
  return attachment ? `${base}&disposition=attachment` : base;
}

export function FileViewerPane({ filePath, openedAt, onClose }: Props) {
  const [state, setState] = useState<FetchState>({ kind: 'loading' });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ac = new AbortController();
    setState({ kind: 'loading' });
    fetch(`/api/files/meta?path=${encodeURIComponent(filePath)}`, { signal: ac.signal })
      .then(async (res) => {
        // Guard every setState with ac.signal.aborted so a stale response from a
        // previous filePath can't overwrite the current one (see DiffPane).
        if (ac.signal.aborted) return;
        const body = await res.json().catch(() => null) as FileViewMeta | FileViewMiss | null;
        if (ac.signal.aborted) return;
        if (!body) {
          setState({ kind: 'err', message: 'Could not load file — server returned an unparseable response.' });
          return;
        }
        if (res.ok && 'kind' in body) {
          setState({ kind: 'ok', meta: body });
          return;
        }
        const message =
          'error' in body && body.error === 'forbidden'
            ? 'This file is outside the workspace and cannot be shown.'
            : 'error' in body && body.error === 'not_found'
              ? 'File not found.'
              : 'Could not load file — check server logs.';
        setState({ kind: 'err', message });
      })
      .catch((err) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        if (ac.signal.aborted) return;
        setState({ kind: 'err', message: 'Could not load file — check server logs.' });
      });
    return () => ac.abort();
  }, [filePath, openedAt]);

  useEffect(() => {
    rootRef.current?.focus();
  }, [filePath]);

  return (
    <div
      ref={rootRef}
      className="file-pane"
      tabIndex={-1}
      role="region"
      aria-label={`File ${filePath}`}
    >
      <div className="file-pane-header">
        <span className="file-pane-path" title={filePath}>{filePath}</span>
        <button
          type="button"
          className="file-pane-close"
          onClick={onClose}
          aria-label="Close file"
          title="Close (Esc)"
        >
          {'×'}
        </button>
      </div>

      <div className="file-pane-body">
        {state.kind === 'loading' && <div className="file-pane-loading">Loading…</div>}
        {state.kind === 'err' && <div className="file-pane-error">{state.message}</div>}
        {state.kind === 'ok' && <FileBody meta={state.meta} filePath={filePath} />}
      </div>
    </div>
  );
}

function FileBody({ meta, filePath }: { meta: FileViewMeta; filePath: string }) {
  switch (meta.kind) {
    case 'text':
      return meta.language === 'markdown'
        ? (
          <div className="file-pane-md">
            {renderMarkdown(meta.content)}
            {meta.truncated && <div className="file-pane-truncated">…(truncated)</div>}
          </div>
        )
        : (
          <pre className="file-pane-code">
            {meta.content}
            {meta.truncated && '\n…(truncated)'}
          </pre>
        );
    case 'html':
      // Non-negotiable: sandbox with NO allow-same-origin and NO allow-scripts,
      // so the page renders but can neither reach the dashboard nor run code.
      return (
        <iframe
          className="file-pane-frame"
          src={rawUrl(filePath)}
          sandbox=""
          title={`HTML preview of ${filePath}`}
        />
      );
    case 'image':
      return <img className="file-pane-img" src={rawUrl(filePath)} alt={filePath} />;
    case 'too_large':
    case 'binary':
      return (
        <div className="file-pane-download">
          <p>{meta.kind === 'too_large' ? 'File is too large to preview.' : 'Preview not available for this file type.'}</p>
          <a href={rawUrl(filePath, true)} download>Download ({meta.size.toLocaleString()} bytes)</a>
        </div>
      );
  }
}
