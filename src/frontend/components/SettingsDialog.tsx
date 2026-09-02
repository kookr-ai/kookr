import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  buildAgentSelectionOptions,
  AVAILABLE_AGENT_TYPES,
  ROUND_ROBIN_AGENT_TYPE,
  effortLevelsForAgent,
  isAgentType,
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
import { CHIME_SOUND_LABELS, formatSoundVolume, type ChimeSound } from '../audio/sound-preference.js';
import { setQuietHoursWindows } from '../hooks/useDnd.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { useKookrStore } from '../store/useStore.js';
import { applyRoundRobinIndex } from '../store/round-robin-cursor.js';
import { applyQuotaHeadroomThreshold } from '../store/quota-headroom-threshold.js';
import { AgentTypeSelector } from './AgentTypeSelector.js';
import { HookInventorySection } from './HookInventorySection.js';
import type {
  RelayConnectionStatus,
} from '../../shared/contracts/relay-connection.js';
import type {
  SessionSharingRecoveryAction,
} from '../../shared/contracts/session-sharing-recovery.js';
import {
  getRelayConnection,
  getSettings,
  getShareCsrfToken,
  mutateRelayConnection,
  runSessionSharingRecovery,
  saveSettings as saveSettingsRequest,
} from '../api/index.js';

