import React, { useState, useRef, useEffect, lazy, Suspense } from 'react';
import { buildAgentSelectionOptions, type ClientMessage, type AgentSelection } from '../../shared/protocol.js';
import { useKookrStore } from '../store/useStore.js';
import { RecentPaths } from '../store/recent-paths.js';
import { loadLastAgentType, saveLastAgentType } from '../store/last-agent-type.js';
import { AgentTypeSelector } from './AgentTypeSelector.js';
import { LaunchEffortModelPickers } from './LaunchEffortModelPickers.js';
import {
  effortOptionsForSelection,
  modelOptionsForSelection,
  optionalLaunchPins,
} from './launch-effort-model.js';
import type { ShortcutBinding } from '../../shared/contracts/shortcut-bindings.js';
import { getCompactTasks } from '../api/index.js';

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
  const { selectedAgentId, serverCwd, sttUrl, activeSTTInputId, agents, availableAgentTypes, defaultAgentType } = useKookrStore();
  const agentOptions = buildAgentSelectionOptions(availableAgentTypes);
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
  const [effort, setEffort] = useState('');
  const [model, setModel] = useState('');

  // Resolve CWD: selected agent's task CWD > most recent path > server CWD
  useEffect(() => {
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
          if (task && active) {
            setCwd(task.cwd);
            return;
          }
        } catch { /* ignore */ }
      }
      if (active) {
        setCwd(recentPaths.getAll()[0] ?? serverCwd);
      }
    }

    resolveCwd();
    return () => { active = false; };
  }, [selectedAgentId, serverCwd]);

  useEffect(() => {
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
  // picker onChange. Drop pins that would no longer match the resolved type.
  useEffect(() => {
    setEffort('');
    setModel('');
  }, [agentType]);

  function handleSubmit() {
    const trimmed = prompt.trim();
    if (!trimmed || !cwd) return;
    recentPaths.add(cwd);
    const excerpt = trimmed.slice(0, 40) + (trimmed.length > 40 ? '…' : '');
    const sent = send({
      type: 'launch',
      prompt: trimmed,
      cwd,
      agentType,
      ...optionalLaunchPins(effort, model),
    });
    if (sent) {
      saveLastAgentType(agentType);
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

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === 'Escape') {
      onClose();
    }
  }

  function handleBlur(e: React.FocusEvent) {
    // Don't close while STT is recording for this input — the mic button click causes blur
    if (activeSTTInputId === 'quick-launch') return;
    // Don't close if focus moved to a child element (e.g., mic button)
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    onClose();
  }

  return (
    <div className="quick-launch-bar" onBlur={handleBlur}>
      <span className="quick-launch-cwd" title={cwd}>{cwd}</span>
      <AgentTypeSelector
        value={agentType}
        onChange={setAgentType}
        options={agentOptions}
        label="Agent"
        compact
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
        onKeyDown={handleKeyDown}
      />
      {sttUrl && (
        <Suspense fallback={null}>
          <VoiceInputButton inputId="quick-launch" onTranscript={(text) => setPrompt(text)} shortcutBinding={sttShortcutBinding} />
        </Suspense>
      )}
    </div>
  );
}
