// --- Minimal owner Share dialog (#808, RFC §"Owner control surface") ---
//
// Create / list / revoke read-only viewer links. Phase 1 mints only
// whole-dashboard (scope=all) links; the scope picker + expiry are Phase 3
// (#811). The raw token is shown exactly once, in the freshly-created link's
// copyable handoff URL.

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import {
  createViewerLink,
  listViewerLinks,
  revokeViewerLink,
  type CreatedViewerLink,
  type ViewerLinksResponse,
} from '../viewer-share-api.js';

interface Props {
  onClose: () => void;
}

function grantStatus(grant: ViewerLinksResponse['grants'][number]): 'revoked' | 'expired' | 'active' {
  if (grant.revokedAt) return 'revoked';
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) return 'expired';
  return 'active';
}

export function ShareViewerDialog({ onClose }: Props) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);

  const [data, setData] = useState<ViewerLinksResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<CreatedViewerLink | null>(null);
  const [copied, setCopied] = useState(false);

  useDialogFocus({ dialogRef, initialFocusRef: labelInputRef });
  useEscapeToClose(onClose);

  const refresh = useCallback(async () => {
    try {
      setData(await listViewerLinks());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load viewer links');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const created = await createViewerLink(label.trim() || 'Viewer link');
      setJustCreated(created);
      setCopied(false);
      setLabel('');
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create viewer link');
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(id: string) {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await revokeViewerLink(id);
      if (justCreated?.grant.id === id) setJustCreated(null);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to revoke viewer link');
    } finally {
      setBusy(false);
    }
  }

  async function copyHandoffUrl() {
    if (!justCreated) return;
    try {
      await navigator.clipboard.writeText(justCreated.handoffUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="share-viewer-dialog dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId}>Share read-only view</h2>
        <p className="share-viewer-dialog__intro">
          Create a link that gives someone a live, read-only view of this dashboard. They cannot
          launch, stop, or type into anything. Revoke a link any time.
        </p>

        <form className="share-viewer-dialog__create" onSubmit={handleCreate}>
          <label htmlFor={`${titleId}-label`}>Label</label>
          <input
            id={`${titleId}-label`}
            ref={labelInputRef}
            type="text"
            value={label}
            placeholder="e.g. Alice (read-only)"
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy}
          />
          <button type="submit" disabled={busy}>
            Create viewer link
          </button>
        </form>

        {justCreated && (
          <div className="share-viewer-dialog__created" role="status">
            <p>
              Copy this link now — the token is shown <strong>only once</strong>:
            </p>
            <div className="share-viewer-dialog__url-row">
              <input type="text" readOnly value={justCreated.handoffUrl} aria-label="Viewer handoff URL" />
              <button type="button" onClick={copyHandoffUrl}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}

        {actionError && <p className="share-viewer-dialog__error">{actionError}</p>}
        {loadError && <p className="share-viewer-dialog__error">{loadError}</p>}

        <h3>Viewer links</h3>
        {!data && !loadError && <p>Loading…</p>}
        {data && data.grants.length === 0 && <p>No viewer links yet.</p>}
        {data && data.grants.length > 0 && (
          <ul className="share-viewer-dialog__list">
            {data.grants.map((grant) => {
              const status = grantStatus(grant);
              const connected = data.roster.some((r) => r.grantId === grant.id);
              return (
                <li key={grant.id} className={`share-viewer-dialog__item is-${status}`}>
                  <span className="share-viewer-dialog__item-label">{grant.label}</span>
                  <span className="share-viewer-dialog__item-status">
                    {status}
                    {connected && status === 'active' ? ' · connected' : ''}
                  </span>
                  {status === 'active' && (
                    <button type="button" onClick={() => handleRevoke(grant.id)} disabled={busy}>
                      Revoke
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="share-viewer-dialog__actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
