import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CreateTaskShareApiResponse,
  ListTaskSharesApiResponse,
  ResolveTaskShareGrantRequestApiResponse,
  TaskShareGrantRequest,
  TaskShareMutableGrant,
  RevokeTaskShareApiResponse,
  TaskShareTicket,
  TaskShareOwnerState,
  TaskShareSummary,
} from '../../remote/share-contract.js';

const SHARE_CSRF_HEADER = 'x-kookr-csrf';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const SHARE_DURATIONS = [
  { label: '10 minutes', ms: 10 * 60 * 1000 },
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '8 hours', ms: 8 * 60 * 60 * 1000 },
  { label: '24 hours', ms: ONE_DAY_MS },
  { label: '7 days', ms: 7 * ONE_DAY_MS },
  { label: '14 days', ms: 14 * ONE_DAY_MS },
  { label: '31 days', ms: 31 * ONE_DAY_MS },
] as const;
const DEFAULT_TTL_MS = SHARE_DURATIONS[0].ms;
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
  ticket?: TaskShareTicket;
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
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // A longer share can expire on a later calendar day; include the date then
  // so a bare "08:30" is not read as a time already in the past.
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString()} ${time}`;
}

function joinUrlUsesFragment(url: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.search === ''
      && (parsed.hash.startsWith('#inviteToken=') || parsed.hash.startsWith('#password='));
  } catch {
    return false;
  }
}

function shareCreateErrorMessage(errorCode: string | undefined): string {
  switch (errorCode) {
    case 'hosted-relay-maintenance':
      return 'Hosted relay is in maintenance mode. Local Kookr remains available.';
    case 'hosted-relay-emergency-disabled':
      return 'Hosted relay sharing is temporarily disabled. Local Kookr remains available.';
    case 'rate-limit-exceeded':
      return 'Share creation is temporarily rate-limited.';
    default:
      return 'Share link was not created.';
  }
}

function grantLabel(grant: TaskShareMutableGrant): string {
  switch (grant) {
    case 'terminalInput':
      return 'Terminal input';
    case 'launch':
      return 'Launch';
    case 'stop':
      return 'Stop';
    case 'permissionApprove':
      return 'Permission approval';
  }
}

export function TaskShareModal({ taskId, taskLabel, open, onClose }: Props) {
  const [status, setStatus] = useState<ShareModalStatus>('idle');
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [shares, setShares] = useState<TaskShareSummary[]>([]);
  const [generatedJoinUrl, setGeneratedJoinUrl] = useState<GeneratedJoinUrl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ttlMs, setTtlMs] = useState<number>(DEFAULT_TTL_MS);
  const [shareMaxTtlMs, setShareMaxTtlMs] = useState<number>(ONE_DAY_MS);
  const [displayLabel, setDisplayLabel] = useState('');
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
    ? generatedJoinUrl.ticket?.joinUrl ?? generatedJoinUrl.url
    : null;
  const shareTicket = generatedJoinUrl?.taskId === taskId
    && generatedJoinUrl.invitationId === displayedShare?.invitationId
    ? generatedJoinUrl.ticket
    : null;
  const fragmentSafe = joinUrlUsesFragment(joinUrl);
  const durationOptions = SHARE_DURATIONS.filter((option) => option.ms <= shareMaxTtlMs);
  const longLivedShare = ttlMs > ONE_DAY_MS;
  const longLivedWarningId = 'task-share-long-lived-warning';

  async function loadShares() {
    const res = await fetch('/api/share/task');
    if (res.status === 409) {
      setStatus('disabled');
      setShares([]);
      return;
    }
    if (!res.ok) throw new Error(`share-list-${res.status}`);
    const body = await res.json() as ListTaskSharesApiResponse;
    if (typeof body.shareMaxTtlMs === 'number' && Number.isFinite(body.shareMaxTtlMs)) {
      setShareMaxTtlMs(body.shareMaxTtlMs);
      if (ttlMs > body.shareMaxTtlMs) {
        setTtlMs(SHARE_DURATIONS.filter((option) => option.ms <= body.shareMaxTtlMs!).at(-1)?.ms ?? DEFAULT_TTL_MS);
      }
    }
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
        const tokenBody = await tokenRes.json() as { csrfToken?: unknown; shareMaxTtlMs?: unknown };
        if (typeof tokenBody.csrfToken !== 'string') throw new Error('csrf-missing');
        if (typeof tokenBody.shareMaxTtlMs === 'number' && Number.isFinite(tokenBody.shareMaxTtlMs)) {
          setShareMaxTtlMs(tokenBody.shareMaxTtlMs);
        }
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
        body: JSON.stringify({
          taskId,
          ttlMs,
          ...(displayLabel.trim() ? { displayLabel: displayLabel.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const failed = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(shareCreateErrorMessage(failed.error));
      }
      const body = await res.json() as CreateTaskShareApiResponse;
      setGeneratedJoinUrl({
        taskId: body.share.taskId,
        invitationId: body.share.invitationId,
        url: body.joinUrl,
        ...(body.shareTicket ? { ticket: body.shareTicket } : {}),
      });
      setShares((prev) => [body.share, ...prev.filter((share) => share.invitationId !== body.share.invitationId)]);
      setStatus('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Share link was not created.');
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

  async function resolveGrantRequest(invitationId: string, requestId: string, decision: 'approve' | 'deny') {
    if (!csrfToken || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/share/task/${encodeURIComponent(invitationId)}/grant-requests/${encodeURIComponent(requestId)}/${decision}`,
        {
          method: 'POST',
          headers: { [SHARE_CSRF_HEADER]: csrfToken },
        },
      );
      if (!res.ok) throw new Error(`grant-request-${decision}-${res.status}`);
      const body = await res.json() as ResolveTaskShareGrantRequestApiResponse;
      setShares((prev) => [body.share, ...prev.filter((share) => share.invitationId !== body.share.invitationId)]);
    } catch {
      setError(decision === 'approve' ? 'Grant request was not approved.' : 'Grant request was not denied.');
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
            <strong>Relay connection required</strong>
            <p>
              Connect an issued relay node token in Settings to enable task sharing.
            </p>
          </div>
        )}

        {status === 'error' && (
          <div className="task-share-error" role="alert">{error ?? 'Share status is unavailable.'}</div>
        )}

        {status === 'ready' && (
          <>
            {activeShare ? (
              <div className="task-share-row">
                <span>Expires</span>
                <strong>{formatExpiry(activeShare.expiresAt)}</strong>
              </div>
            ) : (
              <label className="task-share-row">
                <span>Link expires in</span>
                <select
                  value={ttlMs}
                  onChange={(event) => setTtlMs(Number(event.currentTarget.value))}
                  aria-describedby={longLivedShare ? longLivedWarningId : undefined}
                  disabled={busy}
                >
                  {durationOptions.map((option) => (
                    <option key={option.ms} value={option.ms}>{option.label}</option>
                  ))}
                </select>
              </label>
            )}

            {!activeShare && (
              <label className="task-share-row">
                <span>Display label</span>
                <input
                  value={displayLabel}
                  maxLength={80}
                  placeholder={taskLabel}
                  onInput={(event) => setDisplayLabel(event.currentTarget.value)}
                  disabled={busy}
                />
              </label>
            )}

            {!activeShare && longLivedShare && (
              <div id={longLivedWarningId} className="task-share-error" role="status" aria-live="polite">
                This share can expose the display label, status, finding flag, needs-input flag, and updated time until it expires.
              </div>
            )}

            <div className="task-share-state" role="status" aria-live="polite">
              {displayedShare ? stateTitle(displayedShare) : 'No active share'}
            </div>

            {displayedShare && displayedShare.grants.length > 1 && (
              <div className="task-share-row" aria-label="Approved collaborator grants">
                <span>Approved grants</span>
                <strong>{displayedShare.grants.filter((grant) => grant !== 'view').map(grantLabel).join(', ')}</strong>
              </div>
            )}

            {displayedShare?.grantRequests.some((request) => request.status === 'pending') && (
              <div className="task-share-requests" aria-label="Collaborator grant requests">
                {displayedShare.grantRequests
                  .filter((request): request is TaskShareGrantRequest & { status: 'pending' } => request.status === 'pending')
                  .map((request) => (
                    <div className="task-share-request" key={request.requestId}>
                      <div>
                        <strong>{request.requestedGrants.map(grantLabel).join(', ')}</strong>
                        {request.comment && <p>{request.comment}</p>}
                      </div>
                      <div className="task-share-actions">
                        <button
                          type="button"
                          className="btn-primary"
                          disabled={busy || displayedShare.state === 'revoked' || displayedShare.state === 'expired'}
                          onClick={() => resolveGrantRequest(displayedShare.invitationId, request.requestId, 'approve')}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={busy || displayedShare.state === 'revoked' || displayedShare.state === 'expired'}
                          onClick={() => resolveGrantRequest(displayedShare.invitationId, request.requestId, 'deny')}
                        >
                          Deny
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            )}

            {joinUrl && (
              <>
                {shareTicket && (
                  <div className="task-share-ticket" aria-label="Share ID and password">
                    <label>
                      <span>Share ID</span>
                      <input readOnly value={shareTicket.shareId} onFocus={(event) => event.currentTarget.select()} />
                    </label>
                    <label>
                      <span>Password</span>
                      <input readOnly value={shareTicket.password} onFocus={(event) => event.currentTarget.select()} />
                    </label>
                  </div>
                )}
                <label className="task-share-link">
                  <span>Share link</span>
                  <input readOnly value={joinUrl} onFocus={(event) => event.currentTarget.select()} />
                  <small className={fragmentSafe ? 'task-share-muted' : 'task-share-error'}>
                    {fragmentSafe ? 'Secret is in the URL fragment.' : 'Share URL is not fragment-only.'}
                  </small>
                </label>
              </>
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
