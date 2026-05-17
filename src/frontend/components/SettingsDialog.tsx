import React, { useState, useEffect, useRef, useCallback } from 'react';
import { buildAgentSelectionOptions, type AgentSelection } from '../../shared/protocol.js';
import { useSoundPreference } from '../audio/sound.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { useKookrStore } from '../store/useStore.js';
import { AgentTypeSelector } from './AgentTypeSelector.js';
import { HookInventorySection } from './HookInventorySection.js';
import type {
  RelayConnectionStatus,
  RelayConnectionStatusResponse,
} from '../../shared/contracts/relay-connection.js';

interface ServerSettings {
  githubPollingEnabled: boolean;
  githubPollingIntervalSec: number;
  autoWatchOssSources: boolean;
  watchdogStaleThresholdSec: number;
  repeatedErrorThreshold: number;
  maxActiveTasks: number;
  defaultAgentType: AgentSelection;
  loadedFromDefaults?: boolean;
}

/** Settings field to scroll-and-focus on open. */
export type SettingsFocusField = 'maxActiveTasks' | 'relayConnection';

interface Props {
  onClose: () => void;
  /**
   * If set, the matching input is scrolled into view and focused once
   * settings load. Lets callers deep-link straight to the relevant control
   * (e.g. right-click on the all-projects icon → max concurrent tasks).
   */
  focusField?: SettingsFocusField;
}

type SettingsTab = 'general' | 'sharing' | 'hooks';

const SETTINGS_TABS: readonly SettingsTab[] = ['general', 'sharing', 'hooks'];

// Which tab hosts each focusable field. Extend this when SettingsFocusField
// gains a new value — the Record type makes the requirement exhaustive.
const FOCUS_FIELD_TAB: Record<SettingsFocusField, SettingsTab> = {
  maxActiveTasks: 'general',
  relayConnection: 'sharing',
};

const SHARE_CSRF_HEADER = 'x-kookr-csrf';

function relayStateLabel(status: RelayConnectionStatus | null): string {
  switch (status?.connectionState) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'backingOff':
      return 'Reconnecting';
    case 'authFailed':
      return 'Authentication failed';
    case 'error':
      return 'Connection error';
    case 'stopped':
      return 'Disconnected';
    case 'configured':
      return 'Configured';
    case 'localOnly':
    default:
      return 'Local-only';
  }
}

function relaySourceLabel(status: RelayConnectionStatus | null): string | null {
  switch (status?.source) {
    case 'env':
      return 'Environment';
    case 'stored':
      return 'Saved in Settings';
    case 'hosted':
      return 'Hosted relay';
    case 'none':
    default:
      return null;
  }
}

function hostedRelayBadge(status: RelayConnectionStatus | null): string {
  const hosted = status?.hostedRelay;
  if (!hosted?.defaultEnabled) return 'Not enabled';
  if (!hosted.operationalGatesMet) return 'Setup incomplete';
  if (hosted.mode === 'maintenance') return 'Maintenance';
  if (hosted.mode === 'emergencyDisabled') return 'Temporarily disabled';
  return 'Ready';
}

function relaySetupActionLabel(kind: RelayConnectionStatus['setupDiagnosis']['recommendedAction']['kind']): string {
  switch (kind) {
    case 'restartKookr':
      return 'Restart Kookr';
    case 'restartRelay':
      return 'Restart relay';
    case 'repairRelayPairing':
      return 'Re-pair node';
    case 'fixEnv':
      return 'Fix env';
    case 'none':
      return 'Relay setup';
  }
}

