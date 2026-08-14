import React, { useState, useRef, useEffect, useMemo, lazy, Suspense } from 'react';
import {
  buildAgentSelectionOptions,
  shouldDisableLaunchForGrokAuth,
  shouldShowGrokAuthBanner,
  type ClientMessage,
  type AgentType,
  type AgentSelection,
} from '../../shared/protocol.js';
import type { ProjectSummary } from '../../shared/protocol.js';
import { useKookrStore } from '../store/useStore.js';
import { track } from '../telemetry.js';
import { RecentPaths } from '../store/recent-paths.js';
import {
  loadLaunchTaskDialogDraftForOpen,
  saveLaunchTaskDialogDraft,
  clearLaunchTaskDialogDraft,
  markLaunchTaskDialogDraftSubmitted,
  type LaunchTaskDialogDraft,
} from '../store/launch-task-dialog-draft.js';
import { loadLastAgentType, saveLastAgentType } from '../store/last-agent-type.js';
import { noteRoundRobinLaunch } from '../store/round-robin-cursor.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { PlaybookBrowser } from './PlaybookBrowser.js';
import { AgentTypeSelector } from './AgentTypeSelector.js';
import { LaunchEffortModelPickers } from './LaunchEffortModelPickers.js';
import { optionalLaunchPins } from './launch-effort-model.js';
import { GROK_AUTH_BANNER_ID, GrokAuthPreflightBanner } from './GrokAuthPreflightBanner.js';
import { LAUNCH_DUPLICATE_BANNER_ID, LaunchDuplicateBanner } from './LaunchDuplicateBanner.js';
import { useGrokAuthStatus } from '../hooks/useGrokAuthStatus.js';
import { endsWithProtectedSuffix, deriveParentRepoFromProtected } from '../../shared/contracts/worktree-protection.js';
import type { ShortcutBinding } from '../../shared/contracts/shortcut-bindings.js';
import { findActiveLaunchDuplicate, withLaunchTaskCwds } from '../../shared/launch-duplicate.js';
import { useLaunchTaskCwds } from '../hooks/useLaunchTaskCwds.js';

const VoiceInputButton = lazy(() => import('./VoiceInputButton.js').then(m => ({ default: m.VoiceInputButton })));

// Singleton so all dialog instances share the same MRU list
const recentPaths = new RecentPaths();

/** Time-to-live for the playbook list cache, in milliseconds. */
const PLAYBOOK_CACHE_TTL_MS = 30_000;

type Tab = 'manual' | 'playbooks';

/** A cwd dropdown entry: an MRU path, optionally labeled as a tracked project. */
interface CwdSuggestion {
  path: string;
  /** Display name of the tracked project this path belongs to, when known. */
  projectName?: string;
}

/**
 * Was a previously-submitted draft's launch confirmed? True when a task whose
 * display prompt matches the draft is visible in the store snapshot. Used on
 * dialog open to decide whether an optimistically-kept draft (RFC F12) can be
 * cleared. A non-match keeps the draft — the safe direction.
 */
function draftLaunchConfirmed(draft: LaunchTaskDialogDraft): boolean {
  const target = draft.prompt.trim();
  if (!target) return true;
  return useKookrStore.getState().agents.some(
    (agent) => (agent.description ?? '').trim() === target,
  );
}

interface Props {
  send: (msg: ClientMessage) => boolean;
  onClose: () => void;
  defaultCwd?: string;
  defaultPrompt?: string;
  defaultCriteria?: string;
  defaultAgentType?: AgentType;
  /** When set, auto-switch to playbooks tab and pre-select this playbook for relaunch. */
  relaunchPlaybookId?: string;
  /** Parameter values to pre-fill when relaunching a playbook task. */
  relaunchParameterValues?: Record<string, string>;
  /** When launched from a project drawer, pre-fill source-matching params */
  projectContext?: ProjectSummary;
  /** When launched from a selected project, pre-fill cwd with that project's local checkout. */
  projectCwd?: string;
  /** Which tab to show first. Palette and project-drawer entry points pass this; relaunch still forces playbooks. */
  initialTab?: Tab;
  sttShortcutBinding?: ShortcutBinding;
}

