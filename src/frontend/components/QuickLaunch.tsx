import React, { useState, useRef, useEffect, lazy, Suspense } from 'react';
import { buildAgentSelectionOptions, type ClientMessage, type AgentSelection } from '../../shared/protocol.js';
import { useKookrStore } from '../store/useStore.js';
import { RecentPaths } from '../store/recent-paths.js';
import { AgentTypeSelector } from './AgentTypeSelector.js';

const VoiceInputButton = lazy(() => import('./VoiceInputButton.js').then(m => ({ default: m.VoiceInputButton })));

const recentPaths = new RecentPaths();

interface Props {
  send: (msg: ClientMessage) => boolean;
  onClose: () => void;
}

export function QuickLaunch({ send, onClose }: Props) {
  const [prompt, setPrompt] = useState('');
  const [cwd, setCwd] = useState('');
  const [agentType, setAgentType] = useState<AgentSelection>('claude-code');
  const inputRef = useRef<HTMLInputElement>(null);
  const { selectedAgentId, serverCwd, sttUrl, activeSTTInputId, agents, availableAgentTypes, defaultAgentType } = useKookrStore();
  const agentOptions = buildAgentSelectionOptions(availableAgentTypes);

  // Resolve CWD: selected agent's task CWD > most recent path > server CWD
  useEffect(() => {
    let active = true;

    async function resolveCwd() {
      if (selectedAgentId) {
        try {
          const res = await fetch('/api/tasks');
          if (res.ok) {
            const tasks = await res.json();
            const task = tasks.find((t: { sessions: Array<{ tmuxSession: string }> }) =>
              t.sessions.some((s: { tmuxSession: string }) => s.tmuxSession === selectedAgentId)
            );
            if (task && active) {
              setCwd(task.cwd);
              return;
            }
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
    setAgentType(defaultAgentType ?? 'claude-code');
  }, [agents, selectedAgentId, defaultAgentType]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
    });
    if (sent) {
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
          <VoiceInputButton inputId="quick-launch" onTranscript={(text) => setPrompt(text)} />
        </Suspense>
      )}
    </div>
  );
}
