import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CreateTaskShareApiResponse,
  ListTaskSharesApiResponse,
  TaskShareMutableGrant,
  RevokeTaskShareApiResponse,
  TaskShareTicket,
  TaskShareOwnerState,
  TaskShareSummary,
} from '../../remote/share-contract.js';
import type {
  ContactShareInboxItem,
  KookrContact,
  ListContactShareContactsApiResponse,
  ListContactShareInboxApiResponse,
  ListSharedTasksApiResponse,
  SharedTask,
} from '../../shared/contracts/contact-share.js';

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
type CopiedShareSecret = 'share-link' | 'share-id' | 'password';
type SharePath = 'contact' | 'guest';

interface Props {
  taskId: string;
  taskLabel: string;
  open: boolean;
  onClose: () => void;
  onSharesChanged?: (shares: TaskShareSummary[]) => void;
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

function isTerminalShare(share: TaskShareSummary): boolean {
  return share.state === 'revoked' || share.state === 'expired';
}

function replaceShare(shares: TaskShareSummary[], nextShare: TaskShareSummary): TaskShareSummary[] {
  return [nextShare, ...shares.filter((share) => share.invitationId !== nextShare.invitationId)];
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

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();

  try {
    if (!document.execCommand('copy')) {
      throw new Error('copy-failed');
    }
  } finally {
    document.body.removeChild(textarea);
    previousFocus?.focus();
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
      return 'Guest link was not created.';
  }
}

function grantLabel(grant: TaskShareMutableGrant): string {
  switch (grant) {
    case 'terminalView':
      return 'Watch terminal';
    case 'terminalInput':
      return 'Send messages';
    case 'launch':
      return 'Launch';
    case 'stop':
      return 'Stop';
    case 'permissionApprove':
      return 'Permission approval';
  }
}

function terminalSharingTitle(share: TaskShareSummary): string {
  if (!share.terminalSharing) return 'Status unavailable';
  if (share.terminalSharing.state === 'available') return 'Available';
  switch (share.terminalSharing.reason) {
    case 'nodeUntrusted':
      return 'Disabled for this node';
    case 'relayNodeOffline':
      return 'Node offline';
    case 'nodeFeatureUnavailable':
      return 'Feature unavailable';
    case 'terminalAdapterUnavailable':
      return 'Adapter unavailable';
    case 'policySyncPending':
      return 'Approval syncing';
    case 'relayNotConfigured':
      return 'Relay setup required';
  }
}

export function TaskShareModal({ taskId, taskLabel, open, onClose, onSharesChanged }: Props) {
  const [status, setStatus] = useState<ShareModalStatus>('idle');
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [shares, setShares] = useState<TaskShareSummary[]>([]);
  const [generatedJoinUrl, setGeneratedJoinUrl] = useState<GeneratedJoinUrl | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ttlMs, setTtlMs] = useState<number>(DEFAULT_TTL_MS);
  const [shareMaxTtlMs, setShareMaxTtlMs] = useState<number>(ONE_DAY_MS);
  const [displayLabel, setDisplayLabel] = useState('');
  const [newShareMode, setNewShareMode] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState<CopiedShareSecret | null>(null);
  const [passwordRevealed, setPasswordRevealed] = useState(false);
  const [sharePath, setSharePath] = useState<SharePath>('contact');
  const [contacts, setContacts] = useState<KookrContact[]>([]);
  const [inbox, setInbox] = useState<ContactShareInboxItem[]>([]);
  const [sharedTasks, setSharedTasks] = useState<SharedTask[]>([]);
  const sharesRef = useRef<TaskShareSummary[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const currentShares = useMemo(
    () => shares.filter((share) => share.taskId === taskId),
    [shares, taskId],
  );
  const activeShare = currentShares.find(isActiveShare) ?? null;
  const latestShare = activeShare ?? currentShares[0] ?? null;
  const terminalShareCandidate = latestShare && isTerminalShare(latestShare) ? latestShare : null;
  const terminalShare = terminalShareCandidate && !newShareMode ? terminalShareCandidate : null;
  const displayedShare = terminalShareCandidate && newShareMode ? null : latestShare;
  const showCreateForm = !activeShare && !terminalShare;
  const joinUrl = generatedJoinUrl?.taskId === taskId
    && generatedJoinUrl.invitationId === displayedShare?.invitationId
    && displayedShare !== null
    && isActiveShare(displayedShare)
    ? generatedJoinUrl.ticket?.joinUrl ?? generatedJoinUrl.url
    : null;
  const shareTicket = generatedJoinUrl?.taskId === taskId
    && generatedJoinUrl.invitationId === displayedShare?.invitationId
    && displayedShare !== null
    && isActiveShare(displayedShare)
    ? generatedJoinUrl.ticket
    : null;
  const fragmentSafe = joinUrlUsesFragment(joinUrl);
  const hasCopyableCredentials = Boolean(joinUrl);
  const durationOptions = SHARE_DURATIONS.filter((option) => option.ms <= shareMaxTtlMs);
  const longLivedShare = ttlMs > ONE_DAY_MS;
  const longLivedWarningId = 'task-share-long-lived-warning';
  const guestPathSelected = sharePath === 'guest';
  const verifiedContacts = contacts.filter((contact) => contact.trustState === 'verified');
  const pendingInbox = inbox.filter((item) => item.lifecycle === 'pending');
  const pendingGrantRequestCount = displayedShare?.grantRequests.filter((request) => request.status === 'pending').length ?? 0;

  function commitShares(nextShares: TaskShareSummary[]) {
    sharesRef.current = nextShares;
    setShares(nextShares);
    onSharesChanged?.(nextShares);
  }

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
    commitShares(body.shares);
    setStatus('ready');
  }

