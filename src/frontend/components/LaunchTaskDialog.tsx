import React, { useState, useRef, useEffect, useMemo, lazy, Suspense } from 'react';
import { AVAILABLE_AGENT_TYPES, type ClientMessage, type AutonomyLevel, type AgentType } from '../../shared/protocol.js';
import type { ProjectSummary } from '../../core/project-summary.js';
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

const VoiceInputButton = lazy(() => import('./VoiceInputButton.js').then(m => ({ default: m.VoiceInputButton })));

// Singleton so all dialog instances share the same MRU list
const recentPaths = new RecentPaths();

type Tab = 'manual' | 'playbooks';
type LaunchMode = 'normal' | 'ralph';

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
}

export function LaunchTaskDialog({ send, onClose, defaultCwd, defaultPrompt, defaultCriteria, defaultAgentType, relaunchPlaybookId, relaunchParameterValues, projectContext }: Props) {
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
  // `defaultAgentType` is intentionally absent: agentType is persisted under
  // its own key and is orthogonal to draft-vs-relaunch semantics.
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
  // blank on reopen.
  const resolvedInitialCwd =
    defaultCwd ?? (initialDraft?.cwd || recentPaths.getAll()[0] || serverCwd);
  const [prompt, setPrompt] = useState(defaultPrompt ?? initialDraft?.prompt ?? '');
  const [cwd, setCwd] = useState(resolvedInitialCwd);
  const [criteria, setCriteria] = useState(defaultCriteria ?? initialDraft?.criteria ?? '');
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const [tab, setTab] = useState<Tab>(relaunchPlaybookId || projectContext ? 'playbooks' : 'manual');
  const [launchMode, setLaunchMode] = useState<LaunchMode>('normal');
  const [ralphIterationCap, setRalphIterationCap] = useState('');
  const [ralphZeroDiffThreshold, setRalphZeroDiffThreshold] = useState('');
  const [ralphCostCap, setRalphCostCap] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [agentType, setAgentType] = useState<AgentType>(() => {
    const stored = localStorage.getItem('kookr:defaultAgentType') as AgentType | null;
    return defaultAgentType ?? stored ?? serverDefaultAgentType ?? 'claude-code';
  });
  const [autonomy, setAutonomy] = useState<AutonomyLevel>(() =>
    (localStorage.getItem('kookr:defaultAutonomy') as AutonomyLevel) || 'supervised'
  );
  const [draftRestored, setDraftRestored] = useState(initialHadDraft);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const cwdRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLUListElement>(null);
  const openedAtRef = useRef(Date.now());
  // Blocks the save effect from resurrecting the draft after a successful
  // submit sets the flag and synchronously clears the stored draft.
  const submittedRef = useRef(false);

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

  // When opening for playbook relaunch or project context, ensure playbook list is fetched
  useEffect(() => {
    if (relaunchPlaybookId || projectContext) {
      const targetCwd = cwd.trim() || serverCwd;
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

  const ralphCapParsed = parseInt(ralphIterationCap, 10);
  const isRalphCapValid = launchMode !== 'ralph' || (Number.isInteger(ralphCapParsed) && ralphCapParsed > 0);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || !cwd.trim() || submitting) return;

    if (launchMode === 'ralph') {
      setSubmitting(true);
      recentPaths.add(cwd.trim());
      track({ type: 'launch_submitted', method: 'ralph' });

      const body: Record<string, unknown> = {
        prompt: trimmed,
        cwd: cwd.trim(),
      };
      if (Number.isInteger(ralphCapParsed) && ralphCapParsed > 0) {
        body.iterationCap = ralphCapParsed;
      }
      const zeroDiff = parseInt(ralphZeroDiffThreshold, 10);
      if (Number.isInteger(zeroDiff) && zeroDiff > 0) {
        body.zeroDiffConvergence = { consecutiveIterations: zeroDiff };
      }
      const costCap = parseFloat(ralphCostCap);
      if (isFinite(costCap) && costCap > 0) {
        body.costCapUsd = costCap;
      }

      fetch('/api/tasks/ralph-loop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kookr-Launch-Source': 'ui' },
        body: JSON.stringify(body),
      }).then(async (res) => {
        setSubmitting(false);
        if (res.ok) {
          submittedRef.current = true;
          clearLaunchTaskDialogDraft();
          const excerpt = trimmed.slice(0, 40) + (trimmed.length > 40 ? '…' : '');
          useKookrStore.getState().handleAlert('', `Ralph loop started: ${excerpt}`, 'info');
          onClose();
        } else {
          const data = await res.json().catch(() => ({})) as { error?: string };
          const msg = data.error ?? `Server error ${res.status}`;
          useKookrStore.getState().handleAlert('', msg, 'error');
        }
      }).catch((err: unknown) => {
        setSubmitting(false);
        useKookrStore.getState().handleAlert('', String(err), 'error');
      });
      return;
    }

    setSubmitting(true);
    recentPaths.add(cwd.trim());
    track({ type: 'launch_submitted', method: 'manual' });
    track({ type: 'launch_dialog_closed', submitted: true, dwellMs: Date.now() - openedAtRef.current });
    localStorage.setItem('kookr:defaultAutonomy', autonomy);
    localStorage.setItem('kookr:defaultAgentType', agentType);
    const excerpt = trimmed.slice(0, 40) + (trimmed.length > 40 ? '…' : '');
    const sent = send({
      type: 'launch',
      prompt: trimmed,
      cwd: cwd.trim(),
      criteria: criteria.trim() || undefined,
      autonomy,
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

  function switchToPlaybooks() {
    const targetCwd = cwd.trim() || serverCwd;
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
          {tab === 'manual' && (
            <button
              type="button"
              className={`dialog-tab ralph-mode-toggle ${launchMode === 'ralph' ? 'active' : ''}`}
              aria-pressed={launchMode === 'ralph'}
              onClick={() => setLaunchMode((m) => m === 'ralph' ? 'normal' : 'ralph')}
              title="Ralph loop mode: re-runs the prompt after each agent stop"
            >
              Ralph loop
            </button>
          )}
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
              Working directory
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
            <label className="autonomy-toggle">
              <span className="autonomy-toggle-label">
                Autonomy
              </span>
              <div className="autonomy-options">
                <button
                  type="button"
                  className={`autonomy-option${autonomy === 'supervised' ? ' active' : ''}`}
                  onClick={() => setAutonomy('supervised')}
                >
                  Supervised
                </button>
                <button
                  type="button"
                  className={`autonomy-option${autonomy === 'autonomous' ? ' active' : ''}`}
                  onClick={() => setAutonomy('autonomous')}
                >
                  Autonomous
                </button>
              </div>
              <div className="autonomy-hint">
                {autonomy === 'supervised'
                  ? 'Pauses and waits for your input when the agent stops.'
                  : 'Auto-proceeds after 3 min when the agent stops (max 2 retries, then switches to supervised).'}
              </div>
            </label>
            {launchMode === 'ralph' && (
              <div className="ralph-fields">
                <label>
                  Iteration cap
                  <input
                    type="number"
                    name="ralph-iteration-cap"
                    value={ralphIterationCap}
                    onChange={(e) => setRalphIterationCap(e.target.value)}
                    placeholder="e.g. 10"
                    min={1}
                    step={1}
                    required
                  />
                </label>
                <label>
                  Zero-diff threshold (optional)
                  <input
                    type="number"
                    name="ralph-zero-diff-threshold"
                    value={ralphZeroDiffThreshold}
                    onChange={(e) => setRalphZeroDiffThreshold(e.target.value)}
                    placeholder="e.g. 3 consecutive zero-diff iterations"
                    min={1}
                    step={1}
                  />
                </label>
                <label>
                  Cost cap USD (optional)
                  <input
                    type="number"
                    name="ralph-cost-cap"
                    value={ralphCostCap}
                    onChange={(e) => setRalphCostCap(e.target.value)}
                    placeholder="e.g. 5.00"
                    min={0.01}
                    step={0.01}
                  />
                </label>
              </div>
            )}
            <div className="dialog-actions">
              <button type="button" className="btn-secondary" onClick={() => { track({ type: 'launch_dialog_closed', submitted: false, dwellMs: Date.now() - openedAtRef.current }); onClose(); }}>
                Cancel
              </button>
              <button type="submit" className="btn-primary" disabled={!prompt.trim() || !cwd.trim() || submitting || !isRalphCapValid}>
                {submitting ? 'Launching...' : launchMode === 'ralph' ? 'Launch Ralph loop' : 'Launch'}
              </button>
            </div>
          </form>
        ) : (
          <PlaybookBrowser
            send={send}
            onClose={onClose}
            cwd={cwd.trim() || serverCwd}
            relaunchPlaybookId={relaunchPlaybookId}
            relaunchParameterValues={relaunchParameterValues}
            projectContext={projectContext}
          />
        )}
      </div>
    </div>
  );
}