function RelayConnectionSection() {
  const [status, setStatus] = useState<RelayConnectionStatus | null>(null);
  const [relayUrl, setRelayUrl] = useState('');
  const [nodeId, setNodeId] = useState('');
  const [relayToken, setRelayToken] = useState('');
  const [relayAdminToken, setRelayAdminToken] = useState('');
  const [accountToken, setAccountToken] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    const res = await fetch('/api/relay-connection');
    if (!res.ok) throw new Error(`relay-status-${res.status}`);
    const body = await res.json() as RelayConnectionStatusResponse;
    setStatus(body.status);
    if (body.status.relayUrl) setRelayUrl(body.status.relayUrl);
    if (body.status.nodeId) setNodeId(body.status.nodeId);
    if (body.status.displayName) setDisplayName(body.status.displayName);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      try {
        const tokenRes = await fetch('/api/share/csrf-token');
        if (!tokenRes.ok) throw new Error(`csrf-${tokenRes.status}`);
        const tokenBody = await tokenRes.json() as { csrfToken?: unknown };
        if (!cancelled && typeof tokenBody.csrfToken === 'string') setCsrfToken(tokenBody.csrfToken);
        await loadStatus();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Relay status unavailable');
      }
    }
    void boot();
    const timer = window.setInterval(() => {
      // Status polling is best-effort; keep the last visible state instead of
      // replacing an otherwise usable form with a transient refresh error.
      void loadStatus().catch(() => undefined);
    }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [loadStatus]);

  async function mutate(path: string, init: RequestInit): Promise<void> {
    if (!csrfToken) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        ...init,
        headers: {
          'content-type': 'application/json',
          [SHARE_CSRF_HEADER]: csrfToken,
          ...(init.headers ?? {}),
        },
      });
      const body = await res.json() as RelayConnectionStatusResponse | { error?: string };
      if (!res.ok || !('status' in body)) throw new Error('error' in body && body.error ? body.error : `HTTP ${res.status}`);
      setStatus(body.status);
      if (body.status.relayUrl) setRelayUrl(body.status.relayUrl);
      if (body.status.nodeId) setNodeId(body.status.nodeId);
      if (body.status.displayName) setDisplayName(body.status.displayName);
      setRelayToken('');
      setRelayAdminToken('');
      setAccountToken('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Relay update failed');
    } finally {
      setBusy(false);
    }
  }

  const envManaged = status?.source === 'env';
  const hostedReady = status?.hostedRelay?.configured && status.hostedRelay.mode === 'available';
  const hostedBlocked = status?.hostedRelay?.defaultEnabled && !hostedReady;
  const canConnect = Boolean(relayUrl.trim() && nodeId.trim() && relayToken.trim() && csrfToken && !busy);
  const canPair = Boolean(relayUrl.trim() && relayAdminToken.trim() && csrfToken && !busy);
  const canPairHosted = Boolean(hostedReady && accountToken.trim() && csrfToken && !busy);
  const canRotate = Boolean(status?.source === 'stored' && relayAdminToken.trim() && csrfToken && !busy);
  const sourceLabel = relaySourceLabel(status);

  return (
    <div className="settings-section">
      <div className="settings-section-title">Relay Connection</div>
      <div className="relay-status-strip">
        <div>
          <span className="settings-label">{relayStateLabel(status)}</span>
          <span className="settings-desc">
            {status?.relayUrl ?? 'No relay configured'}
            {sourceLabel ? ` · ${sourceLabel}` : ''}
          </span>
        </div>
        <span className={`relay-status-dot ${status?.relayConnected ? 'connected' : ''}`} aria-hidden="true" />
      </div>
      {status?.lastError && <div className="settings-error">{status.lastError.message}</div>}
      {status?.setupDiagnosis?.recommendedAction.kind !== 'none' && status?.setupDiagnosis && (
        <div className="settings-warning" role="status">
          <strong>{relaySetupActionLabel(status.setupDiagnosis.recommendedAction.kind)}</strong>
          <span>{status.setupDiagnosis.recommendedAction.reason}</span>
          <code>{status.setupDiagnosis.recommendedAction.command}</code>
        </div>
      )}
      {status?.setupDiagnosis?.requiresRelayRestart && (
        <div className="settings-warning" role="status">
          <strong>Relay restart required</strong>
          <span>{status.setupDiagnosis.envMessage}</span>
        </div>
      )}
      {error && <div className="settings-error">{error}</div>}

      {status?.hostedRelay?.defaultEnabled && (
        <div className="relay-status-strip">
          <div>
            <span className="settings-label">Hosted relay · {hostedRelayBadge(status)}</span>
            <span className="settings-desc">{status.hostedRelay.relayUrl} · {status.hostedRelay.message}</span>
          </div>
          <span className={`relay-status-dot ${hostedReady ? 'connected' : ''}`} aria-hidden="true" />
        </div>
      )}
      {hostedReady && !envManaged && (
        <>
          <label className="settings-field">
            <span className="settings-label">Account token</span>
            <input
              type="password"
              value={accountToken}
              onChange={(event) => setAccountToken(event.target.value)}
              placeholder="Hosted relay account token"
              disabled={busy}
            />
          </label>
          <div className="settings-action-row">
            <button
              type="button"
              className="btn-primary"
              onClick={() => mutate('/api/relay-connection/hosted/pair', {
                method: 'POST',
                body: JSON.stringify({
                  accountToken,
                  ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
                }),
              })}
              disabled={!canPairHosted}
            >
              Pair hosted relay
            </button>
          </div>
        </>
      )}
      {hostedBlocked && (
        <div className="settings-warning" role="status">
          Hosted sharing is not accepting new pairings or shares. Local Kookr remains available.
        </div>
      )}

      <label className="settings-field">
        <span className="settings-label">Relay URL</span>
        <input
          value={relayUrl}
          onChange={(event) => setRelayUrl(event.target.value)}
          placeholder="https://relay.example"
          disabled={envManaged || busy}
        />
      </label>
      <label className="settings-field">
        <span className="settings-label">Node ID</span>
        <input
          value={nodeId}
          onChange={(event) => setNodeId(event.target.value)}
          placeholder="kookr-node-..."
          disabled={envManaged || busy}
        />
      </label>
      <label className="settings-field">
        <span className="settings-label">Node token</span>
        <input
          type="password"
          value={relayToken}
          onChange={(event) => setRelayToken(event.target.value)}
          placeholder={envManaged ? 'Managed by environment' : 'Paste an issued node token'}
          disabled={envManaged || busy}
        />
      </label>
      <label className="settings-field">
        <span className="settings-label">Relay admin token</span>
        <input
          type="password"
          value={relayAdminToken}
          onChange={(event) => setRelayAdminToken(event.target.value)}
          placeholder={envManaged ? 'Managed by environment' : 'Required for pairing or rotation'}
          disabled={envManaged || busy}
        />
      </label>
      <label className="settings-field">
        <span className="settings-label">Display name</span>
        <input
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="This Kookr node"
          disabled={envManaged || busy}
        />
      </label>

      <div className="settings-action-row">
        <button
          type="button"
          className="btn-primary"
          onClick={() => mutate('/api/relay-connection/connect', {
            method: 'POST',
            body: JSON.stringify({
              relayUrl,
              nodeId,
              relayToken,
              ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
            }),
          })}
          disabled={!canConnect || envManaged}
        >
          Connect
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => mutate('/api/relay-connection/pair', {
            method: 'POST',
            body: JSON.stringify({
              relayUrl,
              relayAdminToken,
              ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
            }),
          })}
          disabled={!canPair || envManaged}
        >
          Pair
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => mutate('/api/relay-connection/rotate', {
            method: 'POST',
            body: JSON.stringify({ relayAdminToken }),
          })}
          disabled={!canRotate || envManaged}
        >
          Rotate token
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => mutate('/api/relay-connection/disconnect', { method: 'POST', body: '{}' })}
          disabled={busy || !status?.configured}
        >
          Disconnect
        </button>
        <button
          type="button"
          className="btn-secondary danger"
          onClick={() => mutate('/api/relay-connection/credentials', { method: 'DELETE', body: '{}' })}
          disabled={busy || !status?.configured || envManaged}
        >
          Forget
        </button>
      </div>
    </div>
  );
}

