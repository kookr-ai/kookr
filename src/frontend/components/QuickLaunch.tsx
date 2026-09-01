import React, { useState, useRef, useEffect, useMemo, lazy, Suspense } from 'react';
import {
  buildAgentSelectionOptions,
  shouldDisableLaunchForGrokAuth,
  shouldShowGrokAuthBanner,
  type ClientMessage,
  type AgentSelection,
} from '../../shared/protocol.js';
import { useKookrStore } from '../store/useStore.js';
import { RecentPaths } from '../store/recent-paths.js';
import { loadLastAgentType, saveLastAgentType } from '../store/last-agent-type.js';
import { saveLastLaunchPins } from '../store/last-launch-pins.js';

import { AgentTypeSelector } from './AgentTypeSelector.js';
import { LaunchEffortModelPickers } from './LaunchEffortModelPickers.js';
import {
  effortOptionsForSelection,
  modelOptionsForSelection,
  optionalLaunchPins,
  restoreLastLaunchPins,
  sanitizeLaunchPins,
} from './launch-effort-model.js';
import { LAUNCH_DUPLICATE_BANNER_ID, LaunchDuplicateBanner } from './LaunchDuplicateBanner.js';
import type { ShortcutBinding } from '../../shared/contracts/shortcut-bindings.js';
import { getCompactTasks } from '../api/index.js';
import { findActiveLaunchDuplicate, withLaunchTaskCwds } from '../../shared/launch-duplicate.js';
import { useLaunchTaskCwds } from '../hooks/useLaunchTaskCwds.js';
import { useGrokAuthStatus } from '../hooks/useGrokAuthStatus.js';
import { GROK_AUTH_BANNER_ID, GrokAuthPreflightBanner } from './GrokAuthPreflightBanner.js';

const VoiceInputButton = lazy(() => import('./VoiceInputButton.js').then(m => ({ default: m.VoiceInputButton })));

const recentPaths = new RecentPaths();

interface Props {
  send: (msg: ClientMessage) => boolean;
  onClose: () => void;
  sttShortcutBinding?: ShortcutBinding;
}

