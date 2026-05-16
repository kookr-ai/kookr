import React, { useState, useRef, useEffect, useMemo, lazy, Suspense } from 'react';
import { AVAILABLE_AGENT_TYPES, type ClientMessage, type AgentType } from '../../shared/protocol.js';
import type { ProjectSummary } from '../../shared/protocol.js';
import { useKookrStore } from '../store/useStore.js';
import { track } from '../telemetry.js';
import { RecentPaths } from '../store/recent-paths.js';
import {
  loadLaunchTaskDialogDraft,
  saveLaunchTaskDialogDraft,
  clearLaunchTaskDialogDraft,
} from '../store/launch-task-dialog-draft.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { PlaybookBrowser } from './PlaybookBrowser.js';
import { AgentTypeSelector } from './AgentTypeSelector.js';
import { endsWithProtectedSuffix, deriveParentRepoFromProtected } from '../../shared/contracts/worktree-protection.js';

const VoiceInputButton = lazy(() => import('./VoiceInputButton.js').then(m => ({ default: m.VoiceInputButton })));

// Singleton so all dialog instances share the same MRU list
const recentPaths = new RecentPaths();

type Tab = 'manual' | 'playbooks';

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
  /** Controls which launch surface is shown first when both manual and playbook context are valid. */
  initialTab?: Tab;
}

export function LaunchTaskDialog({ send, onClose, defaultCwd, defaultPrompt, defaultCriteria, defaultAgentType, relaunchPlaybookId, relaunchParameterValues, projectContext, projectCwd, initialTab: requestedInitialTab }: Props) {
  const serverCwd = useKookrStore((s) => s.serverCwd);
  const sttUrl = useKookrStore((s) => s.sttUrl);
  const availableAgentTypes = useKookrStore((s) => s.availableAgentTypes);
  const serverDefaultAgentType = useKookrStore((s) => s.defaultAgentType);
  const setPlaybooksLoading = useKookrStore((s) => s.setPlaybooksLoading);
  const playbooks = useKookrStore((s) => s.playbooks);
  const playbooksLastFetchedAt = useKookrStore((s) => s.playbooksLastFetchedAt);
  const playbooksLastFetchedCwd = useKookrStore((s) => s.playbooksLastFetchedCwd);
  const agentOptions = availableAgentTypes.length > 0
    ? availableAgentTypes
    : AVAILABLE_AGENT_TYPES;
  // Relaunch paths drive the form from props. In that mode we neither read
  // nor write the persisted draft — the relaunched task owns its own state.
  const isRelaunch = defaultPrompt != null || defaultCriteria != null || defaultCwd != null;
  const initialDraft = isRelaunch ? null : loadLaunchTaskDialogDraft();
  // Was this dialog opened with content hydrated from a stored draft? Recorded
  // once at mount so subsequent typing (which keeps writing to storage) does
  // not flip the indicator on/off. cwd alone doesn't count — see saveLaunchTaskDialogDraft
  // for the same "cwd is auto-populated, ignore it" rationale.
  const initialHadDraft = !isRelaunch && initialDraft != null
    && (initialDraft.prompt.trim().length > 0 || initialDraft.criteria.trim().length > 0);
  // `||` (not `??`) for the cwd fallback chain: a persisted empty-string cwd
  // must fall through to the recentPaths default rather than leave the field
  // blank on reopen. `projectCwd` slots above the draft so launching from a
  // project drawer overrides the persisted draft path with that project's cwd.
  const resolvedInitialCwd =
    defaultCwd ?? projectCwd ?? (initialDraft?.cwd || recentPaths.getAll()[0] || serverCwd);
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
  const [agentType, setAgentType] = useState<AgentType>(
    () => defaultAgentType ?? serverDefaultAgentType ?? 'claude-code',
  );
  const [draftRestored, setDraftRestored] = useState(initialHadDraft);
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

  // When opening directly to playbooks, ensure the list is fetched.
  useEffect(() => {
    if (relaunchPlaybookId || (projectContext && initialTab === 'playbooks')) {
      const targetCwd = projectContext ? serverCwd : (cwd.trim() || serverCwd);
      const isFresh =
        playbooksLastFetchedCwd === targetCwd &&
        Date.now() - playbooksLastFetchedAt < 30_000 &&
        playbooks.length > 0;
      if (!isFresh) {
        setPlaybooksLoading(true);
        send({ type: 'listPlaybooks', cwd: targetCwd });
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- run once on mount

  const suggestions = useMemo(() => recentPaths.filter(cwd), [cwd]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || !cwd.trim() || submitting) return;

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
    });
    if (sent) {
      // Set the ref *before* clearing so any pending save-effect re-run sees
      // it and early-returns instead of re-persisting the just-launched draft.
      submittedRef.current = true;
      clearLaunchTaskDialogDraft();
      useKookrStore.getState().handleAlert('', `Starting task: ${excerpt}`, 'info');
    } else {
      useKookrStore.getState().handleAlert(
        '',
        `Could not start task: not connected. ${excerpt}`,
        'error',
      );
    }
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
      selectSuggestion(suggestions[highlightIdx]);
    }
  }

  const PLAYBOOK_CACHE_TTL = 30_000;

  function getPlaybookSourceCwd(): string {
    return projectContext ? serverCwd : (cwd.trim() || serverCwd);
  }

  function getTaskTargetCwd(): string {
    if (projectContext) return cwd.trim();
    return cwd.trim() || serverCwd;
  }

  function switchToPlaybooks() {
    const targetCwd = getPlaybookSourceCwd();
    const isFresh =
      playbooksLastFetchedCwd === targetCwd &&
      Date.now() - playbooksLastFetchedAt < PLAYBOOK_CACHE_TTL &&
      playbooks.length > 0;

    setTab('playbooks');
    if (!isFresh) {
      setPlaybooksLoading(true);
      send({ type: 'listPlaybooks', cwd: targetCwd });
    }
  }

  return (
    <div className="dialog-overlay">
      <div className="dialog">
        <div className="dialog-header">
          <h3>Launch New Task</h3>
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
                    <VoiceInputButton inputId="launch-description" onTranscript={(text) => setPrompt(text)} />
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
                        ? `Server cwd is a protected worktree (${serverCwd}). Click to use parent repo: ${serverCwdTarget}`
                        : `Use server cwd: ${serverCwdTarget}`
                    }
                  >
                    {serverCwdProtected
                      ? `↩ Use parent of server cwd (${serverCwdTarget})`
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
                    {suggestions.map((path, i) => (
                      <li
                        key={path}
                        role="option"
                        aria-selected={i === highlightIdx}
                        className={i === highlightIdx ? 'highlighted' : ''}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          selectSuggestion(path);
                        }}
                      >
                        {path}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </label>
            <AgentTypeSelector
              value={agentType}
              onChange={setAgentType}
              options={agentOptions}
            />
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
                    <VoiceInputButton inputId="launch-criteria" onTranscript={(text) => setCriteria(text)} />
                  </Suspense>
                )}
              </div>
            </label>
            <div className="dialog-actions">
              <button type="button" className="btn-secondary" onClick={() => { track({ type: 'launch_dialog_closed', submitted: false, dwellMs: Date.now() - openedAtRef.current }); onClose(); }}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={!prompt.trim() || !cwd.trim() || submitting}>
                {submitting ? 'Launching...' : 'Launch'}
              </button>
            </div>
          </form>
        ) : (
          <PlaybookBrowser
            send={send}
            onClose={onClose}
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
