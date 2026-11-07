import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  pluginNameFromId,
  pluginMarketplaceFromId,
  type ManagedPlugin,
  type PluginEnablement,
  type PluginStaleness,
} from '../../shared/contracts/plugins.js';
import { getPlugins, updatePlugin } from '../api/index.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';

interface PluginManagerDialogProps {
  isOpen: boolean;
  onClose: () => void;
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

/** Read-only fleet Plugin Manager (RFC Layer 1). Lists every installed plugin
 * with id, version, tri-state enablement, staleness-with-provenance, and token
 * cost; offers a per-plugin update. No per-skill toggles (R3a — not in P1). */
export function PluginManagerDialog({ isOpen, onClose }: PluginManagerDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEscapeToClose(onClose);
  useDialogFocus({ dialogRef, initialFocusRef: closeButtonRef });

  const [plugins, setPlugins] = useState<ManagedPlugin[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});

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

  useEffect(() => {
    void load();
  }, [load]);

  async function onUpdate(id: string) {
    if (updatingId) return;
    setUpdatingId(id);
    setRowError((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    try {
      const { ok, body } = await updatePlugin(id);
      if (ok && body && 'status' in body && body.status === 'updated') {
        setPlugins((prev) => (prev ? prev.map((p) => (p.id === id ? body.plugin : p)) : prev));
      } else {
        const err = body as { error?: string } | null;
        setRowError((prev) => ({ ...prev, [id]: err?.error ?? 'Update failed.' }));
      }
    } catch (err) {
      setRowError((prev) => ({ ...prev, [id]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setUpdatingId(null);
    }
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
          Every Claude Code plugin installed on this machine. Update the ones that are behind.
        </p>

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
            No plugins installed. Add one from Claude Code&rsquo;s <code>/plugin</code> menu.
          </p>
        )}

        {!loading && !loadError && plugins && plugins.length > 0 && (
          <ul className="plugin-manager-list" style={{ listStyle: 'none', padding: 0, margin: '12px 0 0' }}>
            {plugins.map((p) => {
              const name = pluginNameFromId(p.id);
              const marketplace = pluginMarketplaceFromId(p.id);
              const behind = p.staleness.state === 'behind';
              const isUpdating = updatingId === p.id;
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
                  <div style={{ flexShrink: 0 }}>
                    <button
                      className="btn-secondary"
                      onClick={() => void onUpdate(p.id)}
                      disabled={!behind || isUpdating || Boolean(updatingId)}
                      title={behind ? 'Update this plugin' : 'No update available'}
                    >
                      {isUpdating ? 'Updating…' : 'Update'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