export function QuickLaunch({ send, onClose, sttShortcutBinding }: Props) {
  const [prompt, setPrompt] = useState('');
  const [cwd, setCwd] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const preserveFailedDraftRef = useRef(false);
  const submitAttemptRef = useRef(0);
  const { selectedAgentId, serverCwd, sttUrl, activeSTTInputId, agents, availableAgentTypes, defaultAgentType, roundRobinIndex } = useKookrStore();
  // Same preflight the Launch dialog uses: it advertises whether a grok-build
  // launch would be refused and refreshes the rotation cursor on mount, so the
  // round-robin preview here stays honest (skips Grok when unusable) and does
  // not drift after a launch — parity with LaunchTaskDialog / PlaybookBrowser.
  const grokAuth = useGrokAuthStatus();
  const launchCwds = useLaunchTaskCwds();
  const duplicateCandidates = useMemo(
    () => withLaunchTaskCwds(agents, launchCwds),
    [agents, launchCwds],
  );
  const agentOptions = buildAgentSelectionOptions(availableAgentTypes);
  const availableAgentTypeIds = availableAgentTypes.map((entry) => entry.type);
  // Agent default chain (RFC F6, parity with LaunchTaskDialog): selected
  // agent type (effect) → last-used → server default → 'claude-code'.
  // Initializer covers the no-selected-agent path; the effect re-applies when
  // selection / availability / server default change.
  const [agentType, setAgentType] = useState<AgentSelection>(() => {
    const store = useKookrStore.getState();
    const options = buildAgentSelectionOptions(store.availableAgentTypes);
    const lastUsed = loadLastAgentType();
    if (lastUsed && options.some((opt) => opt.type === lastUsed)) return lastUsed;
    return store.defaultAgentType ?? 'claude-code';
  });
  const [initialPins] = useState(() => restoreLastLaunchPins(agentType));
  const [effort, setEffort] = useState(initialPins.effort);
  const [model, setModel] = useState(initialPins.model);

  // Resolve CWD: selected agent's task CWD > most recent path > server CWD
  useEffect(() => {
    if (preserveFailedDraftRef.current) return;
    let active = true;

    async function resolveCwd() {
      if (selectedAgentId) {
        try {
          // Compact list: this resolver only needs each task's cwd + session
          // tmuxSession, so it never downloads the full prompt bodies.
          const tasks = await getCompactTasks<Array<{ cwd: string; sessions: Array<{ tmuxSession: string }> }>>();
          const task = tasks.find((t) =>
            t.sessions.some((s) => s.tmuxSession === selectedAgentId)
          );
          if (task && active && !preserveFailedDraftRef.current) {
            setCwd(task.cwd);
            return;
          }
        } catch { /* ignore */ }
      }
      if (active && !preserveFailedDraftRef.current) {
        setCwd(recentPaths.getAll()[0] ?? serverCwd);
      }
    }

    resolveCwd();
    return () => { active = false; };
  }, [selectedAgentId, serverCwd]);

  useEffect(() => {
    if (preserveFailedDraftRef.current) return;
    const selected = agents.find((agent) => agent.agentId === selectedAgentId);
    if (selected?.agentType) {
      setAgentType(selected.agentType);
      return;
    }
    // RFC F6: last-used preference beats the server default when no selected
    // agent pins a type. Skip last-used when it is not currently offered.
    const options = buildAgentSelectionOptions(availableAgentTypes);
    const lastUsed = loadLastAgentType();
    if (lastUsed && options.some((opt) => opt.type === lastUsed)) {
      setAgentType(lastUsed);
      return;
    }
    setAgentType(defaultAgentType ?? 'claude-code');
  }, [agents, selectedAgentId, defaultAgentType, availableAgentTypes]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Selected-task / last-used effects can change the agent without the
  // picker onChange. Keep pins the new agent still accepts; drop the rest.
  useEffect(() => {
    setEffort((current) => sanitizeLaunchPins(agentType, current, '').effort);
    setModel((current) => sanitizeLaunchPins(agentType, '', current).model);
  }, [agentType]);

  const activeDuplicate = useMemo(
    () => findActiveLaunchDuplicate(duplicateCandidates, { prompt, cwd, agentType }),
    [duplicateCandidates, prompt, cwd, agentType],
  );
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
  ) && Boolean(grokAuth?.message);
  const visibleActiveDuplicate = grokAuthBlocksLaunch ? null : activeDuplicate;

  function submitLaunch(keepAsDuplicate: boolean) {
    const trimmed = prompt.trim();
    if (!trimmed || !cwd || grokAuthBlocksLaunch) return;
    if (!keepAsDuplicate && findActiveLaunchDuplicate(duplicateCandidates, { prompt: trimmed, cwd, agentType })) {
      return;
    }
    submitAttemptRef.current += 1;
    const excerpt = trimmed.slice(0, 40) + (trimmed.length > 40 ? '…' : '');
    const sent = send({
      type: 'launch',
      prompt: trimmed,
      cwd,
      agentType,
      ...optionalLaunchPins(effort, model),
      ...(keepAsDuplicate
        ? { disableDedup: true, metadataIntent: 'keep_as_duplicate' as const }
        : {}),
    });
    if (sent) {
      try {
        recentPaths.add(cwd);
      } catch {
        // Browser storage is best-effort; the launch was already dispatched.
      }
      saveLastAgentType(agentType);
      saveLastLaunchPins(effort, model);
      useKookrStore.getState().handleAlert('', `Launching task: ${excerpt}`, 'info');
      onClose();
    } else {
      preserveFailedDraftRef.current = true;
      useKookrStore.getState().handleAlert(
        '',
        `Could not start task: not connected. ${excerpt}`,
        'error',
      );
    }
  }

  function handleSubmit() {
    submitLaunch(false);
  }

  function openExistingDuplicate() {
    if (!activeDuplicate?.agentId) return;
    useKookrStore.getState().selectAgent(
      activeDuplicate.agentId,
      activeDuplicate.taskId ?? activeDuplicate.id ?? null,
    );
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && e.target === inputRef.current) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  }

  function handleBlur(e: React.FocusEvent) {
    // Don't close while STT is recording for this input — the mic button click causes blur
    if (activeSTTInputId === 'quick-launch') return;
    // Don't close if focus moved to a child element (e.g., mic button)
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    // Safari: clicking an in-bar button does not focus it, so relatedTarget is
    // null. Close on the next turn so the click can land before unmount.
    const bar = e.currentTarget;
    const submitAttemptAtBlur = submitAttemptRef.current;
    window.setTimeout(() => {
      if (!bar.isConnected) return;
      if (submitAttemptRef.current !== submitAttemptAtBlur) return;
      if (bar.contains(document.activeElement)) return;
      onClose();
    }, 0);
  }

  return (
    <div className="quick-launch-bar" onBlur={handleBlur} onKeyDown={handleKeyDown}>
      <div className="quick-launch-row">
        <span className="quick-launch-cwd" title={cwd}>{cwd}</span>
        <AgentTypeSelector
          value={agentType}
          onChange={setAgentType}
          options={agentOptions}
          label="Agent"
          compact
          roundRobinIndex={roundRobinIndex}
          grokAuthUsable={grokAuth ? !grokAuth.launchWouldRefuse : undefined}
        />
        {(effortOptionsForSelection(agentType).length > 0
          || modelOptionsForSelection(agentType).length > 0) && (
          <details className="quick-launch-pins">
            <summary>Pins</summary>
            <LaunchEffortModelPickers
              agentType={agentType}
              effort={effort}
              model={model}
              onEffortChange={setEffort}
              onModelChange={setModel}
              compact
            />
          </details>
        )}
        <input
          ref={inputRef}
          type="text"
          className="quick-launch-input"
          placeholder="Task prompt... (Enter to launch, Esc to cancel)"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          aria-describedby={[
            showGrokAuthBanner ? GROK_AUTH_BANNER_ID : null,
            visibleActiveDuplicate ? LAUNCH_DUPLICATE_BANNER_ID : null,
          ].filter(Boolean).join(' ') || undefined}
        />
        {sttUrl && (
          <Suspense fallback={null}>
            <VoiceInputButton inputId="quick-launch" onTranscript={(text) => setPrompt(text)} shortcutBinding={sttShortcutBinding} />
          </Suspense>
        )}
      </div>
      {showGrokAuthBanner && grokAuth?.message && (
        <GrokAuthPreflightBanner message={grokAuth.message} />
      )}
      {visibleActiveDuplicate && (
        <LaunchDuplicateBanner
          taskName={visibleActiveDuplicate.taskName ?? undefined}
          onOpenExisting={openExistingDuplicate}
          onLaunchAnyway={() => submitLaunch(true)}
        />
      )}
    </div>
  );
}
