import React, { useId, useMemo, useRef, useState } from 'react';
import type { BugReportBundle } from '../bug-report-bundle.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';

interface Props {
  bundle: BugReportBundle;
  serialized: string;
  note: string;
  onNoteChange: (note: string) => void;
  onClose: () => void;
}

export function BugReportDialog({ bundle, serialized, note, onNoteChange, onClose }: Props) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousSerializedRef = useRef(serialized);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [editableJson, setEditableJson] = useState(serialized);
  const byteCount = useMemo(() => new TextEncoder().encode(editableJson).byteLength, [editableJson]);

  React.useEffect(() => {
    setEditableJson((current) => {
      const previousSerialized = previousSerializedRef.current;
      previousSerializedRef.current = serialized;
      return current === previousSerialized ? serialized : current;
    });
  }, [serialized]);

  useDialogFocus({ dialogRef, initialFocusRef: closeButtonRef });
  useEscapeToClose(onClose);

  function download() {
    setDownloadError(null);
    try {
      const blob = new Blob([editableJson], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `kookr-bug-report-${bundle.generatedAt.replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed');
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="bug-report-dialog dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dialog-header bug-report-header">
          <div>
            <h2 id={titleId}>Bug Report</h2>
            <p>{bundle.triage.summary}</p>
          </div>
          <button ref={closeButtonRef} type="button" className="dialog-close" onClick={onClose} aria-label="Close bug report">&times;</button>
        </div>

        <label className="bug-report-field">
          <span>Note</span>
          <textarea
            value={note}
            onChange={(event) => onNoteChange(event.target.value)}
            rows={3}
            placeholder="What did you expect to happen?"
          />
        </label>

        <div className="bug-report-summary" role="group" aria-label="Capture summary">
          <span>{bundle.alerts.length} alerts</span>
          <span>{bundle.wireObservations.length} wire observations</span>
          <span>{bundle.fleetSummary.totalAgents} agents summarized</span>
          <span>{byteCount} bytes</span>
        </div>

        {downloadError && <div className="bug-report-error" role="alert">{downloadError}</div>}

        <label className="bug-report-preview-label" htmlFor="bug-report-preview">Preview and redact JSON</label>
        <textarea
          id="bug-report-preview"
          className="bug-report-preview"
          value={editableJson}
          onChange={(event) => setEditableJson(event.target.value)}
          spellCheck={false}
        />

        <div className="bug-report-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          <button type="button" className="btn-primary" onClick={download}>Download JSON</button>
        </div>
      </div>
    </div>
  );
}