  async function loadContactShare() {
    const [contactsRes, inboxRes, sharedTasksRes] = await Promise.all([
      fetch('/api/contact-share/contacts'),
      fetch('/api/contact-share/inbox'),
      fetch('/api/contact-share/shared-tasks'),
    ]);
    if (contactsRes.ok) {
      const body = await contactsRes.json() as Partial<ListContactShareContactsApiResponse>;
      setContacts(Array.isArray(body.contacts) ? body.contacts : []);
    }
    if (inboxRes.ok) {
      const body = await inboxRes.json() as Partial<ListContactShareInboxApiResponse>;
      setInbox(Array.isArray(body.inbox) ? body.inbox : []);
    }
    if (sharedTasksRes.ok) {
      const body = await sharedTasksRes.json() as Partial<ListSharedTasksApiResponse>;
      setSharedTasks(Array.isArray(body.sharedTasks) ? body.sharedTasks : []);
    }
  }

  useEffect(() => {
    if (!open) return;
    setNewShareMode(false);
    setGeneratedJoinUrl(null);
    setSharePath('contact');
  }, [open, taskId]);

  useEffect(() => {
    if (!open || !latestShare) return;
    setSharePath('guest');
  }, [open, taskId, latestShare?.invitationId]);

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
        await loadContactShare().catch(() => undefined);
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

  useEffect(() => {
    if (!open) {
      setCopiedSecret(null);
      setPasswordRevealed(false);
    }
  }, [open]);

  useEffect(() => {
    setCopiedSecret(null);
    setPasswordRevealed(false);
  }, [taskId, displayedShare?.invitationId]);

