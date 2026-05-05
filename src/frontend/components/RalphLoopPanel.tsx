import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { RalphIterationLogReadModel, RalphIterationRecord, RalphLoopReadModel } from '../../shared/protocol.js';
import { formatCost } from '../presentation.js';

type RalphLoopPanelData = RalphIterationLogReadModel & { ralphLoop?: RalphLoopReadModel };

type RalphLoopPanelState =
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: RalphLoopPanelData; error: null }
  | { status: 'error'; data: null; error: string };

interface Props {
  taskId: string;
}

export function RalphLoopPanel({ taskId }: Props) {
  const [state, setState] = useState<RalphLoopPanelState>({ status: 'loading', data: null, error: null });
  const [promptDraft, setPromptDraft] = useState('');
  const [promptDirty, setPromptDirty] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptMessage, setPromptMessage] = useState<string | null>(null);
  const promptDirtyRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let firstLoad = true;
    setState({ status: 'loading', data: null, error: null });
    setPromptDraft('');
    setPromptDirty(false);
    setPromptSaving(false);
    setPromptMessage(null);
    promptDirtyRef.current = false;

    const load = () => {
      fetch(`/api/tasks/${encodeURIComponent(taskId)}/ralph-loop/iterations`, { signal: controller.signal })
        .then(async (res) => {
          if (!res.ok) {
            const body = await res.json().catch(() => ({})) as { error?: string };
            throw new Error(body.error ?? `Request failed with ${res.status}`);
          }
          return res.json() as Promise<RalphLoopPanelData>;
        })
        .then((data) => {
          firstLoad = false;
          setState({ status: 'ready', data, error: null });
          if (!promptDirtyRef.current) {
            setPromptDraft(data.ralphLoop?.prompt ?? '');
          }
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          if (firstLoad) {
            setState({ status: 'error', data: null, error: err instanceof Error ? err.message : String(err) });
          }
        });
    };

    load();
    const interval = window.setInterval(load, 5_000);
    return () => {
      window.clearInterval(interval);
      controller.abort();
    };
  }, [taskId]);

  if (state.status === 'loading') {
    return <div className="ralph-panel ralph-panel-state">Loading Ralph iterations...</div>;
  }
  if (state.status === 'error') {
    return <div className="ralph-panel ralph-panel-state error">{state.error}</div>;
  }

  const { iterations, summary, ralphLoop } = state.data;
  const exportBase = `/api/tasks/${encodeURIComponent(taskId)}/ralph-loop/iterations/export`;
  const promptCanSave = promptDirty && !promptSaving && promptDraft.trim().length > 0;
  const promptId = `ralph-prompt-${taskId}`;
  const promptHintId = `ralph-prompt-hint-${taskId}`;
  const promptMessageIsError = Boolean(promptMessage && promptMessage !== 'Saved for future iterations.');

  const updatePrompt = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!promptCanSave) return;
    setPromptSaving(true);
    setPromptMessage(null);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/ralph-loop/prompt`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: promptDraft }),
      });
      const body = await res.json().catch(() => ({})) as { error?: string; ralphLoop?: RalphLoopReadModel };
      if (!res.ok) throw new Error(body.error ?? `Request failed with ${res.status}`);
      if (body.ralphLoop) {
        setState((current) => current.status === 'ready'
          ? { ...current, data: { ...current.data, ralphLoop: body.ralphLoop } }
          : current);
        setPromptDraft(body.ralphLoop.prompt);
      }
      promptDirtyRef.current = false;
      setPromptDirty(false);
      setPromptMessage('Saved for future iterations.');
    } catch (err) {
      setPromptMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setPromptSaving(false);
    }
  };

  const onPromptChange = (value: string) => {
    setPromptDraft(value);
    setPromptMessage(null);
    const dirty = value !== (ralphLoop?.prompt ?? '');
    promptDirtyRef.current = dirty;
    setPromptDirty(dirty);
  };

  return (
    <div className="ralph-panel">
      <div className="ralph-panel-toolbar">
        <a className="ralph-export-link" href={`${exportBase}?format=csv`} download>
          Export CSV
        </a>
        <a className="ralph-export-link" href={`${exportBase}?format=json`} download>
          Export JSON
        </a>
      </div>

      {ralphLoop && (
        <form className="ralph-prompt-form" onSubmit={updatePrompt}>
          <div className="ralph-prompt-header">
            <label htmlFor={promptId}>Next prompt</label>
            <span id={promptHintId}>
              {ralphLoop.status === 'running'
                ? 'Pause first; next run starts fresh.'
                : 'Next run starts fresh.'}
            </span>
          </div>
          <textarea
            id={promptId}
            className="ralph-prompt-edit"
            value={promptDraft}
            onChange={(event) => onPromptChange(event.currentTarget.value)}
            aria-describedby={promptHintId}
            rows={5}
          />
          <div className="ralph-prompt-actions">
            {promptMessage && (
              <span
                className="ralph-prompt-message"
                role={promptMessageIsError ? 'alert' : 'status'}
              >
                {promptMessage}
              </span>
            )}
            <button type="submit" className="ralph-prompt-save" disabled={!promptCanSave}>
              {promptSaving ? 'Saving...' : 'Save prompt'}
            </button>
          </div>
        </form>
      )}

      <div className="ralph-summary-grid">
        <SummaryItem label="Iterations" value={`${summary.totalIterations}`} />
        <SummaryItem label="Latest exit" value={summary.latestExitReason ?? 'Unavailable'} />
        <SummaryItem label="Cost" value={summary.cumulativeCostUsd === null ? 'Unavailable' : formatCost(summary.cumulativeCostUsd)} />
        <SummaryItem label="Runtime" value={formatMs(summary.runtimeMs)} />
        <SummaryItem label="Avg iter" value={formatMs(summary.averageIterationDurationMs)} />
        <SummaryItem label="ETA" value={formatMs(summary.etaMs)} />
      </div>

      {summary.malformedLines > 0 && (
        <div className="ralph-warning">
          {summary.malformedLines} malformed log line{summary.malformedLines === 1 ? '' : 's'} skipped
        </div>
      )}

      {iterations.length === 0 ? (
        <div className="ralph-empty">No Ralph iterations recorded yet.</div>
      ) : (
        <div className="ralph-table-wrap">
          <table className="ralph-table">
            <thead>
              <tr>
                <th>Iter</th>
                <th>Exit</th>
                <th>Duration</th>
                <th>Diff</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {iterations.map((record) => (
                <RalphIterationRow key={`${record.iterationNumber}-${record.endedAt}`} record={record} />
              ))}
            </tbody>
          </table>
          {summary.capped && (
            <div className="ralph-cap-note">
              Showing latest {summary.returnedIterations} of {summary.totalIterations}.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="ralph-summary-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function RalphIterationRow({ record }: { record: RalphIterationRecord }) {
  const diff = useMemo(() => formatDiff(record), [record]);
  return (
    <tr>
      <td>{record.iterationNumber}</td>
      <td><span className={`ralph-exit ralph-exit-${exitTone(record.exitReason)}`}>{record.exitReason}</span></td>
      <td>{formatMs(record.endedAt - record.startedAt)}</td>
      <td>{diff}</td>
      <td>{record.cumulativeCostUsd === null ? 'Unavailable' : formatCost(record.cumulativeCostUsd)}</td>
    </tr>
  );
}

function formatDiff(record: RalphIterationRecord): string {
  if (record.diffStats === null) return 'Unavailable';
  const { filesChanged, insertions, deletions } = record.diffStats;
  return `${filesChanged} files, +${insertions} / -${deletions}`;
}

function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return 'Unavailable';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = Math.round(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours === 0) return `${minutes}m ${seconds}s`;
  return `${hours}h ${remMinutes}m`;
}

function exitTone(exitReason: string): 'ok' | 'warn' | 'stop' | 'neutral' {
  switch (exitReason) {
    case 'predicate_satisfied':
    case 'iteration_cap':
      return 'ok';
    case 'predicate_timeout':
    case 'predicate_error':
    case 'kookr_crash':
    case 'session_dead':
      return 'warn';
    case 'cancelled':
    case 'paused':
      return 'stop';
    default:
      return 'neutral';
  }
}