export function SettingsDialog({ onClose, focusField }: Props) {
  const availableAgentTypes = useKookrStore((s) => s.availableAgentTypes);
  const serverDefaultAgentType = useKookrStore((s) => s.defaultAgentType);
  const agentOptions = buildAgentSelectionOptions(availableAgentTypes);
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const sound = useSoundPreference();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tabRefs = useRef<Record<SettingsTab, HTMLButtonElement | null>>({
    general: null,
    sharing: null,
    hooks: null,
  });
  const maxActiveTasksInputRef = useRef<HTMLInputElement>(null);
  const didFocusRef = useRef(false);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data: ServerSettings) => {
        setSettings(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load settings');
        setLoading(false);
      });
  }, []);

  // Deep-link focus: when opened with a target field, switch to the right
  // tab, scroll the target input into view, focus it, and select its contents
  // so the user can type a new value immediately. Runs once per mount.
  // `focus({ preventScroll: true })` keeps the explicit scrollIntoView from
  // fighting the focus-implied scroll. `aria-label` on the input is set
  // statically below so SR announcement on focus reads "Max concurrent tasks".
  useEffect(() => {
    if (!focusField || !settings || didFocusRef.current) return;
    setActiveTab(FOCUS_FIELD_TAB[focusField]);
    const input = focusField === 'maxActiveTasks' ? maxActiveTasksInputRef.current : null;
    if (input) {
      input.scrollIntoView({ block: 'center' });
      input.focus({ preventScroll: true });
      input.select();
      didFocusRef.current = true;
    }
  }, [focusField, settings]);

  const saveSettings = useCallback(async (updated: ServerSettings) => {
    try {
      setError(null);
      setWarnings([]);
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const saved = await res.json() as ServerSettings & { warnings?: string[] };
      if (saved.warnings && saved.warnings.length > 0) {
        setWarnings(saved.warnings);
      }
      setSettings(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    }
  }, []);

  function handleToggle(field: keyof ServerSettings) {
    if (!settings) return;
    const updated = { ...settings, [field]: !settings[field] };
    setSettings(updated);
    void saveSettings(updated);
  }

  function handleNumberChange(field: keyof ServerSettings, value: string, min: number, max: number) {
    if (!settings) return;
    const val = parseInt(value, 10);
    if (isNaN(val)) return;
    const clamped = Math.max(min, Math.min(max, val));
    const updated = { ...settings, [field]: clamped };
    setSettings(updated);

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void saveSettings(updated);
    }, 500);
  }

  function handleDefaultAgentChange(agentType: AgentSelection) {
    if (!settings) return;
    const updated = { ...settings, defaultAgentType: agentType };
    setSettings(updated);
    void saveSettings(updated);
  }

  function handleSoundToggle() {
    sound.setEnabled(!sound.enabled);
  }

  function handleTabKeyDown(tab: SettingsTab, event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();

    const currentIndex = SETTINGS_TABS.indexOf(tab);
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const nextTab = SETTINGS_TABS[(currentIndex + delta + SETTINGS_TABS.length) % SETTINGS_TABS.length];
    setActiveTab(nextTab);
    tabRefs.current[nextTab]?.focus();
  }

  useEscapeToClose(onClose);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h3>Settings</h3>
          <button className="dialog-close" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div className="dialog-tabs settings-dialog-tabs" role="tablist" aria-label="Settings sections">
          {SETTINGS_TABS.map((tab) => {
            const isActive = activeTab === tab;
            const label = tab === 'general' ? 'General' : tab === 'sharing' ? 'Sharing' : 'Hooks';
            return (
              <button
                key={tab}
                ref={(node) => {
                  tabRefs.current[tab] = node;
                }}
                type="button"
                role="tab"
                id={`settings-tab-${tab}`}
                aria-selected={isActive}
                aria-controls={`settings-panel-${tab}`}
                tabIndex={isActive ? 0 : -1}
                className={`dialog-tab ${isActive ? 'active' : ''}`}
                onClick={() => setActiveTab(tab)}
                onKeyDown={(event) => handleTabKeyDown(tab, event)}
              >
                {label}
              </button>
            );
          })}
        </div>

        <div className="settings-dialog-body">
          {loading && <div className="settings-loading">Loading...</div>}
          {error && <div className="settings-error">{error}</div>}
          {warnings.length > 0 && (
            <div className="settings-warning">
              {warnings.map((w, i) => <div key={i}>{w}</div>)}
            </div>
          )}
          {settings?.loadedFromDefaults && (
            <div className="settings-warning">
              Settings loaded from defaults — your settings.json may be missing or corrupt.
            </div>
          )}

          {activeTab === 'general' && (
            <div role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general">
              {settings && (
                <>
                  {/* Notifications & Alerts */}
                  <div className="settings-section">
                    <div className="settings-section-title">Notifications & Alerts</div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Sound alerts</span>
                        <span className="settings-desc">
                          Play an audible chime when a new critical or warning finding is detected.
                          Useful for getting notified without constantly watching the dashboard.
                        </span>
                      </div>
                      <button
                        className={`settings-toggle ${sound.enabled ? 'active' : ''}`}
                        onClick={handleSoundToggle}
                        aria-label="Toggle sound alerts"
                      >
                        <span className="settings-toggle-knob" />
                      </button>
                    </div>
                  </div>

                  {/* Detection Sensitivity */}
                  <div className="settings-section">
                    <div className="settings-section-title">Detection Sensitivity</div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Stale agent timeout</span>
                        <span className="settings-desc">
                          Seconds of inactivity before an agent is flagged as stale (stuck or unresponsive).
                          Increase this if agents doing long builds or large file operations are being
                          incorrectly flagged. Range: 15–90 seconds.
                        </span>
                        {(settings.watchdogStaleThresholdSec > 60) && (
                          <span className="settings-hint">
                            High thresholds reduce sensitivity to stuck agents and disconnected hooks.
                          </span>
                        )}
                      </div>
                      <div className="settings-number-group">
                        <input
                          type="number"
                          className="settings-number"
                          value={settings.watchdogStaleThresholdSec}
                          onChange={(e) => handleNumberChange('watchdogStaleThresholdSec', e.target.value, 15, 90)}
                          min={15}
                          max={90}
                          step={5}
                        />
                        <span className="settings-unit">sec</span>
                      </div>
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Repeated error threshold</span>
                        <span className="settings-desc">
                          Number of identical consecutive errors an agent must produce before triggering
                          a repeated-error anomaly. Lower values catch errors sooner but may produce
                          false positives with noisy tools. Range: 2–10.
                        </span>
                      </div>
                      <div className="settings-number-group">
                        <input
                          type="number"
                          className="settings-number"
                          value={settings.repeatedErrorThreshold}
                          onChange={(e) => handleNumberChange('repeatedErrorThreshold', e.target.value, 2, 10)}
                          min={2}
                          max={10}
                          step={1}
                        />
                        <span className="settings-unit">errors</span>
                      </div>
                    </div>
                  </div>

                  {/* Task Management */}
                  <div className="settings-section">
                    <div className="settings-section-title">Task Management</div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Default agent</span>
                        <span className="settings-desc">
                          Pre-selected agent for new tasks and child task launches when no explicit
                          agent is supplied. Round robin alternates between Claude Code and Codex CLI
                          on each launch to spread usage across both plans.
                        </span>
                      </div>
                      <div className="settings-agent-select">
                        <AgentTypeSelector
                          value={settings.defaultAgentType ?? serverDefaultAgentType}
                          onChange={handleDefaultAgentChange}
                          options={agentOptions}
                          label="Agent"
                          compact
                        />
                      </div>
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Max concurrent tasks</span>
                        <span className="settings-desc">
                          Maximum number of tasks that can run at the same time. Additional tasks
                          are queued and launched automatically when a slot opens. Increase on powerful
                          machines with high API quotas, decrease to conserve resources. Range: 1–25.
                        </span>
                      </div>
                      <div className="settings-number-group">
                        <input
                          ref={maxActiveTasksInputRef}
                          aria-label="Max concurrent tasks"
                          type="number"
                          className="settings-number"
                          value={settings.maxActiveTasks}
                          onChange={(e) => handleNumberChange('maxActiveTasks', e.target.value, 1, 25)}
                          min={1}
                          max={25}
                          step={1}
                        />
                      </div>
                    </div>
                  </div>

                  {/* GitHub Polling */}
                  <div className="settings-section">
                    <div className="settings-section-title">GitHub Polling</div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Enable polling</span>
                        <span className="settings-desc">
                          Periodically fetch PR status, CI checks, and review threads for tasks
                          that reference GitHub issues or pull requests. Uses the gh CLI under the hood.
                        </span>
                      </div>
                      <button
                        className={`settings-toggle ${settings.githubPollingEnabled ? 'active' : ''}`}
                        onClick={() => handleToggle('githubPollingEnabled')}
                        aria-label="Toggle GitHub polling"
                      >
                        <span className="settings-toggle-knob" />
                      </button>
                    </div>
                    <div className={`settings-row ${!settings.githubPollingEnabled ? 'disabled' : ''}`}>
                      <div className="settings-row-info">
                        <span className="settings-label">Polling interval</span>
                        <span className="settings-desc">
                          How often to fetch updated GitHub data. Lower values give faster updates
                          but increase API usage. Range: 15–600 seconds.
                        </span>
                      </div>
                      <div className="settings-number-group">
                        <input
                          type="number"
                          className="settings-number"
                          value={settings.githubPollingIntervalSec}
                          onChange={(e) => handleNumberChange('githubPollingIntervalSec', e.target.value, 15, 600)}
                          min={15}
                          max={600}
                          step={5}
                          disabled={!settings.githubPollingEnabled}
                        />
                        <span className="settings-unit">sec</span>
                      </div>
                    </div>
                  </div>

                  <div className="settings-section">
                    <div className="settings-section-title">OSS Sources</div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Auto-watch local sources</span>
                        <span className="settings-desc">
                          Watch OSS registry and recon report files for local edits, then update the
                          sidebar and OSS panel without running GitHub refresh calls.
                        </span>
                      </div>
                      <button
                        className={`settings-toggle ${settings.autoWatchOssSources ? 'active' : ''}`}
                        onClick={() => handleToggle('autoWatchOssSources')}
                        aria-label="Toggle OSS source auto-watch"
                      >
                        <span className="settings-toggle-knob" />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === 'hooks' && (
            <div role="tabpanel" id="settings-panel-hooks" aria-labelledby="settings-tab-hooks">
              <HookInventorySection />
            </div>
          )}

          {activeTab === 'sharing' && (
            <div role="tabpanel" id="settings-panel-sharing" aria-labelledby="settings-tab-sharing">
              <RelayConnectionSection />
            </div>
          )}
        </div>

        <div className="dialog-actions">
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
