import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  pluginNameFromId,
  pluginMarketplaceFromId,
  OWN_SESSION_BLAST_RADIUS,
  type ManagedPlugin,
  type PluginEnablement,
  type PluginStaleness,
  type ConfigDriftSurface,
  type OwnSessionScope,
} from '../../shared/contracts/plugins.js';
import {
  getPlugins,
  updatePlugin,
  getConfigDrift,
  ownSessionSetEnablement,
  ownSessionInstall,
} from '../api/index.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';

interface PluginManagerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Restart a drifted Kookr-managed session (RFC "Surfacing reload drift").
   * Wired by the parent to the existing relaunch flow; when absent, the drift
   * panel lists stale sessions without a restart button.
   */
  onRestartSession?: (taskId: string) => void;
}

const ENABLEMENT_LABEL: Record<PluginEnablement, string> = {
  enabled: 'Enabled',
  disabled: 'Disabled',
  default: 'Default',
};

function enablementTitle(state: PluginEnablement): string {
  switch (state) {
    case 'enabled':
      return 'Explicitly enabled in your Claude settings';
    case 'disabled':
      return 'Explicitly disabled in your Claude settings';
    case 'default':
      return 'No explicit setting — Claude Code applies its native default';
  }
}

function stalenessLabel(s: PluginStaleness): string {
  if (s.state === 'behind') return 'Update available';
  if (s.state === 'current') return 'Up to date';
  return 'Unknown';
}

/** A mutating own-session action staged behind the blast-radius disclosure (R4). */
interface PendingAction {
  title: string;
  /** Extra confirmation note, e.g. for `uninstallGuard` plugins (never one-click). */
  extraNote?: string;
  run: () => Promise<{ error?: string } | void>;
}

/**
 * Plugin Manager (RFC Layer 1 read model + Layer "Own-session assist (G3)/R4").
 * Lists every installed plugin with tri-state enablement, staleness, token cost,
 * and per-plugin update. P3 adds own-session mutations — enable/disable (inverse
 * single-key settings edit) and install — each gated behind the blast-radius +
 * `/reload-plugins` disclosure, plus the config-epoch reload-drift surface. No
 * per-skill toggles ship (R3a): the skills panel stays read-only elsewhere.
 */