export function LaunchTaskDialog({ send, onClose, defaultCwd, defaultPrompt, defaultCriteria, defaultAgentType, relaunchPlaybookId, relaunchParameterValues, projectContext, projectCwd, initialTab: requestedInitialTab, sttShortcutBinding }: Props) {
  const serverCwd = useKookrStore((s) => s.serverCwd);
  const sttUrl = useKookrStore((s) => s.sttUrl);
  const availableAgentTypes = useKookrStore((s) => s.availableAgentTypes);
  const serverDefaultAgentType = useKookrStore((s) => s.defaultAgentType);
  const roundRobinIndex = useKookrStore((s) => s.roundRobinIndex);
  const setPlaybooksLoading = useKookrStore((s) => s.setPlaybooksLoading);
  const playbooks = useKookrStore((s) => s.playbooks);
  const playbooksLastFetchedAt = useKookrStore((s) => s.playbooksLastFetchedAt);
  const playbooksLastFetchedCwd = useKookrStore((s) => s.playbooksLastFetchedCwd);
  const hostCapabilities = useKookrStore((s) => s.hostCapabilities);
  const projectSummaries = useKookrStore((s) => s.projectSummaries);
  const agents = useKookrStore((s) => s.agents);
  const launchCwds = useLaunchTaskCwds();
  const duplicateCandidates = useMemo(
    () => withLaunchTaskCwds(agents, launchCwds),
    [agents, launchCwds],
  );
  const agentOptions = buildAgentSelectionOptions(availableAgentTypes);
  const grokAuth = useGrokAuthStatus();
  // Relaunch paths drive the form from props. In that mode we neither read
  // nor write the persisted draft — the relaunched task owns its own state.
  const isRelaunch = defaultPrompt != null || defaultCriteria != null || defaultCwd != null;
  // Resolved once per open (lazy initializer): a draft kept across an
  // optimistic submit (RFC F12) is cleared here when the launch is confirmed
  // by a matching task in the store, and restored otherwise.
  const [initialDraft] = useState(() =>
    isRelaunch ? null : loadLaunchTaskDialogDraftForOpen(draftLaunchConfirmed),
  );
  // Was this dialog opened with content hydrated from a stored draft? Recorded
  // once at mount so subsequent typing (which keeps writing to storage) does
  // not flip the indicator on/off. cwd alone doesn't count — see saveLaunchTaskDialogDraft
  // for the same "cwd is auto-populated, ignore it" rationale.
  const initialHadDraft = !isRelaunch && initialDraft != null
    && (initialDraft.prompt.trim().length > 0 || initialDraft.criteria.trim().length > 0);
  // Local checkouts of tracked projects, labeled for the cwd dropdown and
  // used as a default ahead of the server's own runtime checkout (RFC F13).
  const trackedProjectPaths = useMemo<CwdSuggestion[]>(
    () => projectSummaries.flatMap((p) =>
      p.localPath ? [{ path: p.localPath, projectName: p.displayName }] : [],
    ),
    [projectSummaries],
  );
  // `||` (not `??`) for the cwd fallback chain: a persisted empty-string cwd
  // must fall through to the recentPaths default rather than leave the field
  // blank on reopen. `projectCwd` slots above the draft so launching from a
  // project drawer overrides the persisted draft path with that project's cwd.
  // serverCwd — the supervisor's *own* runtime checkout — is deliberately the
  // LAST resort (RFC F13): it must never win while MRU entries or tracked
  // project checkouts exist.
  const resolvedInitialCwd =
    defaultCwd ?? projectCwd ?? (
      initialDraft?.cwd
      || recentPaths.getAll()[0]
      || trackedProjectPaths[0]?.path
      || serverCwd
    );
  const [prompt, setPrompt] = useState(defaultPrompt ?? initialDraft?.prompt ?? '');
  const [cwd, setCwd] = useState(resolvedInitialCwd);
  const [criteria, setCriteria] = useState(defaultCriteria ?? initialDraft?.criteria ?? '');
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const initialTab: Tab = relaunchPlaybookId
    ? 'playbooks'
    : requestedInitialTab ?? (projectContext ? 'playbooks' : 'manual');
  const [tab, setTab] = useState<Tab>(initialTab);
  const [submitting, setSubmitting] = useState(false);
  // Agent default chain (RFC F6): explicit prop → user's last-used selection
  // (persisted on successful submit) → server default → 'claude-code'. The
  // last-used entry is skipped when it is not currently offered (e.g.
  // 'round-robin' after the server drops to a single agent).
  const [agentType, setAgentType] = useState<AgentSelection>(() => {
    if (defaultAgentType) return defaultAgentType;
    const lastUsed = loadLastAgentType();
    if (lastUsed && agentOptions.some((opt) => opt.type === lastUsed)) return lastUsed;
    return serverDefaultAgentType ?? 'claude-code';
  });
  const [effort, setEffort] = useState('');
  const [model, setModel] = useState('');
  const availableAgentTypeIds = availableAgentTypes.map((entry) => entry.type);
  const grokAuthBlocksLaunch = shouldDisableLaunchForGrokAuth(
    agentType,
    grokAuth?.launchWouldRefuse === true,
    availableAgentTypeIds,
    grokAuth?.roundRobinIndex ?? 0,
  );
  const showGrokAuthBanner = shouldShowGrokAuthBanner(
    agentType,
    grokAuth?.status,
    availableAgentTypeIds,
    grokAuth?.roundRobinIndex ?? 0,
  );
  const [draftRestored, setDraftRestored] = useState(initialHadDraft);
  const dialogRef = useRef<HTMLDivElement>(null);
  const playbooksTabRef = useRef<HTMLButtonElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const cwdRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLUListElement>(null);
  const openedAtRef = useRef(Date.now());
  // Blocks the save effect from resurrecting the draft after a successful
  // submit sets the flag and synchronously clears the stored draft.
  const submittedRef = useRef(false);
  // Tracks the last cwd value committed by a non-typing action (MRU pick or
  // server-cwd button). At submit time, if the current cwd matches this, the
  // user didn't mutate after picking, so we don't fire a redundant 'typed'
  // event. If they typed *over* the picked value, the values diverge and we
  // fire 'typed' to record the override.
  const lastNonTypedCwdRef = useRef<string | null>(null);

  useEffect(() => {
    if (isRelaunch) return;
    if (submittedRef.current) return;
    saveLaunchTaskDialogDraft({ prompt, cwd, criteria });
  }, [prompt, cwd, criteria, isRelaunch]);

  useEffect(() => {
    if (initialHadDraft) {
      track({ type: 'launch_dialog_draft_restored' });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- mount only

  useEffect(() => {
    if (tab === 'manual') promptRef.current?.focus();
  }, [tab]);
  useDialogFocus({
    dialogRef,
    initialFocusRef: initialTab === 'playbooks' ? playbooksTabRef : promptRef,
  });

  // When opening directly to playbooks, ensure the list is fetched.
  useEffect(() => {
    if (relaunchPlaybookId || initialTab === 'playbooks') {
      // The playbook catalog follows the focused project: `cwd` is seeded from
      // the project (defaultCwd ?? projectCwd ?? …), so scanning it lists the
      // project's own `.kookr/playbooks/`. Falls back to serverCwd when the
      // project cwd is empty/unresolved so we never scan `<empty>/.kookr/...`.
      // This only changes which playbooks are LISTED — getTaskTargetCwd() keeps
      // the execution cwd unchanged (catalog/target split from #209). See #1019.
      const targetCwd = cwd.trim() || serverCwd;
      // A cached `absent` capability is treated as stale so a user who just
      // installed the dependency is not stuck with a collapsed control until
      // the cache TTL expires. See rfc-capability-gated-playbook-params.md.
      const isFresh =
        playbooksLastFetchedCwd === targetCwd &&
        Date.now() - playbooksLastFetchedAt < PLAYBOOK_CACHE_TTL_MS &&
        playbooks.length > 0 &&
        !Object.values(hostCapabilities).some((c) => c === 'absent');
      if (!isFresh) {
        setPlaybooksLoading(true);
        send({ type: 'listPlaybooks', cwd: targetCwd });
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- run once on mount

  // MRU paths merged with tracked-project checkouts (RFC F13). MRU entries
  // keep their recency order; project paths not already in the MRU follow,
  // labeled with the project displayName. A path that is both stays in its
  // MRU slot but picks up the label.
  const allCwdSuggestions = useMemo<CwdSuggestion[]>(() => {
    const merged = new Map<string, CwdSuggestion>();
    for (const path of recentPaths.getAll()) merged.set(path, { path });
    for (const entry of trackedProjectPaths) {
      const existing = merged.get(entry.path);
      if (existing) existing.projectName = entry.projectName;
      else merged.set(entry.path, { ...entry });
    }
    return [...merged.values()];
  }, [trackedProjectPaths]);

  const suggestions = useMemo(() => {
    if (!cwd) return allCwdSuggestions;
    const query = cwd.toLowerCase();
    return allCwdSuggestions.filter((s) =>
      s.path.toLowerCase().includes(query)
      || s.projectName?.toLowerCase().includes(query),
    );
  }, [cwd, allCwdSuggestions]);

  const activeDuplicate = useMemo(
    () => findActiveLaunchDuplicate(duplicateCandidates, { prompt, cwd, agentType }),
    [duplicateCandidates, prompt, cwd, agentType],
  );

  function submitLaunch(keepAsDuplicate: boolean) {
    const trimmed = prompt.trim();
    if (!trimmed || !cwd.trim() || submitting || grokAuthBlocksLaunch) return;
    if (!keepAsDuplicate && findActiveLaunchDuplicate(duplicateCandidates, {
      prompt: trimmed,
      cwd: cwd.trim(),
      agentType,
    })) {
      return;
    }

    setSubmitting(true);
    recentPaths.add(cwd.trim());
    if (cwd.trim() !== lastNonTypedCwdRef.current) {
      track({ type: 'launch_dialog_cwd_field_used', method: 'typed' });
    }
    track({ type: 'launch_submitted', method: 'manual' });
    track({ type: 'launch_dialog_closed', submitted: true, dwellMs: Date.now() - openedAtRef.current });
    const excerpt = trimmed.slice(0, 40) + (trimmed.length > 40 ? '…' : '');
    const sent = send({
      type: 'launch',
      prompt: trimmed,
      cwd: cwd.trim(),
      criteria: criteria.trim() || undefined,
      agentType,
      ...optionalLaunchPins(effort, model),
      ...(keepAsDuplicate
        ? { disableDedup: true, metadataIntent: 'keep_as_duplicate' as const }
        : {}),
    });
    if (sent) {
      // Set the ref *before* marking so any pending save-effect re-run sees
      // it and early-returns instead of overwriting the submitted marker.
      submittedRef.current = true;
      // RFC F12: do NOT clear the draft here — the dialog closes before the
      // server confirms the launch, and a server-side failure (e.g. missing
      // working directory) would otherwise lose the typed prompt. The marked
      // draft is reconciled on the next dialog open (cleared once a matching
      // task is visible, restored otherwise).
      markLaunchTaskDialogDraftSubmitted();
      saveLastAgentType(agentType);
      noteRoundRobinLaunch(agentType);
      useKookrStore.getState().handleAlert('', `Launching task: ${excerpt}`, 'info');
    } else {
      useKookrStore.getState().handleAlert(
        '',
        `Could not start task: not connected. ${excerpt}`,
        'error',
      );
    }
    onClose();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    submitLaunch(false);
  }

  function openExistingDuplicate() {
    if (!activeDuplicate) return;
    const agentId = activeDuplicate.agentId;
    if (agentId) {
      useKookrStore.getState().selectAgent(agentId, activeDuplicate.taskId ?? activeDuplicate.id ?? null);
    }
    track({ type: 'launch_dialog_closed', submitted: false, dwellMs: Date.now() - openedAtRef.current });
    onClose();
  }

  useEscapeToClose(() => {
    if (showDropdown) {
      setShowDropdown(false);
    } else {
      onClose();
    }
  });

  function discardDraft() {
    clearLaunchTaskDialogDraft();
    setPrompt('');
    setCriteria('');
    setDraftRestored(false);
    track({ type: 'launch_dialog_draft_discarded' });
    promptRef.current?.focus();
  }

  function selectSuggestion(path: string) {
    setCwd(path);
    setShowDropdown(false);
    setHighlightIdx(-1);
    cwdRef.current?.focus();
    lastNonTypedCwdRef.current = path;
    track({ type: 'launch_dialog_cwd_field_used', method: 'mru' });
  }

  // serverCwd is always absolute (process.cwd() from the server), so the
  // pure suffix predicate is safe — no path canonicalization needed.
  const serverCwdTarget = endsWithProtectedSuffix(serverCwd)
    ? deriveParentRepoFromProtected(serverCwd)
    : serverCwd;
  const serverCwdProtected = endsWithProtectedSuffix(serverCwd);

  function useServerCwd() {
    setCwd(serverCwdTarget);
    cwdRef.current?.focus();
    lastNonTypedCwdRef.current = serverCwdTarget;
    track({ type: 'launch_dialog_cwd_field_used', method: 'server-cwd-button' });
  }

  function handleCwdKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showDropdown || suggestions.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIdx((prev) => (prev + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIdx((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
    } else if (e.key === 'Enter' && highlightIdx >= 0) {
      e.preventDefault();
      selectSuggestion(suggestions[highlightIdx].path);
    }
  }

  function getPlaybookSourceCwd(): string {
    // Catalog source follows the focused project's seeded cwd (see the
    // mount-time fetch above and #1019); falls back to serverCwd when empty.
    return cwd.trim() || serverCwd;
  }

  function getTaskTargetCwd(): string {
    if (projectContext) return cwd.trim();
    return cwd.trim() || serverCwd;
  }

  function switchToPlaybooks() {
    const targetCwd = getPlaybookSourceCwd();
    // A cached `absent` capability is treated as stale — see the mount-time
    // fetch above and rfc-capability-gated-playbook-params.md.
    const isFresh =
      playbooksLastFetchedCwd === targetCwd &&
      Date.now() - playbooksLastFetchedAt < PLAYBOOK_CACHE_TTL_MS &&
      playbooks.length > 0 &&
      !Object.values(hostCapabilities).some((c) => c === 'absent');

    setTab('playbooks');
    if (!isFresh) {
      setPlaybooksLoading(true);
      send({ type: 'listPlaybooks', cwd: targetCwd });
    }
  }

  return (
    <div className="dialog-overlay">
      <div
        ref={dialogRef}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="launch-task-dialog-title"
        tabIndex={-1}
      >
        <div className="dialog-header">
          <h3 id="launch-task-dialog-title">Launch New Task</h3>
          <button className="dialog-close" onClick={() => { track({ type: 'launch_dialog_closed', submitted: false, dwellMs: Date.now() - openedAtRef.current }); onClose(); }} aria-label="Close">&times;</button>
        </div>

        <div className="dialog-tabs">
          <button
            type="button"
            className={`dialog-tab ${tab === 'manual' ? 'active' : ''}`}
            onClick={() => setTab('manual')}
          >
            Manual
          </button>
          <button
            ref={playbooksTabRef}
            type="button"
            className={`dialog-tab ${tab === 'playbooks' ? 'active' : ''}`}
            onClick={switchToPlaybooks}
          >
            Playbooks
          </button>
        </div>

        {tab === 'manual' ? (
          <form onSubmit={handleSubmit}>
            {draftRestored && (
              <div className="draft-restored-banner" role="status">
                <span>Restored your last draft</span>
                <button
                  type="button"
                  className="link-button"
                  onClick={discardDraft}
                  aria-label="Discard restored draft"
                >
                  Discard draft
                </button>
              </div>
            )}
            <label>
              Task description
              <div className="input-with-voice">
                <textarea
                  ref={promptRef}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="e.g. Fix the auth bug in login.ts"
                  rows={3}
                  required
                />
                {sttUrl && (
                  <Suspense fallback={null}>
                    <VoiceInputButton inputId="launch-description" onTranscript={(text) => setPrompt(text)} shortcutBinding={sttShortcutBinding} />
                  </Suspense>
                )}
              </div>
            </label>
            <label>
              <div className="cwd-label-row">
                <span>Working directory</span>
                {cwd.trim() !== serverCwdTarget && (
                  <button
                    type="button"
                    className="link-button cwd-server-button"
                    onClick={useServerCwd}
                    title={
                      serverCwdProtected
                        ? `Server cwd is a protected worktree (${serverCwd}). Click to use main checkout: ${serverCwdTarget}`
                        : `Use server cwd: ${serverCwdTarget}`
                    }
                  >
                    {serverCwdProtected
                      ? `↩ Use main checkout (${serverCwdTarget})`
                      : `↩ Use server cwd (${serverCwdTarget})`}
                  </button>
                )}
              </div>
              <div className="combo-input">
                <input
                  ref={cwdRef}
                  type="text"
                  value={cwd}
                  onChange={(e) => {
                    setCwd(e.target.value);
                    setShowDropdown(true);
                    setHighlightIdx(-1);
                  }}
                  onFocus={() => {
                    if (suggestions.length > 0) setShowDropdown(true);
                  }}
                  onBlur={() => {
                    // Delay to allow click on dropdown item
                    setTimeout(() => setShowDropdown(false), 150);
                  }}
                  onKeyDown={handleCwdKeyDown}
                  placeholder="/home/user/my-project"
                  required
                  autoComplete="off"
                />
                {showDropdown && suggestions.length > 0 && (
                  <ul ref={dropdownRef} className="combo-dropdown" role="listbox">
                    {suggestions.map((suggestion, i) => (
                      <li
                        key={suggestion.path}
                        role="option"
                        aria-selected={i === highlightIdx}
                        className={i === highlightIdx ? 'highlighted' : ''}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          selectSuggestion(suggestion.path);
                        }}
                      >
                        {suggestion.path}
                        {suggestion.projectName && (
                          <span className="combo-dropdown-project">{suggestion.projectName}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {serverCwd && (cwd.trim() === serverCwd || cwd.trim() === serverCwdTarget) && (
                <span className="cwd-server-hint" role="note">
                  This is Kookr&apos;s own runtime checkout — agents launched here work on Kookr itself.
                </span>
              )}
            </label>
            <AgentTypeSelector
              value={agentType}
              onChange={(next) => {
                setAgentType(next);
                setEffort('');
                setModel('');
              }}
              options={agentOptions}
              roundRobinIndex={roundRobinIndex}
            />
            <LaunchEffortModelPickers
              agentType={agentType}
              effort={effort}
              model={model}
              onEffortChange={setEffort}
              onModelChange={setModel}
            />
            {showGrokAuthBanner && grokAuth?.message && (
              <GrokAuthPreflightBanner message={grokAuth.message} />
            )}
            {activeDuplicate && (
              <LaunchDuplicateBanner
                taskName={activeDuplicate.taskName ?? undefined}
                onOpenExisting={openExistingDuplicate}
                onLaunchAnyway={() => submitLaunch(true)}
              />
            )}
            <label>
              Completion criteria (optional)
              <div className="input-with-voice">
                <input
                  type="text"
                  value={criteria}
                  onChange={(e) => setCriteria(e.target.value)}
                  placeholder="e.g. Tests pass and PR created"
                />
                {sttUrl && (
                  <Suspense fallback={null}>
                    <VoiceInputButton inputId="launch-criteria" onTranscript={(text) => setCriteria(text)} shortcutBinding={sttShortcutBinding} />
                  </Suspense>
                )}
              </div>
            </label>
            <div className="dialog-actions">
              <button type="button" className="btn-secondary" onClick={() => { track({ type: 'launch_dialog_closed', submitted: false, dwellMs: Date.now() - openedAtRef.current }); onClose(); }}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn-primary"
                disabled={!prompt.trim() || !cwd.trim() || submitting || grokAuthBlocksLaunch || Boolean(activeDuplicate)}
                aria-describedby={[
                  showGrokAuthBanner ? GROK_AUTH_BANNER_ID : null,
                  activeDuplicate ? LAUNCH_DUPLICATE_BANNER_ID : null,
                ].filter(Boolean).join(' ') || undefined}
              >
                {submitting ? 'Launching...' : 'Launch'}
              </button>
            </div>
          </form>
        ) : (
          <PlaybookBrowser
            send={send}
            onClose={onClose}
            grokAuth={grokAuth}
            cwd={getTaskTargetCwd()}
            {...(projectContext
              ? {
                  playbookSourceCwd: getPlaybookSourceCwd(),
                  taskTargetCwd: getTaskTargetCwd(),
                  onTaskTargetCwdChange: setCwd,
                }
              : {})}
            relaunchPlaybookId={relaunchPlaybookId}
            relaunchParameterValues={relaunchParameterValues}
            projectContext={projectContext}
            onRequestEditCwd={() => {
              setTab('manual');
              // Defer focus past the React commit that mounts the manual
              // form's <input ref={cwdRef}>. Without the deferral, the focus
              // call runs while the playbooks tab is still mounted, the
              // input does not yet exist, and cwdRef.current is null.
              setTimeout(() => cwdRef.current?.focus(), 0);
            }}
          />
        )}
      </div>
    </div>
  );
}
