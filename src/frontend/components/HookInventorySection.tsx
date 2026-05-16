import React from 'react';
import { HOOK_EVENTS, LOAD_BEARING_HOOKS, HOOK_DESCRIPTIONS } from '../../shared/contracts/hook-spec.js';

/**
 * Read-only list of hooks Kookr injects into every agent it launches.
 * Used inside SettingsDialog.
 */
export function HookInventorySection(): React.ReactElement {
  return (
    <div className="settings-section">
      <div className="settings-section-title">Hooks (read-only)</div>
      <div className="settings-desc" style={{ marginBottom: '0.75rem' }}>
        Kookr injects these hooks into every agent it launches. They feed the
        supervisor's anomaly detection.
      </div>
      <ul className="hook-inventory-list">
        {HOOK_EVENTS.map((event) => {
          const loadBearing = LOAD_BEARING_HOOKS.has(event);
          return (
            <li key={event} className="hook-inventory-row">
              <span className="hook-inventory-event">
                {loadBearing && (
                  <span className="hook-inventory-lock" aria-hidden="true">
                    {'\u{1F512}'}
                  </span>
                )}
                <code>{event}</code>
                <span className={`hook-inventory-tag ${loadBearing ? 'required' : 'optional'}`}>
                  {loadBearing ? 'required' : 'non-critical'}
                </span>
              </span>
              <span className="hook-inventory-desc">{HOOK_DESCRIPTIONS[event]}</span>
            </li>
          );
        })}
      </ul>
      <div className="settings-desc" style={{ marginTop: '0.5rem' }}>
        Need per-session hook-injection details? Open a task and click
        "Hook settings" in the detail panel.
      </div>
      <div className="settings-desc" style={{ marginTop: '0.25rem' }}>
        Want to add your own hooks? Edit <code>~/.claude/settings.json</code>.
        Those hooks fire on every Claude Code invocation on this machine,
        not only under Kookr. Kookr-scoped user hooks are not yet
        supported — see issue #402.
      </div>
    </div>
  );
}