export function PluginManagerDialog({ isOpen, onClose, onRestartSession }: PluginManagerDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEscapeToClose(onClose);
  useDialogFocus({ dialogRef, initialFocusRef: closeButtonRef });

  const [plugins, setPlugins] = useState<ManagedPlugin[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [drift, setDrift] = useState<ConfigDriftSurface | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { ok, body } = await getPlugins();
      if (!ok) {
        setLoadError('Could not load plugins.');
        return;
      }
      setPlugins(body.plugins);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDrift = useCallback(async () => {
    try {
      setDrift(await getConfigDrift());
    } catch {
      setDrift(null); // drift is advisory — never block the dialog on it
    }
  }, []);

  useEffect(() => {
    void load();
    void loadDrift();
  }, [load, loadDrift]);

  function clearRowError(id: string) {
    setRowError((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  async function onUpdate(id: string) {
    if (busyId) return;
    setBusyId(id);
    clearRowError(id);
    try {
      const { ok, body } = await updatePlugin(id);
      if (ok && body && 'status' in body && body.status === 'updated') {
        setPlugins((prev) => (prev ? prev.map((p) => (p.id === id ? body.plugin : p)) : prev));
        void loadDrift(); // an update bumps the epoch
      } else {
        const err = body as { error?: string } | null;
        setRowError((prev) => ({ ...prev, [id]: err?.error ?? 'Update failed.' }));
      }
    } catch (err) {
      setRowError((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusyId(null);
    }
  }

  /** Stage an own-session enable/disable/reset behind the disclosure. */
  function stageEnablement(p: ManagedPlugin, value: boolean | null) {
    const name = pluginNameFromId(p.id);
    const verb = value === null ? 'Reset to default' : value ? 'Enable' : 'Disable';
    setPending({
      title: `${verb} ${name} for your own sessions`,
      ...(p.uninstallGuard
        ? { extraNote: `Kookr depends on ${name}. Disabling it removes capabilities Kookr relies on — confirm you intend this.` }
        : {}),
      run: async () => {
        clearRowError(p.id);
        const scope: OwnSessionScope = 'user';
        const { ok, body } = await ownSessionSetEnablement({ pluginId: p.id, value, scope });
        if (ok && body && 'status' in body && body.status === 'applied') {
          setPlugins((prev) =>
            prev ? prev.map((x) => (x.id === p.id ? { ...x, enablement: body.enablement } : x)) : prev,
          );
          void loadDrift();
          return;
        }
        const err = body as { error?: string } | null;
        const message = err?.error ?? 'Change failed.';
        setRowError((prev) => ({ ...prev, [p.id]: message }));
        return { error: message };
      },
    });
  }

  async function confirmPending() {
    if (!pending || confirming) return;
    setConfirming(true);
    try {
      await pending.run();
    } finally {
      setConfirming(false);
      setPending(null);
    }
  }

  // --- Add-a-plugin form state ---
  const [showInstall, setShowInstall] = useState(false);
  const [installId, setInstallId] = useState('');
  const [installSource, setInstallSource] = useState('');
  const [installEnable, setInstallEnable] = useState(true);
  const [installError, setInstallError] = useState<string | null>(null);

  function stageInstall() {
    const pluginId = installId.trim();
    if (!pluginId.includes('@')) {
      setInstallError('Enter a full plugin id: <name>@<marketplace>.');
      return;
    }
    setInstallError(null);
    const source = installSource.trim();
    setPending({
      title: `Install ${pluginNameFromId(pluginId)} for your own sessions`,
      run: async () => {
        const { ok, body } = await ownSessionInstall({
          pluginId,
          ...(source ? { marketplaceSource: source } : {}),
          enableAfterInstall: installEnable,
          scope: 'user',
        });
        if (ok && body && 'status' in body && body.status === 'applied') {
          setInstallId('');
          setInstallSource('');
          setShowInstall(false);
          void load();
          void loadDrift();
          return;
        }
        const err = body as { error?: string } | null;
        const message = err?.error ?? 'Install failed.';
        setInstallError(message);
        return { error: message };
      },
    });
  }

  return (
    <div
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog plugin-manager-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-manager-dialog-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <h3 id="plugin-manager-dialog-title">Plugins &amp; skills</h3>
          <button
            ref={closeButtonRef}
            className="dialog-close"
            onClick={onClose}
            aria-label="Close plugin manager"
          >
            &times;
          </button>
        </div>

        <p style={{ marginTop: 8, color: 'var(--text-secondary)', fontSize: 13 }}>
          Every Claude Code plugin installed on this machine. Changes here affect your own sessions.
        </p>

        {/* Reload-drift surface (RFC "Surfacing reload drift"). */}
        {drift && drift.staleCount > 0 && (
          <div
            className="plugin-drift-panel"
            role="status"
            style={{
              marginTop: 10,
              padding: '8px 10px',
              borderRadius: 6,
              background: 'var(--surface-2, #2a2a2a)',
              fontSize: 13,
            }}
          >
            <div style={{ fontWeight: 600 }}>
              {drift.staleCount} session{drift.staleCount === 1 ? '' : 's'} started before your last change
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0' }}>
              {drift.staleSessions.map((s) => (
                <li key={s.taskId} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '2px 0' }}>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.title ?? s.taskId}{' '}
                    <span style={{ color: 'var(--text-secondary)' }}>(epoch {s.startedEpoch})</span>
                  </span>
                  {onRestartSession && (
                    <button className="linkish" onClick={() => onRestartSession(s.taskId)}>
                      Restart
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <div style={{ marginTop: 6, color: 'var(--text-secondary)', fontSize: 12 }}>
              {drift.externalCoverageNote}
            </div>
          </div>
        )}

        {/* Blast-radius disclosure, shown BEFORE any own-session mutation applies (R4). */}
        {pending && (
          <div
            className="plugin-confirm-panel"
            role="alertdialog"
            aria-label="Confirm change"
            style={{
              marginTop: 10,
              padding: '10px 12px',
              borderRadius: 6,
              border: '1px solid var(--border, #444)',
              background: 'var(--surface-2, #2a2a2a)',
              fontSize: 13,
            }}
          >
            <div style={{ fontWeight: 600 }}>{pending.title}</div>
            <div style={{ marginTop: 6 }}>{OWN_SESSION_BLAST_RADIUS}</div>
            {pending.extraNote && (
              <div style={{ marginTop: 6, color: 'var(--yellow, #e0b000)' }}>{pending.extraNote}</div>
            )}
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              <button className="btn-primary" onClick={() => void confirmPending()} disabled={confirming}>
                {confirming ? 'Applying…' : 'Apply'}
              </button>
              <button className="btn-secondary" onClick={() => setPending(null)} disabled={confirming}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {loading && <p style={{ color: 'var(--text-secondary)' }}>Loading plugins…</p>}

        {loadError && (
          <div style={{ marginTop: 12, color: 'var(--red)', fontSize: 13 }} role="alert">
            {loadError}{' '}
            <button className="linkish" onClick={() => void load()}>
              Retry
            </button>
          </div>
        )}

        {!loading && !loadError && plugins && plugins.length === 0 && (
          <p style={{ color: 'var(--text-secondary)' }}>
            No plugins installed. Add one below or from Claude Code&rsquo;s <code>/plugin</code> menu.
          </p>
        )}

        {!loading && !loadError && plugins && plugins.length > 0 && (
          <ul className="plugin-manager-list" style={{ listStyle: 'none', padding: 0, margin: '12px 0 0' }}>
            {plugins.map((p) => {
              const name = pluginNameFromId(p.id);
              const marketplace = pluginMarketplaceFromId(p.id);
              const behind = p.staleness.state === 'behind';
              const isBusy = busyId === p.id;
              return (
                <li
                  key={p.id}
                  className="plugin-manager-row"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    gap: 12,
                    padding: '10px 0',
                    borderTop: '1px solid var(--border, #333)',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {name}
                      {p.uninstallGuard && (
                        <span title="Kookr depends on this plugin — it won't offer a one-click uninstall" style={{ marginLeft: 6 }}>
                          🛡
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {marketplace ? <span>{marketplace}</span> : <span title="This plugin's marketplace is not registered in known_marketplaces.json">marketplace unknown</span>}
                      {' · '}
                      <span>v{p.installedVersion ?? '—'}</span>
                      {p.availableVersion && p.availableVersion !== p.installedVersion && (
                        <span> → v{p.availableVersion}</span>
                      )}
                      {typeof p.alwaysOnTokens === 'number' && (
                        <span> · ~{p.alwaysOnTokens.toLocaleString()} always-on tok</span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, marginTop: 2 }}>
                      <span className={`plugin-enablement plugin-enablement-${p.enablement}`} title={enablementTitle(p.enablement)}>
                        {ENABLEMENT_LABEL[p.enablement]}
                      </span>
                      {' · '}
                      <span
                        className={`plugin-staleness plugin-staleness-${p.staleness.state}`}
                        title={`${p.staleness.reason ?? ''} (source: ${p.staleness.source}, checked ${p.staleness.observedAt})`.trim()}
                      >
                        {stalenessLabel(p.staleness)}
                      </span>
                    </div>
                    {rowError[p.id] && (
                      <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 4 }} role="alert">
                        {rowError[p.id]}
                      </div>
                    )}
                  </div>
                  <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                    {/* Own-session enable/disable (settings edit — works even when the marketplace is unregistered). */}
                    <div style={{ display: 'flex', gap: 6 }}>
                      {p.enablement !== 'enabled' && (
                        <button className="btn-secondary" disabled={Boolean(busyId) || Boolean(pending)} onClick={() => stageEnablement(p, true)}>
                          Enable
                        </button>
                      )}
                      {p.enablement !== 'disabled' && (
                        <button className="btn-secondary" disabled={Boolean(busyId) || Boolean(pending)} onClick={() => stageEnablement(p, false)}>
                          Disable
                        </button>
                      )}
                      {p.enablement !== 'default' && (
                        <button className="linkish" disabled={Boolean(busyId) || Boolean(pending)} onClick={() => stageEnablement(p, null)} title="Remove the explicit setting (native default)">
                          Reset
                        </button>
                      )}
                    </div>
                    {/* Update — a marketplace-scoped action; degrade to /plugin when the marketplace is unregistered (R: degrade, don't error). */}
                    {p.marketplaceRegistered ? (
                      <button
                        className="btn-secondary"
                        onClick={() => void onUpdate(p.id)}
                        disabled={!behind || isBusy || Boolean(busyId) || Boolean(pending)}
                        title={behind ? 'Update this plugin' : 'No update available'}
                      >
                        {isBusy ? 'Updating…' : 'Update'}
                      </button>
                    ) : (
                      <span
                        className="plugin-degraded"
                        style={{ fontSize: 12, color: 'var(--text-secondary)' }}
                        title="This plugin's marketplace is not registered with Kookr — manage updates from Claude Code's /plugin menu"
                      >
                        Open in <code>/plugin</code>
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Add a plugin for your own sessions (own-session install). */}
        {!loading && !loadError && (
          <div style={{ marginTop: 14, borderTop: '1px solid var(--border, #333)', paddingTop: 10 }}>
            {!showInstall ? (
              <button className="linkish" onClick={() => setShowInstall(true)}>
                + Add a plugin
              </button>
            ) : (
              <div className="plugin-install-form" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  aria-label="Plugin id"
                  placeholder="plugin id, e.g. stripe@anthropic-plugin-directory"
                  value={installId}
                  onChange={(e) => setInstallId(e.target.value)}
                />
                <input
                  aria-label="Marketplace source (optional)"
                  placeholder="marketplace source (optional), e.g. owner/repo"
                  value={installSource}
                  onChange={(e) => setInstallSource(e.target.value)}
                />
                <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={installEnable} onChange={(e) => setInstallEnable(e.target.checked)} />
                  Enable after installing
                </label>
                {installError && (
                  <div style={{ fontSize: 12, color: 'var(--red)' }} role="alert">
                    {installError}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn-secondary" disabled={Boolean(pending)} onClick={stageInstall}>
                    Install
                  </button>
                  <button className="linkish" onClick={() => { setShowInstall(false); setInstallError(null); }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
