import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  buildAgentSelectionOptions,
  AVAILABLE_AGENT_TYPES,
  effortLevelsForAgent,
  type AgentSelection,
  type AgentType,
  type AgentEffortMap,
} from '../../shared/protocol.js';
import {
  SHORTCUT_ACTIONS,
  detectShortcutPlatform,
  findShortcutConflicts,
  formatShortcutBinding,
  getDefaultShortcutBindings,
  resolveShortcutBindings,
  type PlatformShortcutBindingOverrides,
  type ShortcutActionId,
} from '../../shared/contracts/shortcut-bindings.js';
import type { VerbosityScale } from '../../shared/contracts/speech.js';
import type { QuietHoursWindow } from '../../shared/contracts/quiet-hours.js';
import { MAX_REPLY_SNIPPETS, type ReplySnippet } from '../../shared/contracts/reply-snippets.js';
import { useSoundPreference } from '../audio/sound.js';
import { setQuietHoursWindows } from '../hooks/useDnd.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { useKookrStore } from '../store/useStore.js';
import { AgentTypeSelector } from './AgentTypeSelector.js';
import { HookInventorySection } from './HookInventorySection.js';
import type {
  RelayConnectionStatus,
  RelayConnectionStatusResponse,
} from '../../shared/contracts/relay-connection.js';
import type {
  SessionSharingRecoveryAction,
  SessionSharingRecoveryActionResponse,
} from '../../shared/contracts/session-sharing-recovery.js';

interface ServerSettings {
  githubPollingEnabled: boolean;
  githubPollingIntervalSec: number;
  autoWatchOssSources: boolean;
  watchdogStaleThresholdSec: number;
  repeatedErrorThreshold: number;
  maxActiveTasks: number;
  defaultAgentType: AgentSelection;
  agentEffort?: AgentEffortMap;
  shortcutBindings: PlatformShortcutBindingOverrides;
  speakVerbosity?: VerbosityScale;
  quietHours?: QuietHoursWindow[];
  replySnippets?: ReplySnippet[];
  loadedFromDefaults?: boolean;
  warnings?: string[];
}

/** Sunday-first weekday labels for the quiet-hours day toggles (index = getDay()). */
const WEEKDAY_LABELS: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DEFAULT_QUIET_HOURS_WINDOW: QuietHoursWindow = { start: '22:00', end: '08:00' };

interface VerbosityChoice {
  value: VerbosityScale;
  label: string;
  description: string;
  /** Approximate spoken duration, shown inline so the hint isn't hover-gated. */
  lengthHint: string;
}

const VERBOSITY_CHOICES: readonly VerbosityChoice[] = [
  { value: 'terse', label: 'Headline', description: 'At-a-glance announcement', lengthHint: '(~2–3s spoken)' },
  { value: 'brief', label: 'Brief', description: 'One-line subject + context', lengthHint: '(~3–5s spoken)' },
  { value: 'medium', label: 'Standard', description: 'Default', lengthHint: '(~6–10s spoken)' },
  { value: 'detailed', label: 'Detailed', description: 'Full picture, ~8–10 spoken lines', lengthHint: '(~15–25s spoken)' },
];

/** Settings field to scroll-and-focus on open. */
export type SettingsFocusField = 'maxActiveTasks' | 'relayConnection';

