import React, { useEffect, useRef, useState } from 'react';
import {
  TOOLKIT_MARKETPLACE_SLUG,
  pluginInstallCommands,
  type PluginUpdateError,
  type PluginVersionStatus,
} from '../../shared/contracts/plugin-version.js';
import { getDeployStatus, installToolkitPlugin } from '../api/index.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';

export const PLUGIN_INSTALL_DISMISS_KEY = 'kookr-plugin-install-banner-dismissed';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(PLUGIN_INSTALL_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

interface PluginInstallConfirmDialogProps {
  plugin: PluginVersionStatus;
  installing: boolean;
  error: string | null;
  errorCommands: { slash: string[]; cli: string[] } | null;
  commands: { slash: string[]; cli: string[] };
  onClose: () => void;
  onConfirm: () => void;
}

/**
 * Confirm surface for guided plugin install. Mounted only while open so the
 * Tab trap and Escape-to-close attach for the dialog lifetime only — same
 * pattern as ConfirmDialog / SweepConfirmDialog.
 */
function PluginInstallConfirmDialog({
  plugin,
  installing,
  error,
  errorCommands,
  commands,
  onClose,
  onConfirm,
}: PluginInstallConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  useEscapeToClose(onClose);
  useDialogFocus({ dialogRef, initialFocusRef: cancelButtonRef });

  return (
    <div
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-install-dialog-title"
        // Focusable container so the Tab trap still has a target when all
        // action buttons are disabled during install (useDialogFocus falls
        // back to the dialog element when FOCUSABLE_SELECTOR matches none).
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <h3 id="plugin-install-dialog-title">Install kookr-toolkit plugin?</h3>
          <button
            className="dialog-close"
            onClick={onClose}
            disabled={installing}
            aria-label="Close install dialog"
          >
            &times;
          </button>
        </div>

        <p style={{ marginTop: 12, color: 'var(--text-secondary)', fontSize: 13 }}>
          This will modify your Claude Code configuration:
        </p>
        <ul className="toolkit-does">
          <li>Add marketplace <code>{TOOLKIT_MARKETPLACE_SLUG}</code></li>
          <li>Install <code>{plugin.pluginId}</code>{plugin.availableVersion ? ` (v${plugin.availableVersion})` : ''}</li>
        </ul>

        <div className="toolkit-safety">
          <span>🛡</span>
          <span>
            Safe by default. Kookr snapshots <code>~/.claude/plugins</code> before installing
            and rolls it back automatically if the install fails.
          </span>
        </div>

        {error && (
          <div style={{ marginTop: 12, color: 'var(--red)', fontSize: 12 }}>
            <strong>Install failed:</strong> {error}
            {(errorCommands ?? commands) && (
              <div style={{ marginTop: 8 }}>
                <span style={{ color: 'var(--text-secondary)' }}>Run manually in Claude Code:</span>
                <ul className="toolkit-does" style={{ marginTop: 4 }}>
                  {(errorCommands?.slash ?? commands.slash).map((cmd) => (
                    <li key={cmd}><code>{cmd}</code></li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="dialog-actions">
          <button
            ref={cancelButtonRef}
            className="btn-secondary"
            onClick={onClose}
            disabled={installing}
          >
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={onConfirm}
            disabled={installing}
          >
            {installing ? 'Installing…' : 'Back up & install'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One-time, dismissible nudge shown only when the kookr-toolkit marketplace
 * plugin is *not installed at all*. The top-left version badge already pulses
 * for this (and for the "update available" case) via the deploy-status `plugin`
 * field, but a first-time user shouldn't have to notice that dot — this louder
 * banner spells out the install commands. Dismissal is permanent; the badge
 * remains the persistent reminder. Fetches deploy status once on mount, so it
 * stays silent when the dashboard backend is unreachable or the plugin is
 * already installed (stale installs are nudged in the badge popover, not here).
 *
 * Variant B — "Guided + safety callout": the banner shows an "Install toolkit"
 * button that opens a confirmation dialog with a backup/rollback safety note,
 * plus a "Show manual commands" toggle for power users.
 */
export function PluginInstallBanner() {
  const [plugin, setPlugin] = useState<PluginVersionStatus | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(readDismissed);
  const [showDialog, setShowDialog] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCommands, setErrorCommands] = useState<{ slash: string[]; cli: string[] } | null>(null);

  useEffect(() => {
    if (dismissed) return;
    let cancelled = false;
    (async () => {
      try {
        const { ok, body } = await getDeployStatus();
        if (!ok) return;
        if (!cancelled && body.plugin) setPlugin(body.plugin);
      } catch {
        // Dashboard backend unreachable — nothing to nudge.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dismissed]);

  const notInstalled = Boolean(
    plugin && plugin.installedVersion === null && plugin.availableVersion !== null,
  );
  if (dismissed || !notInstalled || !plugin) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(PLUGIN_INSTALL_DISMISS_KEY, '1');
    } catch {
      // Storage unavailable (private mode) — dismiss for this session only.
    }
    setDismissed(true);
  }

  function openDialog() {
    setError(null);
    setErrorCommands(null);
    setShowDialog(true);
  }

  function closeDialog() {
    if (installing) return;
    setShowDialog(false);
  }

  async function confirmInstall() {
    if (installing || !plugin) return;
    setError(null);
    setErrorCommands(null);
    setInstalling(true);
    try {
      const { ok, body } = await installToolkitPlugin();
      if (ok && body && 'status' in body && body.status === 'installed') {
        // Plugin is now installed — update local state; banner will hide.
        setPlugin(body.plugin);
        setShowDialog(false);
      } else {
        const errData = body as PluginUpdateError | null;
        setError(errData?.error ?? 'Install failed. Check server logs.');
        if (errData?.commands) setErrorCommands(errData.commands);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  }

  const commands = pluginInstallCommands(plugin.pluginId, TOOLKIT_MARKETPLACE_SLUG);

  return (
    <div className="plugin-install-banner">
      <div className="toast toast-info" role="status" aria-live="polite" aria-atomic="true">
        <span className="toast-message">
          <span>Toolkit plugin not installed — its skills &amp; review agents won&rsquo;t load in sessions you start yourself.</span>
          <span className="toast-details">
            <button
              className="btn-install"
              onClick={openDialog}
              aria-label="Install toolkit plugin"
            >
              Install toolkit
            </button>
            {' '}
            <button
              className="linkish"
              onClick={() => setShowManual((v) => !v)}
              aria-expanded={showManual}
            >
              {showManual ? 'Hide manual commands' : 'Show manual commands'}
            </button>
            {showManual && (
              <span className="toolkit-does">
                <span><code>/plugin marketplace add {TOOLKIT_MARKETPLACE_SLUG}</code></span>
                <span><code>/plugin install {plugin.pluginId}</code></span>
              </span>
            )}
          </span>
        </span>
        <button className="toast-dismiss" onClick={dismiss} aria-label="Dismiss plugin install notice">
          &times;
        </button>
      </div>

      {showDialog && (
        <PluginInstallConfirmDialog
          plugin={plugin}
          installing={installing}
          error={error}
          errorCommands={errorCommands}
          commands={commands}
          onClose={closeDialog}
          onConfirm={confirmInstall}
        />
      )}
    </div>
  );
}
