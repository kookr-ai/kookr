import React, { useEffect, useRef, useState } from 'react';

interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

type EditEventResponse =
  | { kind: 'edit'; filePath: string; structuredPatch: PatchHunk[]; oldString: string; newString: string; serverStartedAt: string }
  | { kind: 'write'; filePath: string; structuredPatch: PatchHunk[]; originalFile: string; serverStartedAt: string }
  | { kind: 'unsupported'; serverStartedAt: string };

type EditEventMiss =
  | { error: 'not_found'; reason: 'agent_unknown' | 'event_not_found'; serverStartedAt: string }
  | { error: 'invalid_param'; field: string };

interface Props {
  agentId: string;
  toolUseId: string;
  filePath: string;
  /** Server start time captured at the moment the user opened this diff.
   *  If the response's serverStartedAt is later, a restart happened. */
  openedAt: string | null;
  /** User hit Escape or the Terminal toggle. */
  onClose: () => void;
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'ok'; body: EditEventResponse }
  | { kind: 'err'; message: string; restarted: boolean };

export function DiffPane({ agentId, toolUseId, filePath, openedAt, onClose }: Props) {
  const [state, setState] = useState<FetchState>({ kind: 'loading' });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ac = new AbortController();
    setState({ kind: 'loading' });
    fetch(
      `/api/agents/${encodeURIComponent(agentId)}/edit-events/${encodeURIComponent(toolUseId)}`,
      { signal: ac.signal },
    )
      .then(async (res) => {
        // AbortController.abort() cancels the network request, but if the
        // response has already started arriving the .then() still runs. Guard
        // every setState with ac.signal.aborted so a stale response from the
        // previous toolUseId can't overwrite the current one.
        if (ac.signal.aborted) return;
        const body = await res.json().catch(() => null) as EditEventResponse | EditEventMiss | null;
        if (ac.signal.aborted) return;
        if (!body) {
          setState({ kind: 'err', message: 'Could not load diff — server returned unparseable response.', restarted: false });
          return;
        }
        if (res.ok && 'kind' in body) {
          setState({ kind: 'ok', body });
          return;
        }
        if ('error' in body && body.error === 'not_found') {
          const restarted = openedAt != null && body.serverStartedAt > openedAt;
          const reasonMsg =
            restarted
              ? 'Server restarted while this diff was open — the edit may not have been recaptured.'
              : body.reason === 'agent_unknown'
                ? 'Agent session is no longer tracked.'
                : 'Edit event not found in the current session window.';
          setState({ kind: 'err', message: reasonMsg, restarted });
          return;
        }
        setState({ kind: 'err', message: 'Could not load diff — check server logs.', restarted: false });
      })
      .catch((err) => {
        if (err instanceof Error && err.name === 'AbortError') return;
        if (ac.signal.aborted) return;
        setState({ kind: 'err', message: 'Could not load diff — check server logs.', restarted: false });
      });
    return () => ac.abort();
  }, [agentId, toolUseId, openedAt]);

  // Focus the pane when it first mounts so screen readers announce the region
  // label and the close button is reachable by a single Tab. We focus the root
  // div (tabIndex=-1).
  //
  // Escape handling is owned by DetailPanel's capture-phase window listener
  // (DetailPanel.tsx) — a local onKeyDown here would be redundant because the
  // capture listener fires first and calls stopPropagation.
  useEffect(() => {
    rootRef.current?.focus();
  }, [toolUseId]);

  return (
    <div
      ref={rootRef}
      className="diff-pane"
      tabIndex={-1}
      role="region"
      aria-label={`Diff for ${filePath}`}
    >
      <div className="diff-pane-header">
        <span className="diff-pane-path" title={filePath}>{filePath}</span>
        <button
          type="button"
          className="diff-pane-close"
          onClick={onClose}
          aria-label="Close diff"
          title="Close (Esc)"
        >
          {'×'}
        </button>
      </div>

      <div className="diff-pane-body">
        {state.kind === 'loading' && <div className="diff-pane-loading">Loading diff…</div>}

        {state.kind === 'err' && (
          <div className={`diff-pane-error${state.restarted ? ' is-restarted' : ''}`}>
            {state.message}
          </div>
        )}

        {state.kind === 'ok' && state.body.kind === 'unsupported' && (
          <div className="diff-pane-unsupported">
            Diff preview is not supported for this tool.
          </div>
        )}

        {state.kind === 'ok' && state.body.kind !== 'unsupported' && (
          <DiffContent body={state.body} />
        )}
      </div>
    </div>
  );
}

function DiffContent({ body }: { body: Extract<EditEventResponse, { kind: 'edit' | 'write' }> }) {
  const isNewFile = body.kind === 'write' && body.originalFile === '';
  const hunks = Array.isArray(body.structuredPatch) ? body.structuredPatch : [];

  if (hunks.length === 0) {
    return <div className="diff-pane-empty">No changes recorded for this edit.</div>;
  }

  return (
    <>
      {isNewFile && <div className="diff-pane-badge diff-pane-badge-new">New file</div>}
      {hunks.map((hunk, i) => (
        <div className="diff-hunk" key={i}>
          <div className="diff-hunk-header">
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
          </div>
          {hunk.lines.map((line, j) => {
            const marker = line[0];
            const cls = marker === '+' ? 'add' : marker === '-' ? 'del' : 'ctx';
            return (
              <div className={`diff-line diff-${cls}`} key={j}>
                {line}
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}