interface ServerSettings {
  githubPollingEnabled: boolean;
  githubPollingIntervalSec: number;
  autoWatchOssSources: boolean;
  watchdogStaleThresholdSec: number;
  repeatedErrorThreshold: number;
  maxActiveTasks: number;
  cleanupWorktreeOnComplete: boolean;
  defaultAgentType: AgentSelection;
  /** Agents that must never spawn (issue #3025). */
  blacklistedAgentTypes?: AgentType[];
  roundRobinIndex?: number;
  /** Live Claude plan-quota gate; Launch dialog reuses this without changing it. */
  quotaHeadroomThreshold?: number;
  agentEffort?: AgentEffortMap;
  shortcutBindings: PlatformShortcutBindingOverrides;
  speakVerbosity?: VerbosityScale;
  quietHours?: QuietHoursWindow[];
  replySnippets?: ReplySnippet[];
  autoCloseCompletionReadyDelayMin: number;
  completionReadyTtlMinutes: number;
  hungTaskReapEnabled: boolean;
  hungTaskReapMinutes: number;
  hungTaskReapWarningEnabled: boolean;
  hungTaskReapGraceSeconds: number;
  /** Global automation kill-switch (issue #1710). */
  automationKillSwitch?: boolean;
  /** ISO timestamp when SAFE MODE began; null while disengaged. */
  safeModeSince?: string | null;
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

// Searchable terms per tab, used only to decide which tab to switch to when the
// active tab has no visible match for the search query. The actual show/hide of
// rows and sections is driven by matching the rendered DOM text (see the search
// effect), so this index only needs terms that also appear in each tab's markup
// — keeping it a subset of the rendered text prevents switching to a tab that
// would then show nothing. Only the active tab is mounted at a time, so this is
// how a query typed on one tab can find a match living on another.
const SETTINGS_SEARCH_INDEX: Record<SettingsTab, readonly string[]> = {
  general: [
    'notifications & alerts', 'sound alerts', 'alert volume', 'chime sound',
    'spoken summary length', 'quiet hours', 'detection sensitivity',
    'stale agent timeout', 'repeated error threshold', 'task management',
    'default agent', 'blacklisted agents', 'blacklist', 'max concurrent tasks', 'auto-close delay',
    'completion-ready ttl escalation', 'hung-task reaper', 'hung-task reap threshold',
    'clean worktrees on completion', 'effort', 'reply snippets', 'saved replies',
    'keyboard shortcuts', 'platform defaults', 'github polling', 'enable polling',
    'polling interval', 'oss sources', 'auto-watch local sources',
  ],
  sharing: [
    'relay connection', 'relay url', 'node id', 'node token', 'relay admin token',
    'account token', 'display name', 'hosted relay', 'session sharing recovery',
    'sharing',
  ],
  hooks: [
    'hooks', 'sessionstart', 'read-only',
  ],
};

// Which tab hosts each focusable field. Extend this when SettingsFocusField
// gains a new value — the Record type makes the requirement exhaustive.
const FOCUS_FIELD_TAB: Record<SettingsFocusField, SettingsTab> = {
  maxActiveTasks: 'general',
  relayConnection: 'sharing',
};

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
    const body = await getRelayConnection();
    setStatus(body.status);
    if (body.status.relayUrl) setRelayUrl(body.status.relayUrl);
    if (body.status.nodeId) setNodeId(body.status.nodeId);
    if (body.status.displayName) setDisplayName(body.status.displayName);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      try {
        const { ok, status, body: tokenBody } = await getShareCsrfToken();
        if (!ok) throw new Error(`csrf-${status}`);
        if (!cancelled && typeof tokenBody?.csrfToken === 'string') setCsrfToken(tokenBody.csrfToken);
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
      const { ok, status: httpStatus, body } = await mutateRelayConnection(path, csrfToken, init);
      if (!ok || !('status' in body)) throw new Error('error' in body && body.error ? body.error : `HTTP ${httpStatus}`);
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
      const { ok, status, body: payload } = await runSessionSharingRecovery(action, csrfToken, body);
      if (!ok || !('result' in payload)) throw new Error('error' in payload && payload.error ? payload.error : `HTTP ${status}`);
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

/**
 * Reads the current browser notification-permission state, or `null` when the
 * Notification API is unavailable (e.g. insecure context, jsdom, older browser)
 * so callers can skip rendering the permission row entirely.
 */
function readNotificationPermission(): NotificationPermission | null {
  if (typeof window === 'undefined') return null;
  const ctor = (window as Window & { Notification?: typeof Notification }).Notification;
  if (!ctor) return null;
  return ctor.permission;
}

export function SettingsDialog({ onClose, focusField, onSettingsSaved }: Props) {
  const availableAgentTypes = useKookrStore((s) => s.availableAgentTypes);
  const serverDefaultAgentType = useKookrStore((s) => s.defaultAgentType);
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [searchQuery, setSearchQuery] = useState('');
  const [noSearchResults, setNoSearchResults] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | null>(
    () => readNotificationPermission(),
  );
  const agentOptions = buildAgentSelectionOptions(
    (availableAgentTypes.length > 0 ? availableAgentTypes : AVAILABLE_AGENT_TYPES)
      .filter((item) => !(settings?.blacklistedAgentTypes ?? []).includes(item.type)),
  );
  const sound = useSoundPreference();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
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

  // Re-read the notification permission when the tab regains focus. The `denied`
  // guidance sends the user to the browser's site settings; without this, the
  // row would keep showing "Blocked" after they re-enable it elsewhere and come
  // back to the still-open dialog. There is no dedicated permission-change event
  // that fires reliably across browsers, so visibility/focus is the practical hook.
  useEffect(() => {
    if (readNotificationPermission() === null) return;
    const sync = () => setNotificationPermission(readNotificationPermission());
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
    };
  }, []);

  useEffect(() => {
    getSettings<ServerSettings>()
      .then((data) => {
        setSettings(data);
        setWarnings(data.warnings ?? []);
        // Mirror the saved schedule into the live DND gate so quiet hours take
        // effect immediately, even before the operator edits anything.
        setQuietHoursWindows(data.quietHours ?? []);
        applyRoundRobinIndex(data.roundRobinIndex);
        applyQuotaHeadroomThreshold(data.quotaHeadroomThreshold);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load settings');
        setLoading(false);
      });
  }, []);

  // Filter the visible settings by the search query. Only the active tab is
  // mounted, so we match against its rendered DOM text and toggle inline
  // display. A section is shown when any of its text matches the query; this
  // is deliberately structure-agnostic so it works for both the row-based
  // General/Hooks sections and the Sharing section (a single section with two
  // titles and field-based, not row-based, controls). Within a shown section
  // we narrow to the matching rows only when doing so would not hide the match
  // itself — a title-level or non-row match keeps every row visible. When
  // nothing on the active tab matches, jump to the first other tab whose index
  // has the term; if no tab matches at all, flag no results.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const query = searchQuery.trim().toLowerCase();
    const sections = Array.from(body.querySelectorAll<HTMLElement>('.settings-section'));
    const rowSelector = '.settings-row, .hook-inventory-row';

    if (!query) {
      for (const section of sections) {
        section.style.display = '';
        for (const row of Array.from(section.querySelectorAll<HTMLElement>(rowSelector))) {
          row.style.display = '';
        }
      }
      setNoSearchResults(false);
      return;
    }

    let visibleSections = 0;
    for (const section of sections) {
      const rows = Array.from(section.querySelectorAll<HTMLElement>(rowSelector));
      const sectionMatches = (section.textContent ?? '').toLowerCase().includes(query);
      if (!sectionMatches) {
        section.style.display = 'none';
        continue;
      }
      section.style.display = '';
      visibleSections++;

      // A section can carry more than one title (Sharing bundles two). If any
      // title matches, keep the whole section as-is rather than hiding rows.
      const titleMatches = Array.from(section.querySelectorAll('.settings-section-title')).some(
        (title) => (title.textContent ?? '').toLowerCase().includes(query),
      );
      const matchingRows = rows.filter((row) => (row.textContent ?? '').toLowerCase().includes(query));
      if (titleMatches || matchingRows.length === 0) {
        // Match is title-level or lives outside any row — show everything so
        // the matched text is never hidden.
        for (const row of rows) row.style.display = '';
      } else {
        for (const row of rows) {
          row.style.display = matchingRows.includes(row) ? '' : 'none';
        }
      }
    }

    if (visibleSections === 0) {
      const target = SETTINGS_TABS.find(
        (tab) => tab !== activeTab && SETTINGS_SEARCH_INDEX[tab].some((term) => term.includes(query)),
      );
      if (target) {
        setActiveTab(target);
        setNoSearchResults(false);
        return;
      }
      setNoSearchResults(true);
    } else {
      setNoSearchResults(false);
    }
  }, [searchQuery, activeTab, settings, loading]);

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
        const { ok, status, body } = await saveSettingsRequest<ServerSettings & { warnings?: string[]; error?: string }>(updated);
        if (!ok) {
          throw new Error(body.error || `HTTP ${status}`);
        }
        const saved = body;
        if (saveId !== latestSaveIdRef.current) return;
        setWarnings(saved.warnings ?? []);
        setSettings(saved);
        window.dispatchEvent(new CustomEvent('kookr:settings-updated', { detail: saved }));
        // Re-mirror the server-normalized windows (invalid ones dropped) so the
        // live gate matches exactly what was persisted.
        setQuietHoursWindows(saved.quietHours ?? []);
        applyQuotaHeadroomThreshold(saved.quotaHeadroomThreshold);
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

  function handleBlacklistToggle(agent: AgentType) {
    if (!settings) return;
    const current = settings.blacklistedAgentTypes ?? [];
    const next = current.includes(agent)
      ? current.filter((type) => type !== agent)
      : [...current, agent];
    const updated: ServerSettings = { ...settings, blacklistedAgentTypes: next };
    if (isAgentType(updated.defaultAgentType) && next.includes(updated.defaultAgentType)) {
      updated.defaultAgentType = ROUND_ROBIN_AGENT_TYPE;
    }
    setSettings(updated);
    void saveSettings(updated);
  }

  // #681: set or clear a per-agent-type reasoning-effort default. An empty
  // value removes the entry, restoring Kookr's current default. Invalid
  // (agent, level) pairs are dropped server-side.
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

  // Prompt for desktop-notification permission from this user gesture. Browsers
  // only honor the request while permission is `default`; once `denied`, the
  // request resolves to `denied` without re-prompting, so this button is only
  // shown for the `default` state.
  async function handleEnableNotifications() {
    const ctor = typeof window === 'undefined'
      ? undefined
      : (window as Window & { Notification?: typeof Notification }).Notification;
    if (!ctor) return;
    try {
      // Legacy callback-only implementations (very old Safari) return `undefined`
      // and deliver the result via a callback instead of resolving the promise,
      // so coalesce to a fresh read rather than storing `undefined` (which would
      // pass the `!== null` render guard yet match no branch — a dead row).
      const result = await ctor.requestPermission();
      setNotificationPermission(result ?? readNotificationPermission());
    } catch {
      // Defensive: if awaiting the request throws, re-read the current
      // permission so the UI still reflects reality.
      setNotificationPermission(readNotificationPermission());
    }
  }

  function handleSoundVolumeChange(value: string) {
    sound.setVolume(Number(value));
  }

  function handleChimeSoundChange(value: string) {
    sound.setChimeSound(value as ChimeSound);
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
        <div className="settings-search">
          <input
            type="search"
            className="settings-search-input"
            placeholder="Search settings…"
            aria-label="Search settings"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
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

        <div className="settings-dialog-body" ref={bodyRef}>
          {/* Always-mounted live region so screen readers reliably announce the
              no-results state when it appears (text is toggled, not the node). */}
          <div className="settings-search-empty" role="status" aria-live="polite">
            {searchQuery.trim() && noSearchResults ? `No settings match “${searchQuery.trim()}”.` : null}
          </div>
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
                    {notificationPermission !== null && (
                      <div className="settings-row">
                        <div className="settings-row-info">
                          <span className="settings-label">Desktop notifications</span>
                          <span className="settings-desc">
                            Desktop notifications are the fallback alert channel when this tab is
                            hidden and sound is muted. They require browser permission for this site.
                          </span>
                          {notificationPermission === 'denied' && (
                            <span className="settings-hint">
                              Notifications are blocked for this site. Re-enable them in your
                              browser's site settings — browsers ignore in-page requests once
                              notifications have been blocked.
                            </span>
                          )}
                        </div>
                        <div className="settings-permission">
                          {notificationPermission === 'granted' && (
                            <span
                              className="settings-permission-status granted"
                              role="status"
                              aria-label="Desktop notifications permission: on"
                            >
                              On
                            </span>
                          )}
                          {notificationPermission === 'default' && (
                            <button
                              type="button"
                              className="settings-button"
                              onClick={handleEnableNotifications}
                              aria-label="Enable desktop notifications"
                            >
                              Enable
                            </button>
                          )}
                          {notificationPermission === 'denied' && (
                            <span className="settings-permission-status denied">
                              Blocked
                            </span>
                          )}
                        </div>
                      </div>
                    )}
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
                      <div className="settings-audio-controls">
                        <label className="settings-audio-volume">
                          <span className="settings-label">Alert volume</span>
                          <span className="settings-desc">
                            Sets the browser chime volume for warning, critical, and completion alerts.
                          </span>
                          <div className="settings-audio-control-row">
                            <input
                              type="range"
                              min="0"
                              max="1"
                              step="0.05"
                              value={sound.volume}
                              onChange={(e) => handleSoundVolumeChange(e.target.value)}
                              aria-label="Alert volume"
                            />
                            <strong>{formatSoundVolume(sound.volume)}</strong>
                          </div>
                        </label>
                        <label className="settings-audio-sound">
                          <span className="settings-label">Chime sound</span>
                          <span className="settings-desc">Choose the synthesized alert tone used for browser chimes.</span>
                          <select
                            value={sound.chimeSound}
                            onChange={(e) => handleChimeSoundChange(e.target.value)}
                            aria-label="Chime sound"
                          >
                            {Object.entries(CHIME_SOUND_LABELS).map(([value, label]) => (
                              <option key={value} value={value}>{label}</option>
                            ))}
                          </select>
                        </label>
                      </div>
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
                          agent is supplied. Round robin rotates across the registered agents
                          (Claude Code, Codex CLI, and Grok Build when available).
                        </span>
                      </div>
                      <div className="settings-agent-select">
                        <AgentTypeSelector
                          value={settings.defaultAgentType ?? serverDefaultAgentType}
                          onChange={handleDefaultAgentChange}
                          options={agentOptions}
                          label="Agent"
                          compact
                          roundRobinIndex={settings.roundRobinIndex}
                        />
                      </div>
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Blacklisted agents</span>
                        <span className="settings-desc">
                          Blacklisted coding agents cannot be launched from the dashboard, CLI,
                          scheduled tasks, or child spawns. They stay hidden from launch pickers
                          until you uncheck them here. Running sessions are not auto-killed.
                        </span>
                      </div>
                      <div className="settings-agent-blacklist" role="group" aria-label="Blacklisted agents">
                        {AVAILABLE_AGENT_TYPES.map((agent) => {
                          const banned = (settings.blacklistedAgentTypes ?? []).includes(agent.type);
                          return (
                            <label
                              key={agent.type}
                              className={banned
                                ? 'settings-agent-blacklist-item is-blacklisted'
                                : 'settings-agent-blacklist-item'}
                            >
                              <input
                                type="checkbox"
                                checked={banned}
                                aria-label={`Blacklist ${agent.label}`}
                                onChange={() => handleBlacklistToggle(agent.type)}
                              />
                              <span className="settings-agent-blacklist-label">{agent.label}</span>
                            </label>
                          );
                        })}
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
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Automation kill-switch</span>
                        <span className="settings-desc">
                          Engage SAFE MODE: halt schedule fires and other autonomous launches while
                          keeping manual launches available. Use during incidents when automated
                          actuators must stop. Distinct from drain mode (which refuses all new launches).
                          {settings.automationKillSwitch && settings.safeModeSince
                            ? ` Engaged since ${settings.safeModeSince}.`
                            : ''}
                        </span>
                      </div>
                      <button
                        type="button"
                        className={`settings-toggle ${settings.automationKillSwitch ? 'active' : ''}`}
                        onClick={() => handleToggle('automationKillSwitch')}
                        aria-label="Automation kill-switch"
                        aria-pressed={Boolean(settings.automationKillSwitch)}
                      >
                        <span className="settings-toggle-knob" />
                      </button>
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Auto-close delay</span>
                        <span className="settings-desc">
                          Minutes a task&apos;s completion-ready signal stays pending before Kookr
                          auto-closes the task. Only applies to tasks launched with auto-close on
                          signal (e.g. self-continuation chains and the Implement GitHub Issue
                          playbook); other tasks keep the signal surfaced for manual review.
                          Range: 1–1440 minutes.
                        </span>
                      </div>
                      <div className="settings-number-group">
                        <input
                          type="number"
                          className="settings-number"
                          aria-label="Auto-close delay"
                          value={settings.autoCloseCompletionReadyDelayMin}
                          onChange={(e) => handleNumberChange('autoCloseCompletionReadyDelayMin', e.target.value, 1, 1440)}
                          min={1}
                          max={1440}
                          step={5}
                        />
                        <span className="settings-unit">min</span>
                      </div>
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Completion-ready TTL escalation</span>
                        <span className="settings-desc">
                          Minutes a completion_ready signal can sit unacknowledged — including
                          ask-first tasks that never auto-close — before Kookr closes the task
                          anyway so it stops holding a concurrency slot. A notification and audit
                          record are always emitted when this fires. Range: 5–10080 minutes (7 days).
                        </span>
                      </div>
                      <div className="settings-number-group">
                        <input
                          type="number"
                          className="settings-number"
                          aria-label="Completion-ready TTL escalation"
                          value={settings.completionReadyTtlMinutes}
                          onChange={(e) => handleNumberChange('completionReadyTtlMinutes', e.target.value, 5, 10_080)}
                          min={5}
                          max={10_080}
                          step={15}
                        />
                        <span className="settings-unit">min</span>
                      </div>
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Hung-task reaper</span>
                        <span className="settings-desc">
                          Terminate a task whose agent has had zero hook events, zero pane-content
                          change, and zero token activity for the configured duration. Tasks with a
                          pending signal, or that the watchdog classifies as waiting on you or a
                          permission, are never reaped.
                        </span>
                      </div>
                      <button
                        type="button"
                        className={`settings-toggle ${settings.hungTaskReapEnabled ? 'active' : ''}`}
                        onClick={() => handleToggle('hungTaskReapEnabled')}
                        aria-label="Toggle hung-task reaper"
                        aria-pressed={settings.hungTaskReapEnabled}
                      >
                        <span className="settings-toggle-knob" />
                      </button>
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Hung-task reap threshold</span>
                        <span className="settings-desc">
                          Minutes of total silence on all liveness channels before a task is
                          reaped. Range: 15–10080 minutes (7 days).
                        </span>
                      </div>
                      <div className="settings-number-group">
                        <input
                          type="number"
                          className="settings-number"
                          aria-label="Hung-task reap threshold"
                          value={settings.hungTaskReapMinutes}
                          onChange={(e) => handleNumberChange('hungTaskReapMinutes', e.target.value, 15, 10_080)}
                          min={15}
                          max={10_080}
                          step={15}
                        />
                        <span className="settings-unit">min</span>
                      </div>
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Warn before reaping</span>
                        <span className="settings-desc">
                          Before terminating a hung task, show a countdown with a “Keep it alive”
                          button and auto-hold it while you have the task open, so you get a chance
                          to take manual control. Turn off to reap immediately (the previous
                          behavior). Repeatedly keeping a task alive without working on it delays,
                          but never prevents, reclaiming its slot.
                        </span>
                      </div>
                      <button
                        type="button"
                        className={`settings-toggle ${settings.hungTaskReapWarningEnabled ? 'active' : ''}`}
                        onClick={() => handleToggle('hungTaskReapWarningEnabled')}
                        aria-label="Toggle warn before reaping"
                        aria-pressed={settings.hungTaskReapWarningEnabled}
                      >
                        <span className="settings-toggle-knob" />
                      </button>
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Reap warning countdown</span>
                        <span className="settings-desc">
                          Seconds between the warning and the reap. Range: 10–600 seconds.
                        </span>
                      </div>
                      <div className="settings-number-group">
                        <input
                          type="number"
                          className="settings-number"
                          aria-label="Reap warning countdown"
                          value={settings.hungTaskReapGraceSeconds}
                          onChange={(e) => handleNumberChange('hungTaskReapGraceSeconds', e.target.value, 10, 600)}
                          min={10}
                          max={600}
                          step={10}
                          disabled={!settings.hungTaskReapWarningEnabled}
                        />
                        <span className="settings-unit">sec</span>
                      </div>
                    </div>
                    <div className="settings-row">
                      <div className="settings-row-info">
                        <span className="settings-label">Clean worktrees on completion</span>
                        <span className="settings-desc">
                          Pre-check the completion dialog&apos;s cleanup option. Kookr removes eligible task worktrees,
                          prunes Git, and deletes merged or patch-equivalent local branches; dirty or unique-commit worktrees are kept.
                        </span>
                      </div>
                      <button
                        type="button"
                        className={`settings-toggle ${settings.cleanupWorktreeOnComplete ? 'active' : ''}`}
                        onClick={() => handleToggle('cleanupWorktreeOnComplete')}
                        aria-label="Toggle worktree cleanup on task completion"
                        aria-pressed={settings.cleanupWorktreeOnComplete}
                      >
                        <span className="settings-toggle-knob" />
                      </button>
                    </div>
                    {/* #681: per-agent-type reasoning-effort default. One row per
                        concrete agent. */}
                    {AVAILABLE_AGENT_TYPES.map(({ type, label }) => (
                      <div className="settings-row" key={`effort-${type}`}>
                        <div className="settings-row-info">
                          <span className="settings-label">{label} effort</span>
                          <span className="settings-desc">
                            Reasoning-effort level new {label} tasks launch at. "Agent default" leaves
                            effort unset so the agent CLI / model uses its own native default
                            {type === 'codex-cli' ? ' (Codex model defaults to gpt-5.6-sol; override with KOOKR_CODEX_MODEL)' : ''}.
                            A per-task override on the Launch dialog or Quick Launch (or via
                            the task API / <code>kookr-spawn --effort</code>) wins over this default.
                          </span>
                        </div>
                        <div className="settings-agent-select">
                          <select
                            aria-label={`${label} reasoning effort`}
                            className="settings-select"
                            value={settings.agentEffort?.[type] ?? ''}
                            onChange={(e) => handleAgentEffortChange(type, e.target.value)}
                          >
                            <option value="">Agent default</option>
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