interface Props {
  onClose: () => void;
  onSettingsSaved?: (settings: ServerSettings) => void;
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
const SHORTCUT_PLATFORM = detectShortcutPlatform();
const SHORTCUT_DEFAULTS = getDefaultShortcutBindings(SHORTCUT_PLATFORM);

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
      return 'Reconnect node';
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
  const [recoveryResult, setRecoveryResult] = useState<string | null>(null);

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
      setRecoveryResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Relay update failed');
    } finally {
      setBusy(false);
    }
  }

  async function runRecovery(
    action: SessionSharingRecoveryAction,
    body: Record<string, unknown> = {},
    confirmText?: string,
  ): Promise<void> {
    if (!csrfToken) return;
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    setRecoveryResult(null);
    try {
      const res = await fetch(`/api/session-sharing/recovery/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SHARE_CSRF_HEADER]: csrfToken,
        },
        body: JSON.stringify(body),
      });
      const payload = await res.json() as SessionSharingRecoveryActionResponse | { error?: string };
      if (!res.ok || !('result' in payload)) throw new Error('error' in payload && payload.error ? payload.error : `HTTP ${res.status}`);
      if (payload.result.state === 'failed' || payload.result.state === 'partial') {
        throw new Error(`${payload.result.message} ${payload.result.verification}`);
      }
      setRecoveryResult(`${payload.result.message} ${payload.result.verification}`);
      await loadStatus().catch(() => undefined);
      if (action === 'rotateNodeCredential' || action === 'repairRelayPairing') setRelayAdminToken('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Recovery action failed');
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
      {error && <div className="settings-error" role="alert">{error}</div>}
      {recoveryResult && <div className="settings-warning" role="status">{recoveryResult}</div>}

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
      <p className="settings-desc">
        Use Pair with a relay admin token to create this node ID and token. Use Connect only when you already have both.
      </p>

      <div className="settings-section-title">Session Sharing Recovery</div>
      <div className="settings-warning">
        <strong>Recovery controls</strong>
        <span>These actions affect active browser collaborators, node credentials, or local relay state. Destructive actions require confirmation and write an audit record.</span>
      </div>
      <div className="settings-action-row">
        <button
          type="button"
          className="btn-secondary danger"
          onClick={() => runRecovery(
            'revokeAllShares',
            { confirmation: 'revoke all shares' },
            'Revoke every active task share owned by this node?',
          )}
          disabled={busy || !status?.configured}
        >
          Revoke all shares
        </button>
        <button
          type="button"
          className="btn-secondary danger"
          onClick={() => runRecovery(
            'disableTerminalSharing',
            { confirmation: 'disable terminal sharing' },
            'Disable terminal sharing in .env and disconnect the current relay runtime?',
          )}
          disabled={busy}
        >
          Disable terminal sharing
        </button>
        <button
          type="button"
          className="btn-secondary danger"
          onClick={() => runRecovery(
            'rotateNodeCredential',
            { confirmation: 'rotate node credential', relayAdminToken },
            'Rotate this node credential and invalidate the current token?',
          )}
          disabled={!canRotate || envManaged}
        >
          Rotate credential
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => runRecovery('repairRelayPairing', {
            relayUrl,
            relayAdminToken,
            ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
          })}
          disabled={!canPair || envManaged}
        >
          Reconnect node
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => runRecovery('openRelayLogs')}
          disabled={busy}
        >
          Relay logs
        </button>
        <button
          type="button"
          className="btn-secondary danger"
          onClick={() => runRecovery(
            'resetRelayState',
            { confirmation: 'reset local relay state' },
            'Stop the owned local relay, back up SQLite state, and reset local relay state?',
          )}
          disabled={busy}
        >
          Reset relay state
        </button>
      </div>
    </div>
  );
}

export function SettingsDialog({ onClose, focusField, onSettingsSaved }: Props) {
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Record<SettingsTab, HTMLButtonElement | null>>({
    general: null,
    sharing: null,
    hooks: null,
  });
  const maxActiveTasksInputRef = useRef<HTMLInputElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const didFocusRef = useRef(false);
  const saveQueueRef = useRef(Promise.resolve());
  const latestSaveIdRef = useRef(0);
  const latestSettingsRef = useRef<ServerSettings | null>(null);

  useDialogFocus({ dialogRef, initialFocusRef: closeButtonRef });

  useEffect(() => {
    latestSettingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data: ServerSettings) => {
        setSettings(data);
        setWarnings(data.warnings ?? []);
        // Mirror the saved schedule into the live DND gate so quiet hours take
        // effect immediately, even before the operator edits anything.
        setQuietHoursWindows(data.quietHours ?? []);
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

  const saveSettings = useCallback((updated: ServerSettings) => {
    const saveId = ++latestSaveIdRef.current;
    setError(null);
    setWarnings([]);

    const run = async () => {
      try {
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
        if (saveId !== latestSaveIdRef.current) return;
        setWarnings(saved.warnings ?? []);
        setSettings(saved);
        window.dispatchEvent(new CustomEvent('kookr:settings-updated', { detail: saved }));
        // Re-mirror the server-normalized windows (invalid ones dropped) so the
        // live gate matches exactly what was persisted.
        setQuietHoursWindows(saved.quietHours ?? []);
        onSettingsSaved?.(saved);
      } catch (err) {
        if (saveId === latestSaveIdRef.current) {
          setError(err instanceof Error ? err.message : 'Failed to save settings');
        }
      }
    };

    const queued = saveQueueRef.current.catch(() => undefined).then(run);
    saveQueueRef.current = queued.catch(() => undefined);
    return queued;
  }, [onSettingsSaved]);

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
      void saveSettings(latestSettingsRef.current ?? updated);
    }, 500);
  }

  function handleDefaultAgentChange(agentType: AgentSelection) {
    if (!settings) return;
    const updated = { ...settings, defaultAgentType: agentType };
    setSettings(updated);
    void saveSettings(updated);
  }

  // #681: set or clear a per-agent-type reasoning-effort default. An empty
  // value removes the entry, restoring the agent CLI's own default (no flag
  // passed at launch). Invalid (agent, level) pairs are dropped server-side.
  function handleAgentEffortChange(agent: AgentType, level: string) {
    if (!settings) return;
    const nextEffort: AgentEffortMap = { ...(settings.agentEffort ?? {}) };
    if (level === '') {
      delete nextEffort[agent];
    } else {
      nextEffort[agent] = level as AgentEffortMap[AgentType];
    }
    const updated = { ...settings, agentEffort: nextEffort };
    setSettings(updated);
    void saveSettings(updated);
  }

  function handleSpeakVerbosityChange(value: VerbosityScale) {
    if (!settings) return;
    const updated = { ...settings, speakVerbosity: value };
    setSettings(updated);
    void saveSettings(updated);
  }

  function commitReplySnippets(snippets: ReplySnippet[]) {
    if (!settings) return;
    const updated = { ...settings, replySnippets: snippets.slice(0, MAX_REPLY_SNIPPETS) };
    setSettings(updated);
    void saveSettings(updated);
  }

  function addReplySnippet() {
    if (!settings) return;
    const snippets = settings.replySnippets ?? [];
    if (snippets.length >= MAX_REPLY_SNIPPETS) return;
    commitReplySnippets([...snippets, { label: 'New reply', text: 'continue' }]);
  }

  function updateReplySnippetDraft(index: number, field: keyof ReplySnippet, value: string) {
    if (!settings) return;
    const snippets = (settings.replySnippets ?? []).map((snippet, i) =>
      i === index ? { ...snippet, [field]: value } : snippet,
    );
    setSettings({ ...settings, replySnippets: snippets });
  }

  function saveReplySnippets() {
    if (!settings) return;
    void saveSettings(settings);
  }

  function removeReplySnippet(index: number) {
    if (!settings) return;
    commitReplySnippets((settings.replySnippets ?? []).filter((_, i) => i !== index));
  }

  function commitQuietHours(windows: QuietHoursWindow[]) {
    if (!settings) return;
    const updated = { ...settings, quietHours: windows };
    setSettings(updated);
    // Optimistically mirror to the live gate; saveSettings re-mirrors the
    // server-normalized result once the PUT resolves.
    setQuietHoursWindows(windows);
    void saveSettings(updated);
  }

  function addQuietHoursWindow() {
    if (!settings) return;
    commitQuietHours([...(settings.quietHours ?? []), { ...DEFAULT_QUIET_HOURS_WINDOW }]);
  }

  function removeQuietHoursWindow(index: number) {
    if (!settings) return;
    commitQuietHours((settings.quietHours ?? []).filter((_, i) => i !== index));
  }

  function updateQuietHoursTime(index: number, field: 'start' | 'end', value: string) {
    if (!settings || !value) return;
    const windows = (settings.quietHours ?? []).map((window, i) =>
      i === index ? { ...window, [field]: value } : window,
    );
    commitQuietHours(windows);
  }

  function toggleQuietHoursDay(index: number, day: number) {
    if (!settings) return;
    const windows = (settings.quietHours ?? []).map((window, i) => {
      if (i !== index) return window;
      // Undefined days means "every day" — expand to all 7 so a toggle removes
      // exactly the clicked day rather than collapsing the selection.
      const current = window.days ?? [0, 1, 2, 3, 4, 5, 6];
      const nextDays = current.includes(day)
        ? current.filter((d) => d !== day)
        : [...current, day].sort((a, b) => a - b);
      // Keep at least one day — a window with no days would silence nothing.
      if (nextDays.length === 0) return window;
      // All seven selected is the canonical "every day" — drop the key.
      if (nextDays.length === 7) {
        const { days: _omit, ...rest } = window;
        return rest;
      }
      return { ...window, days: nextDays };
    });
    commitQuietHours(windows);
  }

  function handleSoundToggle() {
    sound.setEnabled(!sound.enabled);
  }

  function updateShortcutOverride(actionId: ShortcutActionId, value: string) {
    if (!settings) return;
    const platformOverrides = { ...(settings.shortcutBindings?.[SHORTCUT_PLATFORM] ?? {}) };
    if (value.trim() === '') {
      delete platformOverrides[actionId];
    } else {
      platformOverrides[actionId] = value.trim();
    }
    const updated = {
      ...settings,
      shortcutBindings: {
        ...(settings.shortcutBindings ?? {}),
        [SHORTCUT_PLATFORM]: platformOverrides,
      },
    };
    setSettings(updated);
  }

  function saveShortcutOverrides() {
    if (!settings) return;
    void saveSettings(settings);
  }

  function resetShortcut(actionId: ShortcutActionId) {
    if (!settings) return;
    const platformOverrides = { ...(settings.shortcutBindings?.[SHORTCUT_PLATFORM] ?? {}) };
    delete platformOverrides[actionId];
    const updated = {
      ...settings,
      shortcutBindings: {
        ...(settings.shortcutBindings ?? {}),
        [SHORTCUT_PLATFORM]: platformOverrides,
      },
    };
    setSettings(updated);
    void saveSettings(updated);
  }

  function resetAllShortcuts() {
    if (!settings) return;
    const updated = {
      ...settings,
      shortcutBindings: {
        ...(settings.shortcutBindings ?? {}),
        [SHORTCUT_PLATFORM]: {},
      },
    };
    setSettings(updated);
    void saveSettings(updated);
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
  const shortcutOverrides = settings?.shortcutBindings?.[SHORTCUT_PLATFORM] ?? {};
  const resolvedShortcuts = settings
    ? resolveShortcutBindings(SHORTCUT_PLATFORM, settings.shortcutBindings)
    : SHORTCUT_DEFAULTS;
  const shortcutConflicts = findShortcutConflicts(resolvedShortcuts);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <h3 id="settings-dialog-title">Settings</h3>
          <button ref={closeButtonRef} className="dialog-close" onClick={onClose} aria-label="Close">&times;</button>
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
                    <div className="settings-row settings-row-fieldset">
                      <fieldset className="settings-radio-group">
                        <legend className="settings-label">Spoken summary length</legend>
                        <span className="settings-desc">
                          Controls how much detail Kookr speaks when you press the per-agent speak
                          button (or {formatShortcutBinding(resolvedShortcuts.speak_agent)}).
                          This applies to every press until you change it here.
                        </span>
                        {VERBOSITY_CHOICES.map((choice) => (
                          <label key={choice.value} className="settings-radio-option">
                            <input
                              type="radio"
                              name="speakVerbosity"
                              value={choice.value}
                              checked={(settings.speakVerbosity ?? 'medium') === choice.value}
                              onChange={() => handleSpeakVerbosityChange(choice.value)}
                            />
                            <span className="settings-radio-label">{choice.label}</span>
                            <span className="settings-radio-desc">
                              {choice.description} <span className="settings-radio-meta">{choice.lengthHint}</span>
                            </span>
                          </label>
                        ))}
                      </fieldset>
                    </div>
                    <div className="settings-row settings-row-fieldset">
                      <div className="settings-quiet-hours">
                        <span className="settings-label">Quiet hours</span>
                        <span className="settings-desc">
                          Automatically silence chimes and desktop notifications during these
                          recurring time-of-day windows, then resume afterward. Findings still
                          accumulate in the dashboard — only the alerts are muted. Times are local;
                          an end before the start wraps past midnight.
                        </span>
                        {(settings.quietHours ?? []).length === 0 && (
                          <span className="settings-hint">No quiet hours scheduled.</span>
                        )}
                        {(settings.quietHours ?? []).map((window, index) => (
                          <div className="settings-quiet-hours-window" key={index}>
                            <div className="settings-quiet-hours-times">
                              <label className="settings-quiet-hours-time">
                                <span>From</span>
                                <input
                                  type="time"
                                  aria-label={`Quiet hours window ${index + 1} start`}
                                  value={window.start}
                                  onChange={(e) => updateQuietHoursTime(index, 'start', e.target.value)}
                                />
                              </label>
                              <label className="settings-quiet-hours-time">
                                <span>To</span>
                                <input
                                  type="time"
                                  aria-label={`Quiet hours window ${index + 1} end`}
                                  value={window.end}
                                  onChange={(e) => updateQuietHoursTime(index, 'end', e.target.value)}
                                />
                              </label>
                              <button
                                type="button"
                                className="settings-button secondary"
                                aria-label={`Remove quiet hours window ${index + 1}`}
                                onClick={() => removeQuietHoursWindow(index)}
                              >
                                Remove
                              </button>
                            </div>
                            <div className="settings-quiet-hours-days" role="group" aria-label={`Quiet hours window ${index + 1} days`}>
                              {WEEKDAY_LABELS.map((label, day) => {
                                const active = window.days === undefined || window.days.includes(day);
                                return (
                                  <button
                                    type="button"
                                    key={day}
                                    className={`settings-quiet-hours-day ${active ? 'active' : ''}`}
                                    aria-pressed={active}
                                    aria-label={label}
                                    title={window.days === undefined ? `${label} (every day)` : label}
                                    onClick={() => toggleQuietHoursDay(index, day)}
                                  >
                                    {label[0]}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                        <button
                          type="button"
                          className="settings-button"
                          onClick={addQuietHoursWindow}
                        >
                          Add quiet hours
                        </button>
                      </div>
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
                          aria-label="Stale agent timeout"
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
                          aria-label="Repeated error threshold"
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
                    {/* #681: per-agent-type reasoning-effort default. One row per
                        concrete agent. "Default" clears the setting, so the agent
                        CLI's own default applies and no effort flag is passed. */}
                    {AVAILABLE_AGENT_TYPES.map(({ type, label }) => (
                      <div className="settings-row" key={`effort-${type}`}>
                        <div className="settings-row-info">
                          <span className="settings-label">{label} effort</span>
                          <span className="settings-desc">
                            Reasoning-effort level new {label} tasks launch at. "Default" uses the
                            agent CLI's own default (no flag passed). A per-task override (via the
                            task API or <code>kookr-spawn --effort</code>) wins over this default.
                          </span>
                        </div>
                        <div className="settings-agent-select">
                          <select
                            aria-label={`${label} reasoning effort`}
                            className="settings-select"
                            value={settings.agentEffort?.[type] ?? ''}
                            onChange={(e) => handleAgentEffortChange(type, e.target.value)}
                          >
                            <option value="">Default</option>
                            {effortLevelsForAgent(type).map((level) => (
                              <option key={level} value={level}>{level}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Reply snippets */}
                  <div className="settings-section">
                    <div className="settings-section-title">Reply Snippets</div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Saved replies</span>
                        <span className="settings-desc">
                          Reusable text inserted into the response box. Selecting a snippet never sends it automatically.
                        </span>
                        <span className="settings-hint">
                          {(settings.replySnippets ?? []).length}/{MAX_REPLY_SNIPPETS} saved
                        </span>
                      </div>
                      <button
                        type="button"
                        className="settings-button"
                        onClick={addReplySnippet}
                        disabled={(settings.replySnippets ?? []).length >= MAX_REPLY_SNIPPETS}
                      >
                        Add snippet
                      </button>
                    </div>
                    {(settings.replySnippets ?? []).length === 0 && (
                      <div className="settings-empty-note">No saved reply snippets.</div>
                    )}
                    {(settings.replySnippets ?? []).map((snippet, index) => (
                      <div className="settings-snippet-row" key={index}>
                        <label className="settings-snippet-label">
                          <span className="settings-label">Label</span>
                          <input
                            value={snippet.label}
                            onChange={(e) => updateReplySnippetDraft(index, 'label', e.target.value)}
                            onBlur={saveReplySnippets}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                saveReplySnippets();
                                e.currentTarget.blur();
                              }
                            }}
                          />
                        </label>
                        <label className="settings-snippet-text">
                          <span className="settings-label">Text</span>
                          <textarea
                            rows={2}
                            value={snippet.text}
                            onChange={(e) => updateReplySnippetDraft(index, 'text', e.target.value)}
                            onBlur={saveReplySnippets}
                          />
                        </label>
                        <button
                          type="button"
                          className="settings-button secondary"
                          aria-label={`Remove reply snippet ${index + 1}`}
                          onClick={() => removeReplySnippet(index)}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* Keyboard Shortcuts */}
                  <div className="settings-section">
                    <div className="settings-section-title">Keyboard Shortcuts</div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Platform defaults</span>
                        <span className="settings-desc">
                          Editing {SHORTCUT_PLATFORM === 'mac' ? 'macOS' : 'Linux/Windows'} shortcuts.
                          Leave a field empty to use its default binding.
                        </span>
                        {shortcutConflicts.length > 0 && (
                          <span className="settings-hint">
                            Conflicts: {shortcutConflicts.map((conflict) => `${conflict.binding} (${conflict.actionIds.join(', ')})`).join('; ')}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        className="settings-button"
                        onClick={resetAllShortcuts}
                      >
                        Reset all
                      </button>
                    </div>
                    {SHORTCUT_ACTIONS.map((action) => (
                      <div className="settings-row" key={action.id}>
                        <div className="settings-row-info">
                          <span className="settings-label">{action.label}</span>
                          <span className="settings-desc">
                            Default: {formatShortcutBinding(SHORTCUT_DEFAULTS[action.id])}
                            {' · '}
                            Active: {formatShortcutBinding(resolvedShortcuts[action.id])}
                          </span>
                        </div>
                        <div className="settings-shortcut-controls">
                          <input
                            type="text"
                            className="settings-shortcut-input"
                            aria-label={`${action.label} shortcut`}
                            value={shortcutOverrides[action.id] ?? ''}
                            placeholder={formatShortcutBinding(SHORTCUT_DEFAULTS[action.id])}
                            onChange={(e) => updateShortcutOverride(action.id, e.target.value)}
                            onBlur={saveShortcutOverrides}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                saveShortcutOverrides();
                                (e.currentTarget as HTMLInputElement).blur();
                              }
                            }}
                          />
                          <button
                            type="button"
                            className="settings-button secondary"
                            aria-label={`Reset ${action.label} shortcut to default`}
                            onClick={() => resetShortcut(action.id)}
                          >
                            Reset
                          </button>
                        </div>
                      </div>
                    ))}
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
                          aria-label="GitHub polling interval"
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
