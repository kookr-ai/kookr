import React, { useEffect, useState } from 'react';
import { TOOLKIT_MARKETPLACE_SLUG, type PluginVersionStatus } from '../../shared/contracts/plugin-version.js';

export const PLUGIN_INSTALL_DISMISS_KEY = 'kookr-plugin-install-banner-dismissed';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(PLUGIN_INSTALL_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
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
 */
export function PluginInstallBanner() {
  const [plugin, setPlugin] = useState<PluginVersionStatus | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(readDismissed);

  useEffect(() => {
    if (dismissed) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/deploy/status');
        if (!res.ok) return;
        const data = (await res.json()) as { plugin?: PluginVersionStatus };
        if (!cancelled && data.plugin) setPlugin(data.plugin);
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

  return (
    <div className="plugin-install-banner">
      <div className="toast toast-info" role="status" aria-live="polite" aria-atomic="true">
        <span className="toast-message">
          <span>Toolkit plugin not installed — its skills &amp; review agents won&rsquo;t load in sessions you start yourself.</span>
          <span className="toast-details">
            In Claude Code, run <code>/plugin marketplace add {TOOLKIT_MARKETPLACE_SLUG}</code> then{' '}
            <code>/plugin install {plugin.pluginId}</code>.
          </span>
        </span>
        <button className="toast-dismiss" onClick={dismiss} aria-label="Dismiss plugin install notice">
          &times;
        </button>
      </div>
    </div>
  );
}
