import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CreateTaskShareApiResponse,
  ListTaskSharesApiResponse,
  RevokeTaskShareApiResponse,
  TaskShareOwnerState,
  TaskShareSummary,
} from '../../remote/share-contract.js';

const SHARE_CSRF_HEADER = 'x-kookr-csrf';
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const FOCUSABLE_SELECTOR = [
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

type ShareModalStatus = 'idle' | 'loading' | 'ready' | 'disabled' | 'error';

interface Props {
  taskId: string;
  taskLabel: string;
  open: boolean;
  onClose: () => void;
}

interface GeneratedJoinUrl {
  taskId: string;
  invitationId: string;
  url: string;
}

function stateLabel(state: TaskShareOwnerState): string {
  switch (state) {
    case 'waiting':
      return 'Waiting for viewer';
    case 'viewerConnected':
      return 'Viewer connected';
    case 'revoked':
      return 'Revoked';
    case 'expired':
      return 'Expired';
    case 'revokePending':
      return 'Revoke pending';
  }
}

function stateTitle(share: TaskShareSummary): string {
  if (share.state === 'viewerConnected') return `${stateLabel(share.state)} (${share.connectedViewerCount})`;
  return stateLabel(share.state);
}

function isActiveShare(share: TaskShareSummary): boolean {
  return share.state === 'waiting' || share.state === 'viewerConnected' || share.state === 'revokePending';
}

function formatExpiry(expiresAt: string): string {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return 'unknown expiry';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function joinUrlUsesFragment(url: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.search === '' && parsed.hash.startsWith('#inviteToken=');
  } catch {
    return false;
  }
}

export function TaskShareModal({ taskId, taskLabel, open, onClose }: Props) {
  const [status, setStatus] = useState<ShareModalStatus>('idle');
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [shares, setShares] = useState<TaskShareSummary[]>([]);
  const [generatedJoinUrl, setGeneratedJoinUrl] = useState<GeneratedJoinUrl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const currentShares = useMemo(
    () => shares.filter((share) => share.taskId === taskId),
    [shares, taskId],
  );
  const activeShare = currentShares.find(isActiveShare) ?? null;
  const displayedShare = activeShare ?? currentShares[0] ?? null;
  const joinUrl = generatedJoinUrl?.taskId === taskId
    && generatedJoinUrl.invitationId === displayedShare?.invitationId
    ? generatedJoinUrl.url
    : null;
  const fragmentSafe = joinUrlUsesFragment(joinUrl);

  async function loadShares() {
    const res = await fetch('/api/share/task');
    if (res.status === 409) {
      setStatus('disabled');
      setShares([]);
      return;
    }
    if (!res.ok) throw new Error(`share-list-${res.status}`);
    const body = await res.json() as ListTaskSharesApiResponse;
    setShares(body.shares);
    setStatus('ready');
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus('loading');
    setError(null);

    async function boot() {
      try {
        const tokenRes = await fetch('/api/share/csrf-token');
        if (cancelled) return;
        if (tokenRes.status === 409) {
          setStatus('disabled');
          setCsrfToken(null);
          setShares([]);
          return;
        }
        if (!tokenRes.ok) throw new Error(`csrf-${tokenRes.status}`);
        const tokenBody = await tokenRes.json() as { csrfToken?: unknown };
        if (typeof tokenBody.csrfToken !== 'string') throw new Error('csrf-missing');
        setCsrfToken(tokenBody.csrfToken);
        await loadShares();
      } catch {
        if (!cancelled) {
          setStatus('error');
          setError('Share status is unavailable.');
        }
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, [open, taskId]);

  useEffect(() => {
    if (!open || status !== 'ready') return;
    const timer = window.setInterval(() => {
      void loadShares().catch(() => {
        setStatus('error');
        setError('Share status is unavailable.');
      });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [open, status]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.setTimeout(() => {
      (closeButtonRef.current ?? dialogRef.current)?.focus();
    }, 0);
    return () => {
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((element) => element.offsetParent !== null);
      const first = focusable[0] ?? dialog;
      const last = focusable[focusable.length - 1] ?? dialog;
      if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  async function createShare() {
    if (!csrfToken || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/share/task', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SHARE_CSRF_HEADER]: csrfToken,
        },
        body: JSON.stringify({ taskId, ttlMs: DEFAULT_TTL_MS }),
      });
      if (!res.ok) throw new Error(`create-${res.status}`);
      const body = await res.json() as CreateTaskShareApiResponse;
      setGeneratedJoinUrl({
        taskId: body.share.taskId,
        invitationId: body.share.invitationId,
        url: body.joinUrl,
      });
      setShares((prev) => [body.share, ...prev.filter((share) => share.invitationId !== body.share.invitationId)]);
      setStatus('ready');
    } catch {
      setError('Share link was not created.');
    } finally {
      setBusy(false);
    }
  }

  async function revokeShare(invitationId: string) {
    if (!csrfToken || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/share/task/${encodeURIComponent(invitationId)}/revoke`, {
        method: 'POST',
        headers: { [SHARE_CSRF_HEADER]: csrfToken },
      });
      if (!res.ok) throw new Error(`revoke-${res.status}`);
      const body = await res.json() as RevokeTaskShareApiResponse;
      setShares((prev) => [body.share, ...prev.filter((share) => share.invitationId !== body.share.invitationId)]);
      setGeneratedJoinUrl((prev) => (
        prev?.invitationId === body.share.invitationId ? null : prev
      ));
    } catch {
      setError('Revoke did not complete. Local access is marked revoke-pending until retry succeeds.');
      await loadShares().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="dialog-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        ref={dialogRef}
        className="dialog task-share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-share-title"
        tabIndex={-1}
      >
        <div className="dialog-header">
          <h3 id="task-share-title">Share this task</h3>
          <button ref={closeButtonRef} type="button" className="dialog-close" aria-label="Close share dialog" onClick={onClose}>
            <span aria-hidden="true">&times;</span>
          </button>
        </div>

        <div className="task-share-subject">
          <span>View-only access</span>
          <strong>{taskLabel}</strong>
        </div>

        {status === 'loading' && <p className="task-share-muted">Loading share status...</p>}

        {status === 'disabled' && (
          <div className="task-share-disabled" role="status">
            <strong>Preconfigured relay required</strong>
            <p>
              Set <code>KOOKR_RELAY_URL</code> and <code>KOOKR_RELAY_TOKEN</code>, then restart Kookr to enable task sharing.
            </p>
          </div>
        )}

        {status === 'error' && (
          <div className="task-share-error" role="alert">{error ?? 'Share status is unavailable.'}</div>
        )}

        {status === 'ready' && (
          <>
            <div className="task-share-row">
              <span>Expires</span>
              <strong>{displayedShare ? formatExpiry(displayedShare.expiresAt) : '10 minutes after creation'}</strong>
            </div>

            <div className="task-share-state" role="status" aria-live="polite">
              {displayedShare ? stateTitle(displayedShare) : 'No active share'}
            </div>

            {joinUrl && (
              <label className="task-share-link">
                <span>Share link</span>
                <input readOnly value={joinUrl} onFocus={(event) => event.currentTarget.select()} />
                <small className={fragmentSafe ? 'task-share-muted' : 'task-share-error'}>
                  {fragmentSafe ? 'Invite token is in the URL fragment.' : 'Invite token URL is not fragment-only.'}
                </small>
              </label>
            )}

            <div className="task-share-actions">
              <button type="button" className="btn-primary" onClick={createShare} disabled={busy || Boolean(activeShare)}>
                Create share link
              </button>
              {displayedShare && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => revokeShare(displayedShare.invitationId)}
                  disabled={busy || displayedShare.state === 'revoked' || displayedShare.state === 'expired'}
                >
                  Revoke
                </button>
              )}
            </div>

            {error && <div className="task-share-error" role="alert">{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}