  useEffect(() => {
    if (!copiedSecret) return;
    const timer = window.setTimeout(() => setCopiedSecret(null), 1_200);
    return () => window.clearTimeout(timer);
  }, [copiedSecret]);

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
      setNewShareMode(false);
      commitShares(replaceShare(sharesRef.current, body.share));
      setStatus('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Guest link was not created.');
    } finally {
      setBusy(false);
    }
  }

  async function sendContactShare(contact: KookrContact) {
    const device = contact.devices[0];
    if (!device || !csrfToken || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/contact-share/shares', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SHARE_CSRF_HEADER]: csrfToken,
        },
        body: JSON.stringify({
          taskId,
          contactId: contact.contactId,
          recipientDeviceId: device.deviceId,
        }),
      });
      if (!res.ok) throw new Error(`contact-share-${res.status}`);
      await loadContactShare().catch(() => undefined);
    } catch {
      setError('Contact Share invitation was not sent.');
    } finally {
      setBusy(false);
    }
  }

  async function decideInboxShare(shareId: string, decision: 'accept' | 'refuse') {
    if (!csrfToken || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/contact-share/inbox/${encodeURIComponent(shareId)}/${decision}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SHARE_CSRF_HEADER]: csrfToken,
        },
        body: JSON.stringify({ recipientDeviceId: 'local-device' }),
      });
      if (!res.ok) throw new Error(`contact-share-${decision}-${res.status}`);
      await loadContactShare();
    } catch {
      setError(decision === 'accept' ? 'Contact Share was not accepted.' : 'Contact Share was not refused.');
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
      commitShares(replaceShare(sharesRef.current, body.share));
      setNewShareMode(false);
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

  function enterNewShareMode() {
    setNewShareMode(true);
    setTtlMs(DEFAULT_TTL_MS);
    setDisplayLabel('');
    setGeneratedJoinUrl(null);
  }

  function handleCreateAction() {
    if (terminalShare) {
      enterNewShareMode();
      return;
    }
    void createShare();
  }

  async function copyShareSecret(kind: CopiedShareSecret, value: string) {
    try {
      await copyText(value);
      setCopiedSecret(kind);
      setError(null);
    } catch {
      setCopiedSecret(null);
      setError('Copy did not complete.');
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
          <span>Task</span>
          <strong>{taskLabel}</strong>
        </div>

        <div className="task-share-paths" role="group" aria-label="Share path">
          <button
            type="button"
            aria-pressed={sharePath === 'contact'}
            className={`task-share-path${sharePath === 'contact' ? ' task-share-path--active' : ''}`}
            onClick={() => setSharePath('contact')}
          >
            <span>Send to Kookr contact</span>
            <strong>Secure default</strong>
          </button>
          <button
            type="button"
            aria-pressed={sharePath === 'guest'}
            className={`task-share-path${sharePath === 'guest' ? ' task-share-path--active' : ''}`}
            onClick={() => setSharePath('guest')}
          >
            <span>Create guest link</span>
            <strong>Browser fallback</strong>
          </button>
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

        {status === 'ready' && sharePath === 'contact' && (
          <>
            <section className="task-share-policy-panel" aria-label="Contact Share policy">
              <div>
                <strong>Contact Share is the secure Kookr-to-Kookr path.</strong>
                <p>
                  It notifies a verified contact inside Kookr, lets them accept or refuse,
                  and shows accepted shares as remote-owned shared tasks.
                </p>
              </div>
              <span className="task-share-marker">Encrypted inbox</span>
            </section>

            <section className="task-share-contact-list" aria-label="Verified contacts">
              <div className="task-share-row">
                <span>Verified contacts</span>
                <strong>{verifiedContacts.length}</strong>
              </div>
              {verifiedContacts.length === 0 ? (
                <p className="task-share-muted">Pair a verified contact before sending a Contact Share.</p>
              ) : verifiedContacts.map((contact) => (
                <div key={contact.contactId} className="task-share-contact-row">
                  <div>
                    <strong>{contact.displayName}</strong>
                    <span>{contact.devices.length} device{contact.devices.length === 1 ? '' : 's'}</span>
                  </div>
                  <button
                    type="button"
                    className="btn-primary"
                    aria-label={`Send Contact Share to ${contact.displayName}`}
                    disabled={busy}
                    onClick={() => void sendContactShare(contact)}
                  >
                    Send
                  </button>
                </div>
              ))}
            </section>

            <section className="task-share-inbox" aria-label="Contact Share inbox">
              <div className="task-share-row">
                <span>Inbox</span>
                <strong>{pendingInbox.length} pending</strong>
              </div>
              {pendingInbox.length === 0 ? (
                <p className="task-share-muted">No pending Contact Share invitations.</p>
              ) : pendingInbox.map((item) => (
                <div key={item.shareId} className="task-share-inbox-row">
                  <div>
                    <strong>{item.notificationTitle}</strong>
                    <span>{item.notificationBody}</span>
                  </div>
                  <div className="task-share-field-actions">
                    <button
                      type="button"
                      className="btn-primary"
                      aria-label={`Accept Contact Share invitation from ${item.senderDisplayName}`}
                      disabled={busy}
                      onClick={() => void decideInboxShare(item.shareId, 'accept')}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      aria-label={`Refuse Contact Share invitation from ${item.senderDisplayName}`}
                      disabled={busy}
                      onClick={() => void decideInboxShare(item.shareId, 'refuse')}
                    >
                      Refuse
                    </button>
                  </div>
                </div>
              ))}
            </section>

            <section className="task-share-preview" aria-label="Shared task visual model">
              <div className="task-share-preview-title">
                <span className="task-share-marker">Shared</span>
                <strong>{taskLabel}</strong>
              </div>
              <div className="task-share-preview-meta">
                <span>From contact</span>
                <span>Remote node</span>
                <span>View only</span>
                {sharedTasks.length > 0 && <span>{sharedTasks.length} accepted</span>}
              </div>
            </section>

            <div className="task-share-disabled" role="status">
              <strong>Public controls stay disabled</strong>
              <p>
                Terminal input, permission approval, launch, stop, and collaborator
                actions remain unavailable for public shares.
              </p>
            </div>
          </>
        )}

        {status === 'ready' && guestPathSelected && (
          <>
            <div className="task-share-disabled" role="status">
              <strong>Guest Link is lower assurance</strong>
              <p>
                Use this for people without Kookr installed. It is anonymous,
                browser-compatible, and view-only by default.
              </p>
            </div>

            {activeShare ? (
              <div className="task-share-row">
                <span>Expires</span>
                <strong>{formatExpiry(activeShare.expiresAt)}</strong>
              </div>
            ) : showCreateForm ? (
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
            ) : null}

            {terminalShare && (
              <p className="task-share-muted">
                This guest link is no longer active. Create a new guest link to invite another viewer.
              </p>
            )}

            {showCreateForm && (
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

            {showCreateForm && longLivedShare && (
              <div id={longLivedWarningId} className="task-share-error" role="status" aria-live="polite">
                This share can expose the display label, status, finding flag, needs-input flag, and updated time until it expires.
              </div>
            )}

            <div className="task-share-state" role="status" aria-live="polite">
              {displayedShare ? stateTitle(displayedShare) : 'No active share'}
            </div>

            {displayedShare && !terminalShare && displayedShare.grants.length > 1 && (
              <div className="task-share-row" aria-label="Approved collaborator grants">
                <span>Approved grants</span>
                <strong>{displayedShare.grants.filter((grant) => grant !== 'view').map(grantLabel).join(', ')}</strong>
              </div>
            )}

            {displayedShare?.terminalSharing && !terminalShare && (
              <section className="task-share-diagnostic" aria-label="Terminal sharing status">
                <div className="task-share-row">
                  <span>Terminal sharing</span>
                  <strong>{terminalSharingTitle(displayedShare)}</strong>
                </div>
                <p>{displayedShare.terminalSharing.message}</p>
                {displayedShare.terminalSharing.state === 'blocked'
                  && displayedShare.terminalSharing.remediation?.kind === 'setEnvAndRestart' && (
                    <div className="task-share-remediation">
                      <code>
                        {displayedShare.terminalSharing.remediation.envName}=
                        {displayedShare.terminalSharing.remediation.expectedValue}
                      </code>
                      <code>{displayedShare.terminalSharing.remediation.command}</code>
                    </div>
                )}
              </section>
            )}

            {displayedShare && !terminalShare && pendingGrantRequestCount > 0 && (
              <div className="task-share-disabled" role="status">
                <strong>Guest links stay view-only</strong>
                <p>
                  {pendingGrantRequestCount === 1 ? 'One control request is' : `${pendingGrantRequestCount} control requests are`}
                  {' '}waiting, but public guest links cannot approve terminal or task controls.
                </p>
              </div>
            )}

            {joinUrl && (
              <>
                {shareTicket && (
                  <div className="task-share-ticket" aria-label="Share ID and password">
                    <div className="task-share-field">
                      <label>
                        <span>Share ID</span>
                        <input readOnly value={shareTicket.shareId} onFocus={(event) => event.currentTarget.select()} />
                      </label>
                      <button
                        type="button"
                        className="btn-secondary task-share-copy"
                        aria-label="Copy Share ID"
                        onClick={() => void copyShareSecret('share-id', shareTicket.shareId)}
                      >
                        {copiedSecret === 'share-id' ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                    <div className="task-share-field">
                      <label>
                        <span>Password</span>
                        <input
                          readOnly
                          type={passwordRevealed ? 'text' : 'password'}
                          value={shareTicket.password}
                          onFocus={(event) => event.currentTarget.select()}
                        />
                      </label>
                      <div className="task-share-field-actions">
                        <button
                          type="button"
                          className="btn-secondary task-share-copy"
                          aria-label={passwordRevealed ? 'Hide password' : 'Show password'}
                          onClick={() => setPasswordRevealed((value) => !value)}
                        >
                          {passwordRevealed ? 'Hide' : 'Reveal'}
                        </button>
                        <button
                          type="button"
                          className="btn-secondary task-share-copy"
                          aria-label="Copy password"
                          onClick={() => void copyShareSecret('password', shareTicket.password)}
                        >
                          {copiedSecret === 'password' ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                <div className="task-share-link task-share-field">
                  <label htmlFor="task-share-link-input">Guest link</label>
                  <div className="task-share-input-row">
                    <input
                      id="task-share-link-input"
                      readOnly
                      value={joinUrl}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <button
                      type="button"
                      className="btn-secondary task-share-copy"
                      aria-label="Copy guest link from field"
                      onClick={() => void copyShareSecret('share-link', joinUrl)}
                    >
                      {copiedSecret === 'share-link' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <small className={fragmentSafe ? 'task-share-muted' : 'task-share-error'}>
                    {fragmentSafe ? 'Secret is in the URL fragment.' : 'Share URL is not fragment-only.'}
                  </small>
                </div>
              </>
            )}

            <div className="task-share-actions">
              {joinUrl ? (
                <button
                  type="button"
                  className="btn-primary"
                  aria-label="Copy guest link"
                  onClick={() => void copyShareSecret('share-link', joinUrl)}
                  disabled={busy}
                >
                  {copiedSecret === 'share-link' ? 'Copied' : 'Copy guest link'}
                </button>
              ) : (
                <button type="button" className="btn-primary" onClick={handleCreateAction} disabled={busy || Boolean(activeShare)}>
                  {terminalShare ? 'Create new guest link' : activeShare ? 'Guest link active' : 'Create guest link'}
                </button>
              )}
              {displayedShare && !terminalShare && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => revokeShare(displayedShare.invitationId)}
                  disabled={busy}
                >
                  Revoke
                </button>
              )}
            </div>

            {hasCopyableCredentials && (
              <div className="task-share-copy-status" aria-live="polite">
                {copiedSecret === 'share-link' && 'Guest link copied.'}
                {copiedSecret === 'share-id' && 'Share ID copied.'}
                {copiedSecret === 'password' && 'Password copied.'}
              </div>
            )}

            {error && <div className="task-share-error" role="alert">{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}
