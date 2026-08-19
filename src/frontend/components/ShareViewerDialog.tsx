// --- Owner Share dialog (#808 control surface, #811 scope picker + expiry) ---
//
// Create / list / revoke read-only viewer links. The owner picks a scope (the
// whole dashboard, or a single project) and an optional expiry, then copies the
// one-time handoff URL. Project-scoped links are minted only once both data
// channels enforce scope (dashboard #809 + terminal #810); the server still
// re-validates the scope on create. The raw token is shown exactly once.

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { useKookrStore } from '../store/useStore.js';
import {
  createViewerLink,
  listViewerLinks,
  revokeViewerLink,
  type CreatedViewerLink,
  type ViewerScope,
  type ViewerLinksResponse,
} from '../viewer-share-api.js';

interface Props {
  onClose: () => void;
}

type ScopeKind = 'all' | 'projects';

/** Expiry presets → milliseconds from now (null = never expires). */
const EXPIRY_PRESETS: ReadonlyArray<{ value: string; label: string; ms: number | null }> = [
  { value: 'never', label: 'Never', ms: null },
  { value: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { value: '24h', label: '24 hours', ms: 24 * 60 * 60 * 1000 },
  { value: '7d', label: '7 days', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: '30 days', ms: 30 * 24 * 60 * 60 * 1000 },
];

function grantStatus(grant: ViewerLinksResponse['grants'][number]): 'revoked' | 'expired' | 'active' {
  if (grant.revokedAt) return 'revoked';
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) return 'expired';
  return 'active';
}

function describeScope(scope: ViewerScope, nameById: Map<string, string>): string {
  if (scope.kind === 'all') return 'Whole dashboard';
  const names = scope.projectIds.map((id) => nameById.get(id) ?? id);
  return names.length ? `Project: ${names.join(', ')}` : 'No projects';
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - Date.parse(iso);
  if (Number.isNaN(diffMs)) return '';
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Earliest connectedAt for a grant across the roster, if any connection exists. */
function connectionSince(roster: ViewerLinksResponse['roster'], grantId: string): string | null {
  const times = roster
    .filter((r) => r.grantId === grantId)
    .map((r) => Date.parse(r.connectedAt))
    .filter((t) => !Number.isNaN(t));
  if (!times.length) return null;
  return new Date(Math.min(...times)).toISOString();
}

/** How many viewers are connected to a grant right now (0 when none). */
export function watchingCount(roster: ViewerLinksResponse['roster'], grantId: string): number {
  return roster.reduce((n, r) => (r.grantId === grantId ? n + 1 : n), 0);
}

/** Live "N watching" label for a grant, or null when nobody is connected. */
export function watchingLabel(roster: ViewerLinksResponse['roster'], grantId: string): string | null {
  const n = watchingCount(roster, grantId);
  return n < 1 ? null : `${n} watching`;
}

export function ShareViewerDialog({ onClose }: Props) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);

  const projectSummaries = useKookrStore((s) => s.projectSummaries);
  const nameById = useMemo(
    () => new Map(projectSummaries.map((p) => [p.project, p.displayName] as const)),
    [projectSummaries],
  );

  const [data, setData] = useState<ViewerLinksResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [scopeKind, setScopeKind] = useState<ScopeKind>('all');
  const [scopeProject, setScopeProject] = useState<string>('');
  const [expiry, setExpiry] = useState<string>('never');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<CreatedViewerLink | null>(null);
  const [copied, setCopied] = useState(false);

  useDialogFocus({ dialogRef, initialFocusRef: labelInputRef });
  useEscapeToClose(onClose);

  // Default the project select to the first available project once summaries load.
  useEffect(() => {
    if (!scopeProject && projectSummaries.length > 0) {
      setScopeProject(projectSummaries[0].project);
    }
  }, [projectSummaries, scopeProject]);

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

  const projectsScopeUnavailable = scopeKind === 'projects' && projectSummaries.length === 0;

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;

    let scope: ViewerScope;
    if (scopeKind === 'projects') {
      if (!scopeProject) {
        setActionError('Pick a project to scope the link to.');
        return;
      }
      scope = { kind: 'projects', projectIds: [scopeProject] };
    } else {
      scope = { kind: 'all' };
    }

    const preset = EXPIRY_PRESETS.find((p) => p.value === expiry);
    const expiresAt = preset?.ms != null ? new Date(Date.now() + preset.ms).toISOString() : undefined;

    setBusy(true);
    setActionError(null);
    try {
      const created = await createViewerLink({
        label: label.trim() || 'Viewer link',
        scope,
        ...(expiresAt ? { expiresAt } : {}),
      });
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
          Create a link that gives someone a live, read-only view. They cannot launch, stop, or type
          into anything. Pick a scope and an optional expiry; revoke a link any time.
        </p>

        <form className="share-viewer-dialog__form" onSubmit={handleCreate}>
          <div className="share-viewer-dialog__field">
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
          </div>

          <div className="share-viewer-dialog__field">
            <span className="share-viewer-dialog__field-label" id={`${titleId}-scope-label`}>
              Scope
            </span>
            <div className="share-viewer-dialog__scope" role="radiogroup" aria-labelledby={`${titleId}-scope-label`}>
              <label>
                <input
                  type="radio"
                  name={`${titleId}-scope`}
                  value="all"
                  checked={scopeKind === 'all'}
                  onChange={() => setScopeKind('all')}
                  disabled={busy}
                />
                Whole dashboard
              </label>
              <label>
                <input
                  type="radio"
                  name={`${titleId}-scope`}
                  value="projects"
                  checked={scopeKind === 'projects'}
                  onChange={() => setScopeKind('projects')}
                  disabled={busy}
                />
                A project
              </label>
              {scopeKind === 'projects' && (
                <select
                  aria-label="Project to share"
                  value={scopeProject}
                  onChange={(e) => setScopeProject(e.target.value)}
                  disabled={busy || projectSummaries.length === 0}
                >
                  {projectSummaries.length === 0 && <option value="">No projects available</option>}
                  {projectSummaries.map((p) => (
                    <option key={p.project} value={p.project}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>

          <div className="share-viewer-dialog__field">
            <label htmlFor={`${titleId}-expiry`}>Expires</label>
            <select
              id={`${titleId}-expiry`}
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              disabled={busy}
            >
              {EXPIRY_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <button type="submit" disabled={busy || projectsScopeUnavailable}>
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
              const since = status === 'active' ? connectionSince(data.roster, grant.id) : null;
              const watching = status === 'active' ? watchingLabel(data.roster, grant.id) : null;
              return (
                <li key={grant.id} className={`share-viewer-dialog__item is-${status}`}>
                  <span className="share-viewer-dialog__item-main">
                    <span className="share-viewer-dialog__item-label">{grant.label}</span>
                    <span className="share-viewer-dialog__item-scope">{describeScope(grant.scope, nameById)}</span>
                  </span>
                  <span className="share-viewer-dialog__item-status">
                    {status}
                    {since ? ` · connected ${timeAgo(since)}` : ''}
                    {watching ? ` · ${watching}` : ''}
                    {status === 'active' && grant.expiresAt ? ` · expires ${timeAgo(grant.expiresAt) === 'just now' ? 'soon' : new Date(grant.expiresAt).toLocaleDateString()}` : ''}
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
