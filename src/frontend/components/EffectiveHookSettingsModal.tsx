import React, { useEffect, useRef, useState } from 'react';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { ApiError, getEffectiveHookSettings } from '../api/index.js';

interface EffectiveHookSettings {
  content: unknown;
  agentType: string;
  settingsPath: string;
}

interface Props {
  sessionId: string;
  onClose: () => void;
}

export function EffectiveHookSettingsModal({ sessionId, onClose }: Props): React.ReactElement {
  const [data, setData] = useState<EffectiveHookSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = 'effective-hook-settings-title';

  useEscapeToClose(onClose);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getEffectiveHookSettings<EffectiveHookSettings>(sessionId)
      .then((body) => {
        if (cancelled) return;
        setData(body);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setError('No hook settings recorded for this session.');
          return;
        }
        if (err instanceof ApiError) {
          setError(`HTTP ${err.status}`);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog effective-hook-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <h3 id={titleId}>Effective hook settings</h3>
          <button
            ref={closeButtonRef}
            className="dialog-close"
            onClick={onClose}
            aria-label="Close"
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </div>

        <div className="settings-desc" style={{ marginBottom: '0.5rem' }}>
          Shows the JSON Kookr passed to <code>--settings</code> when this
          agent was launched. Sourced from adapter memory or the persisted
          settings file after restart.
        </div>

        {error && <div className="settings-error">{error}</div>}

        {data && (
          <>
            <div className="effective-hook-settings-meta">
              <div>
                <span className="settings-label">Agent type</span>
                <code>{data.agentType}</code>
              </div>
              <div>
                <span className="settings-label">Settings file</span>
                <code className="effective-hook-settings-path">{data.settingsPath}</code>
              </div>
            </div>
            <pre className="effective-hook-settings-json">
              {JSON.stringify(data.content, null, 2)}
            </pre>
          </>
        )}

        <div className="dialog-actions">
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
