import React, { useState, useRef, useEffect, lazy, Suspense } from 'react';
import { useKookrStore } from '../store/useStore.js';
import type { AgentState, ClientMessage, AutonomyLevel } from '../../shared/protocol.js';
import { isTerminalStatus } from '../../shared/contracts/task-status.js';
import type { TaskStatus } from '../../core/types.js';
import { track, trackClick } from '../telemetry.js';
import { TerminalPanel } from './TerminalPanel.js';
import { GitHubPanel } from './GitHubPanel.js';
import { ActivityPanel, type DiffClickTarget } from './ActivityPanel.js';
import { DiffPane } from './DiffPane.js';
import { formatDuration, formatCost, formatTokens, projectLabel, projectColor, formatBranch, agentProviderPresentation, worktreeHealthLabel, worktreeHealthTitle } from '../presentation.js';
import { SnoozeDialog } from './SnoozeDialog.js';
import { EffectiveHookSettingsModal } from './EffectiveHookSettingsModal.js';
import { shouldAutoFocusReply, anomalyTransitionKey } from './detail-panel-focus.js';
import { computeTerminalVisible } from './detail-panel-visibility.js';
import { TaskIdCopyButton } from './TaskIdCopyButton.js';

const VoiceInputButton = lazy(() => import('./VoiceInputButton.js').then(m => ({ default: m.VoiceInputButton })));
const NARROW_DETAIL_BREAKPOINT_PX = 1200;

/**
 * Exhaustive terminal-status check tolerant of the optional taskStatus.
 * Using the core helper here forces compile errors if TaskStatus grows.
 */
function isTerminalTaskStatus(status: TaskStatus | undefined): boolean {
  return status !== undefined && isTerminalStatus(status);
}

function agentProjectLabel(agent: AgentState): string {
  return agent.projectDisplayLabel ?? projectLabel(agent.cwd);
}

/** Strip markdown formatting artifacts from suggestion text */
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')  // **bold**
    .replace(/\*(.+?)\*/g, '$1')       // *italic*
    .replace(/`(.+?)`/g, '$1')         // `code`
    .replace(/^#+\s*/gm, '')           // # headings
    .replace(/^\s*[-*]\s+/gm, '')      // - bullet points
    .trim();
}

/** Truncate text with ellipsis */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '\u2026';
}

interface Props {
  agent: AgentState | null;
  send: (msg: ClientMessage) => boolean;
  onLaunch: () => void;
  collapsed?: boolean;
}

function EditableHeading({ agent, send }: { agent: AgentState; send: (msg: ClientMessage) => boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function startEditing() {
    setDraft(agent.taskName ?? agent.agentId);
    setEditing(true);
  }

  function commit() {
    if (agent.taskId && draft.trim()) {
      send({ type: 'renameTask', taskId: agent.taskId, name: draft.trim() });
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="detail-heading-edit"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }

  return (
    <h2 onDoubleClick={agent.taskId ? startEditing : undefined}>
      {agent.taskName ?? agent.agentId}
    </h2>
  );
}

function AgentProviderBadge({
  agentType,
  provider,
}: {
  agentType: NonNullable<AgentState['agentType']>;
  provider: ReturnType<typeof agentProviderPresentation>;
}) {
  const title = `${provider.label} by ${provider.provider}`;

  return (
    <span
      className={`detail-agent-provider detail-agent-provider--${agentType}`}
      title={title}
    >
      <svg className="detail-agent-provider-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d={provider.iconPath} />
      </svg>
      <span className="detail-agent-provider-label">{provider.label}</span>
      <span className="sr-only"> by {provider.provider}</span>
    </span>
  );
}

function DetailMetadataMenu({
  agent,
  provider,
  hookSettingsTriggerRef,
  onShowHookSettings,
}: {
  agent: AgentState;
  provider: ReturnType<typeof agentProviderPresentation> | null;
  hookSettingsTriggerRef: React.RefObject<HTMLButtonElement | null>;
  onShowHookSettings: () => void;
}) {
  const hasUsageCost = agent.tokenUsage && agent.tokenUsage.costUsd > 0;
  const hasTokenCount = agent.tokenUsage && (agent.tokenUsage.inputTokens + agent.tokenUsage.outputTokens) > 0;
  const hasProject = Boolean(agentProjectLabel(agent));
  const hasBranch = Boolean(agent.gitBranch || agent.gitCommit);
  const hasAgentType = Boolean(agent.agentType && provider);
  const hasAnyDetail = hasUsageCost || hasTokenCount || hasProject || hasBranch || hasAgentType;

  if (!hasAnyDetail) return null;

  return (
    <details className="detail-meta-menu">
      <summary>Details</summary>
      <div className="detail-meta-popover">
        {hasAgentType && agent.agentType && provider && (
          <div className="detail-meta-row">
            <span className="detail-meta-label">Agent</span>
            <span className="detail-agent-type-group">
              <AgentProviderBadge agentType={agent.agentType} provider={provider} />
              <button
                ref={hookSettingsTriggerRef}
                type="button"
                className="detail-hook-settings-btn"
                aria-label={`Hooks: view effective hook settings for ${provider.label} session`}
                title={`Hooks: view effective hook settings for ${provider.label} session`}
                onClick={onShowHookSettings}
              >
                hooks
              </button>
            </span>
          </div>
        )}
        {hasProject && (
          <div className="detail-meta-row">
            <span className="detail-meta-label">Project</span>
            <span className={`project-badge color-${projectColor(agent.projectId ?? agent.cwd)}`} title={agent.cwd}>
              {agentProjectLabel(agent)}
            </span>
          </div>
        )}
        {agent.gitBranch && (
          <div className="detail-meta-row">
            <span className="detail-meta-label">Branch</span>
            <span className="detail-branch" title={agent.gitIsWorktree ? `Worktree: ${agent.cwd}` : 'Git branch'}>
              {'\u2387'} {formatBranch(agent.gitBranch)}
              {agent.gitIsWorktree && <span className="worktree-badge">worktree</span>}
            </span>
          </div>
        )}
        {!agent.gitBranch && agent.gitCommit && (
          <div className="detail-meta-row">
            <span className="detail-meta-label">Revision</span>
            <span className="detail-branch detached" title="Detached HEAD">
              {'\u2387'} ({agent.gitCommit})
            </span>
          </div>
        )}
        {hasUsageCost && (
          <div className="detail-meta-row">
            <span className="detail-meta-label">Cost</span>
            <span className="detail-cost" title={`In: ${formatTokens(agent.tokenUsage!.inputTokens)} / Out: ${formatTokens(agent.tokenUsage!.outputTokens)}`}>
              {formatCost(agent.tokenUsage!.costUsd)}
            </span>
          </div>
        )}
        {hasTokenCount && (
          <div className="detail-meta-row">
            <span className="detail-meta-label">Tokens</span>
            <span className="detail-tokens">
              {formatTokens(agent.tokenUsage!.inputTokens + agent.tokenUsage!.outputTokens)} tok
            </span>
          </div>
        )}
      </div>
    </details>
  );
}

export function DetailPanel({ agent, send, onLaunch, collapsed }: Props) {
  const [input, setInput] = useState('');
  const [showSnooze, setShowSnooze] = useState(false);
  const [showHookSettings, setShowHookSettings] = useState(false);
  const hookSettingsTriggerRef = useRef<HTMLButtonElement>(null);
  const [permissionButtonsDisabled, setPermissionButtonsDisabled] = useState(false);
  const [isNarrowViewport, setIsNarrowViewport] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth <= NARROW_DETAIL_BREAKPOINT_PX : false,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const { selectAgent, nextBottleneck, snoozeAgent, setRelaunchTask, showSentOverlay, githubState, leftPane, setLeftPane, narrowTab, setNarrowTab, handleAlert, suggestions, clearSuggestion, setFocusZone, focusZone, sttUrl, respondAllAgentIds, setRespondAllAgentIds, shortcutsArmed, armShortcuts } = useKookrStore();
  const serverStartedAt = useKookrStore((s) => s.serverStartedAt);

  // Right-pane mode for the Activity+Terminal|Diff split. See
  // docs/rfc/rfc-activity-panel-ux.md §1.
  const [rightPane, setRightPane] = useState<'terminal' | 'diff'>('terminal');
  const [activeDiff, setActiveDiff] = useState<
    { agentId: string; toolUseId: string; filePath: string; openedAt: string | null } | null
  >(null);
  // Element that had focus when the diff opened — restored on close for a11y.
  const diffTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    function updateViewportMode() {
      setIsNarrowViewport(window.innerWidth <= NARROW_DETAIL_BREAKPOINT_PX);
    }

    updateViewportMode();
    window.addEventListener('resize', updateViewportMode);
    return () => window.removeEventListener('resize', updateViewportMode);
  }, []);

  // Clear diff state when the selected agent changes. Avoids showing stale diff
  // content bound to a different agent's toolUseId.
  useEffect(() => {
    setActiveDiff(null);
    setRightPane('terminal');
    diffTriggerRef.current = null;
  }, [agent?.agentId]);

  function handleOpenDiff(target: DiffClickTarget) {
    if (!agent) return;
    // Capture the trigger so we can restore focus when the diff closes.
    const active = document.activeElement;
    diffTriggerRef.current = active instanceof HTMLElement ? active : null;
    setActiveDiff({
      agentId: agent.agentId,
      toolUseId: target.toolUseId,
      filePath: target.filePath,
      openedAt: serverStartedAt,
    });
    setRightPane('diff');
  }

  function handleCloseDiff() {
    setRightPane('terminal');
    // Restore focus to the triggering element if it's still in the DOM.
    // Falls back to the Diff mode button if not.
    const trigger = diffTriggerRef.current;
    if (trigger && document.body.contains(trigger)) {
      trigger.focus();
    }
  }

  // While the Diff pane is active, intercept Escape at capture phase so it
  // closes the diff (our intent) instead of reaching the window-level handler
  // in App.tsx that would deselect the agent. When the diff is hidden,
  // Escape reverts to its normal global behavior.
  //
  // Route through handleCloseDiff so focus restoration (diffTriggerRef) runs
  // for keyboard dismissals the same way it does for the close button.
  const handleCloseDiffRef = useRef(handleCloseDiff);
  handleCloseDiffRef.current = handleCloseDiff;
  useEffect(() => {
    if (rightPane !== 'diff') return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        handleCloseDiffRef.current();
      }
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [rightPane]);

  // Auto-focus the reply input only on a real anomaly *transition* (null→type,
  // type-change, or agent-switch), and never while the user has an active text
  // selection. See `shouldAutoFocusReply` for the rule table.
  const prevAnomalyKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const currentKey = anomalyTransitionKey(agent?.agentId, agent?.anomaly?.type);
    const prevKey = prevAnomalyKeyRef.current;
    prevAnomalyKeyRef.current = currentKey;
    const selectionLength = window.getSelection()?.toString().length ?? 0;
    if (shouldAutoFocusReply({ currentKey, prevKey, selectionLength, activeElement: document.activeElement })) {
      inputRef.current?.focus();
    }
  }, [agent?.agentId, agent?.anomaly?.type]);

  // Clear input when selected agent changes — prevents stale text from being
  // accidentally sent to the wrong agent after an agent switch.
  const prevAgentIdRef = useRef(agent?.agentId);
  useEffect(() => {
    if (agent?.agentId !== prevAgentIdRef.current) {
      setInput('');
      prevAgentIdRef.current = agent?.agentId;
    }
  }, [agent?.agentId]);

  // Reset permission button disabled state when agent or suggestions change
  const suggestion = agent ? suggestions[agent.agentId] ?? null : null;
  useEffect(() => {
    setPermissionButtonsDisabled(false);
  }, [agent?.agentId, suggestion]);

  if (!agent) {
    const allAgents = useKookrStore.getState().agents;
    const findingsCount = allAgents.filter(a => a.anomaly !== null && !a.snoozedUntil && !a.suppressed).length;
    const totalCount = allAgents.length;

    return (
      <div className={`detail-panel kookr-tour-target-layout${collapsed ? ' collapsed' : ''}`}>
        <div className="detail-empty">
          {findingsCount > 0 ? (
            <p>{findingsCount} finding{findingsCount > 1 ? 's' : ''} need{findingsCount === 1 ? 's' : ''} attention.</p>
          ) : totalCount > 0 ? (
            <p className="findings-all-clear">All clear — agents working autonomously.</p>
          ) : (
            <p>No agents running.</p>
          )}
          <button className="btn-primary" onClick={onLaunch}>Launch New Task</button>
          <p className="detail-empty-hint">
            <kbd>Alt+L</kbd> quick launch
            {(findingsCount > 0 || totalCount > 0) && <> · <kbd>Alt+J</kbd>/<kbd>K</kbd> cycle tasks</>}
            {findingsCount > 0 && <> · <kbd>Alt+N</kbd> next finding</>}
          </p>
        </div>
      </div>
    );
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    setInput(e.target.value);
  }

  // Combine pattern-matched quick actions and AI suggestions into a unified button list
  const quickActions = suggestion
    ? [
        ...suggestion.quickActions.map(qa => ({ ...qa, isAi: false })),
        ...suggestion.suggestions
          .filter(s => !suggestion.quickActions.some(qa => qa.value === s))
          .map((s, i) => ({ label: stripMarkdown(truncate(s, 100)), value: s, isAi: true, shortcut: undefined as string | undefined })),
      ]
    : [];

  function handleQuickAction(value: string, isAi: boolean = false, shortcutKey?: string) {
    if (!agent) return;
    const agentName = agent.taskName ?? agent.agentId;
    const method = shortcutKey ? 'shortcut' : isAi ? 'suggestion' : 'quick_action';
    track({ type: 'response_sent', agentId: agent.agentId, method, charCount: value.length, anomalyType: agent.anomaly?.type ?? null });
    if (isAi) {
      track({ type: 'suggestion_accepted', agentId: agent.agentId });
    } else {
      track({ type: 'quick_action_clicked', agentId: agent.agentId, actionLabel: value.slice(0, 50) });
    }
    if (shortcutKey) {
      track({ type: 'shortcut_used', key: shortcutKey, action: 'quick_action', context: 'input_focused' });
    }
    let sent: boolean;
    if (respondAllAgentIds) {
      sent = send({ type: 'respondAll', agentIds: respondAllAgentIds, input: value });
      setRespondAllAgentIds(null);
    } else if (isDirectReply) {
      sent = send({ type: 'directReply', agentId: agent.agentId, input: value });
    } else {
      sent = send({ type: 'respond', agentId: agent.agentId, input: value });
    }
    if (!sent) {
      handleAlert('', 'Message not sent — connection lost. Please try again.', 'error');
      return;
    }
    setInput('');
    clearSuggestion(agent.agentId);
    showSentOverlay(agentName);
    if (!isDirectReply) {
      nextBottleneck();
    }
  }

  // Check if quick actions are permission-type (have keystroke field)
  const isPermissionActions = quickActions.length > 0 && 'keystroke' in (suggestion?.quickActions[0] ?? {});

  function handlePermissionChoice(keystroke: string) {
    if (!agent || permissionButtonsDisabled) return;
    setPermissionButtonsDisabled(true);
    track({ type: 'quick_action_clicked', agentId: agent.agentId, actionLabel: `permission:${keystroke}` });
    const sent = send({ type: 'permissionChoice', agentId: agent.agentId, keystroke });
    if (!sent) {
      setPermissionButtonsDisabled(false);
      handleAlert('', 'Message not sent — connection lost. Please try again.', 'error');
      return;
    }
    clearSuggestion(agent.agentId);
    const agentName = agent.taskName ?? agent.agentId;
    showSentOverlay(agentName);
    nextBottleneck();
  }

  const isDirectReply = !agent?.anomaly;

  function handleSendAndNext(viaShortcut: boolean = false) {
    if (!input.trim() || !agent) return;
    const agentName = agent.taskName ?? agent.agentId;
    track({ type: 'response_sent', agentId: agent.agentId, method: viaShortcut ? 'shortcut' : 'input_box', charCount: input.trim().length, anomalyType: agent.anomaly?.type ?? null });
    if (viaShortcut) {
      track({ type: 'shortcut_used', key: 'Enter', action: isDirectReply ? 'direct_reply' : 'send_and_next', context: 'input_focused' });
    }
    // If suggestion text was available but user typed their own, track as ignored
    if (suggestion && suggestion.suggestions.length > 0) {
      track({ type: 'suggestion_ignored', agentId: agent.agentId });
    }
    let sent: boolean;
    if (respondAllAgentIds) {
      sent = send({ type: 'respondAll', agentIds: respondAllAgentIds, input: input.trim() });
      setRespondAllAgentIds(null);
    } else if (isDirectReply) {
      sent = send({ type: 'directReply', agentId: agent.agentId, input: input.trim() });
    } else {
      sent = send({ type: 'respond', agentId: agent.agentId, input: input.trim() });
    }
    if (!sent) {
      handleAlert('', 'Message not sent — connection lost. Please try again.', 'error');
      return;
    }
    setInput('');
    clearSuggestion(agent.agentId);
    showSentOverlay(agentName);
    if (!isDirectReply) {
      nextBottleneck();
    }
  }

  function handleSkip() {
    if (!agent) return;
    track({ type: 'finding_skipped', agentId: agent.agentId, anomalyType: agent.anomaly?.type ?? null, method: 'button' });
    trackClick('skip');
    send({ type: 'skip', agentId: agent.agentId });
    nextBottleneck();
  }

  function handleSnooze(durationMs: number) {
    if (!agent) return;
    trackClick('snooze');
    send({ type: 'snooze', agentId: agent.agentId, durationMs });
    snoozeAgent(agent.agentId, durationMs);
  }

  async function handleRelaunch() {
    if (!agent) return;
    track({ type: 'task_relaunched', agentId: agent.agentId });

    // For playbook tasks, include playbook context so the launch dialog
    // can open the playbook form pre-filled with original parameter values
    if (agent.playbookId && agent.playbookParameterValues) {
      setRelaunchTask({
        prompt: agent.description ?? '',
        cwd: agent.cwd ?? '',
        agentType: agent.agentType,
        playbookId: agent.playbookId,
        playbookParameterValues: agent.playbookParameterValues,
      });
      return;
    }

    try {
      const res = await fetch('/api/tasks');
      if (!res.ok) return;
      const tasks = await res.json();
      // Find the task that owns this agent (tmux session name matches)
      const task = tasks.find((t: { sessions: Array<{ tmuxSession: string }> }) =>
        t.sessions.some((s: { tmuxSession: string }) => s.tmuxSession === agent.agentId)
      );
      if (task) {
        setRelaunchTask({ prompt: task.prompt, cwd: task.cwd, criteria: task.criteria, agentType: task.agentType });
      }
    } catch { /* ignore fetch errors */ }
  }

  function handleComplete() {
    if (!agent?.taskId) return;
    track({ type: 'task_completed', agentId: agent.agentId, method: 'button' });
    trackClick('complete_task');
    send({ type: 'completeTask', taskId: agent.taskId });
  }

  function handleCancel() {
    if (!agent?.taskId) return;
    if (!confirm(`Cancel task "${agent.taskName ?? agent.agentId}"? The agent session will be terminated.`)) return;
    track({ type: 'task_cancelled', agentId: agent.agentId, method: 'button' });
    trackClick('cancel_task');
    send({ type: 'cancelTask', taskId: agent.taskId });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    // Guard: skip Enter during IME composition (e.g., CJK input) or browser
    // autocomplete acceptance — these fire keydown with key='Enter' but the user
    // intends to confirm the composition, not to send the message.
    if (e.key === 'Enter' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSendAndNext(true);
      return;
    }
    // Number keys 1-5 trigger quick actions (only when input is empty AND shortcuts armed)
    if (!input && quickActions.length > 0 && shortcutsArmed && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= quickActions.length) {
        e.preventDefault();
        handleQuickAction(quickActions[num - 1].value, quickActions[num - 1].isAi, String(num));
        return;
      }
    }
    // Any non-number keypress = deliberate interaction → arm shortcuts
    armShortcuts();
  }

  const badgeClass = agent.anomaly
    ? agent.anomaly.type === 'permission_blocked' ? 'permission'
      : agent.anomaly.type === 'repeated_error' ? 'error'
      : 'input'
    : '';
  const badgeLabel = agent.anomaly
    ? agent.anomaly.type.replace('_', ' ').toUpperCase()
    : 'RUNNING';
  const agentProvider = agent.agentType ? agentProviderPresentation(agent.agentType) : null;

  return (
    <div className="detail-panel kookr-tour-target-layout">
      <div className="detail-header">
        <div className="detail-header-left">
          <EditableHeading agent={agent} send={send} />
          {agent.playbookId && <span className="detail-badge playbook">Playbook</span>}
          {agent.taskStatus === 'pending' && <span className="detail-badge pending">Pending</span>}
          {agent.anomaly && <span className={`detail-badge ${badgeClass}`}>{badgeLabel}</span>}
          {agent.taskId && agent.autonomy && !isTerminalTaskStatus(agent.taskStatus) && (
            <div className="detail-autonomy-toggle">
              <button
                className={`autonomy-option-sm${agent.autonomy === 'supervised' ? ' active' : ''}`}
                title="Supervised — pauses and waits for your input"
                onClick={() => send({ type: 'setAutonomy', taskId: agent.taskId!, level: 'supervised' })}
              >
                Supervised
              </button>
              <button
                className={`autonomy-option-sm${agent.autonomy === 'autonomous' ? ' active' : ''}`}
                title="Autonomous — auto-proceeds after 3 min when stopped"
                onClick={() => send({ type: 'setAutonomy', taskId: agent.taskId!, level: 'autonomous' })}
              >
                Autonomous
              </button>
            </div>
          )}
        </div>
        <div className="detail-header-right">
          <TaskIdCopyButton taskId={agent.taskId} />
          {agent.worktreeHealth && agent.worktreeHealth !== 'ok' && (
            <span className={`detail-header-warning worktree-health worktree-health--${agent.worktreeHealth}`} title={worktreeHealthTitle(agent.worktreeHealth, agent.worktreeRegistryStale)}>
              {worktreeHealthLabel(agent.worktreeHealth, agent.worktreeRegistryStale)}
            </span>
          )}
          {agent.startedAt && <span>{formatDuration(agent.startedAt)}</span>}
          <DetailMetadataMenu
            agent={agent}
            provider={agentProvider}
            hookSettingsTriggerRef={hookSettingsTriggerRef}
            onShowHookSettings={() => setShowHookSettings(true)}
          />
          {agent.taskId && agent.taskStatus !== 'pending' && !isTerminalTaskStatus(agent.taskStatus) && (
            <>
              <button data-testid="action-complete" className="action-btn action-btn--success" onClick={handleComplete}>Complete</button>
              <button data-testid="action-cancel" className="action-btn action-btn--danger" onClick={handleCancel}>Cancel</button>
            </>
          )}
          {agent.taskId && agent.taskStatus === 'pending' && (
            <button className="action-btn action-btn--danger" onClick={handleCancel}>Cancel</button>
          )}
          {/* Terminated tasks need an "Ack" (mark-as-done) button; completed / cancelled already have Reopen+Relaunch */}
          {agent.taskId && agent.taskStatus === 'terminated' && (
            <button
              className="action-btn action-btn--success"
              title="Acknowledge this terminated task — transitions it to Completed"
              onClick={() => send({ type: 'ackTerminatedTask', taskId: agent.taskId! })}
            >
              Mark as done
            </button>
          )}
          {agent.taskId && isTerminalTaskStatus(agent.taskStatus) && (
            <>
              <button className="action-btn action-btn--neutral" onClick={() => send({ type: 'reopenTask', taskId: agent.taskId! })}>Reopen</button>
              <button className="action-btn action-btn--neutral" onClick={handleRelaunch}>Relaunch</button>
            </>
          )}
        </div>
      </div>

      {/* Side-by-side split (wide) + tab fallback (narrow) */}
      {(() => {
        const gh = agent.taskId ? githubState[agent.taskId] : undefined;
        const ghCount = (gh?.prs.length ?? 0) + (gh?.issues.length ?? 0);
        const isCompleted = isTerminalTaskStatus(agent.taskStatus);
        const terminalVisible = computeTerminalVisible({ rightPane, isNarrowViewport, narrowTab });

        // Completion digest replaces both panes
        if (isCompleted && agent.completionDigest) {
          const digestHeading = agent.taskStatus === 'cancelled'
            ? 'Cancelled'
            : agent.taskStatus === 'terminated'
              ? 'Terminated'
              : 'Completed';
          return (
            <div className="detail-content">
              <div className="detail-digest">
                <h3>{digestHeading}</h3>
                <ul>
                  {agent.completionDigest.bullets.map((bullet, i) => (
                    <li key={i}>{bullet}</li>
                  ))}
                </ul>
                {agent.completionDigest.filesChanged.length > 0 && (
                  <div className="detail-digest-files">
                    <strong>Files changed:</strong> {agent.completionDigest.filesChanged.join(', ')}
                  </div>
                )}
              </div>
            </div>
          );
        }

        return (
          <>
            {/* Narrow-mode tab bar (hidden on wide viewports via CSS) */}
            <div className="detail-tabs-narrow">
              <button
                className={`detail-tab ${narrowTab === 'activity' ? 'active' : ''}`}
                onClick={() => { track({ type: 'tab_switched', from: narrowTab, to: 'activity' }); setNarrowTab('activity'); setLeftPane('activity'); }}
              >
                Activity
              </button>
              <button
                className={`detail-tab ${narrowTab === 'terminal' ? 'active' : ''}`}
                onClick={() => { track({ type: 'tab_switched', from: narrowTab, to: 'terminal' }); setNarrowTab('terminal'); }}
              >
                Terminal
              </button>
              {ghCount > 0 && (
                <button
                  className={`detail-tab ${narrowTab === 'github' ? 'active' : ''}`}
                  onClick={() => { track({ type: 'tab_switched', from: narrowTab, to: 'github' }); setNarrowTab('github'); setLeftPane('github'); }}
                >
                  GitHub ({ghCount})
                </button>
              )}
            </div>

            {/* Side-by-side split container */}
            <div className="detail-split">
              {/* Left pane: Activity or GitHub */}
              <div className={`detail-split-left${narrowTab !== 'activity' && narrowTab !== 'github' ? ' pane-hidden-narrow' : ''}`}>
                <div className="detail-pane-header">
                  <button
                    className={`pane-tab ${leftPane === 'activity' ? 'active' : ''}`}
                    aria-pressed={leftPane === 'activity'}
                    onClick={() => { track({ type: 'tab_switched', from: leftPane, to: 'activity' }); setLeftPane('activity'); setNarrowTab('activity'); }}
                  >
                    Activity
                  </button>
                  {ghCount > 0 && (
                    <button
                      className={`pane-tab ${leftPane === 'github' ? 'active' : ''}`}
                      aria-pressed={leftPane === 'github'}
                      onClick={() => { track({ type: 'tab_switched', from: leftPane, to: 'github' }); setLeftPane('github'); setNarrowTab('github'); }}
                    >
                      GitHub ({ghCount})
                    </button>
                  )}
                </div>
                {leftPane === 'github' && ghCount > 0 ? (
                  <GitHubPanel prs={gh?.prs ?? []} issues={gh?.issues ?? []} />
                ) : (
                  <ActivityPanel
                    events={agent.events}
                    anomalyExplanation={agent.anomaly?.explanation}
                    onOpenDiff={handleOpenDiff}
                  />
                )}
              </div>

              {/* Right pane: Terminal or Diff (terminal is always mounted so
                  xterm state and WebSocket connection survive mode toggles) */}
              <div className={`detail-split-right${narrowTab !== 'terminal' ? ' pane-hidden-narrow' : ''}`}>
                <div className="detail-pane-header">
                  <button
                    type="button"
                    className={`pane-tab ${rightPane === 'terminal' ? 'active' : ''}`}
                    aria-pressed={rightPane === 'terminal'}
                    onClick={() => setRightPane('terminal')}
                  >
                    Terminal
                  </button>
                  {activeDiff && (
                    <button
                      type="button"
                      className={`pane-tab ${rightPane === 'diff' ? 'active' : ''}`}
                      aria-pressed={rightPane === 'diff'}
                      onClick={() => setRightPane('diff')}
                    >
                      Diff
                    </button>
                  )}
                </div>
                <div className={`right-pane-stack right-pane-${rightPane}`}>
                  <div
                    className="right-pane-slot right-pane-slot-terminal"
                    style={{ display: rightPane === 'terminal' ? 'flex' : 'none' }}
                  >
                    <TerminalPanel tmuxName={agent.agentId} visible={terminalVisible} />
                  </div>
                  {activeDiff && (
                    <div
                      className="right-pane-slot right-pane-slot-diff"
                      style={{ display: rightPane === 'diff' ? 'flex' : 'none' }}
                    >
                      <DiffPane
                        agentId={activeDiff.agentId}
                        toolUseId={activeDiff.toolUseId}
                        filePath={activeDiff.filePath}
                        openedAt={activeDiff.openedAt}
                        onClose={handleCloseDiff}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        );
      })()}

      {/* Response area */}
      <div className={`response-area${focusZone === 'response-input' ? ' zone-active' : ''}${agent.anomaly?.type === 'needs_input' ? ' awaiting-input' : ''}`}>
        {respondAllAgentIds && (
          <div className="respond-all-banner">
            Responding to {respondAllAgentIds.length} agents
            <button className="btn-xs" onClick={() => setRespondAllAgentIds(null)}>Cancel</button>
          </div>
        )}
        {quickActions.length > 0 && (
          <div className="quick-actions">
            {isPermissionActions
              ? quickActions.map((action) => (
                <button
                  key={action.value}
                  className="btn-quick-action permission-action"
                  onClick={() => handlePermissionChoice((action as { keystroke: string }).keystroke)}
                  disabled={permissionButtonsDisabled}
                  title={action.value}
                >
                  <span>{action.label}</span>
                </button>
              ))
              : quickActions.map((action, i) => (
                <button
                  key={action.value}
                  className={`btn-quick-action${action.isAi ? ' ai-suggestion' : ''}`}
                  onClick={() => handleQuickAction(action.value, action.isAi)}
                  title={action.value.length > 100 ? action.value : undefined}
                >
                  <kbd>{action.shortcut ?? String(i + 1)}</kbd>
                  <span>{action.label}</span>
                </button>
              ))
            }
          </div>
        )}
        <div className="response-row">
          <input
            ref={inputRef}
            type="text"
            className=""
            autoComplete="off"
            placeholder={
              isDirectReply
                ? `Message ${agent.taskName ?? agent.agentId}...`
                : agent.anomaly?.type === 'needs_input'
                  ? `${agent.taskName ?? agent.agentId} is waiting — send a hint...`
                  : `Send a hint to ${agent.taskName ?? agent.agentId}...`
            }
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onMouseDown={armShortcuts}
            onFocus={() => { track({ type: 'focus_zone_changed', from: focusZone, to: 'response-input' }); setFocusZone('response-input'); }}
            onBlur={() => { if (focusZone === 'response-input') { track({ type: 'focus_zone_changed', from: 'response-input', to: 'none' }); setFocusZone('none'); } }}
          />
          {sttUrl && (
            <Suspense fallback={null}>
              <VoiceInputButton inputId="response-input" onTranscript={(text) => setInput(text)} disabled={!agent} />
            </Suspense>
          )}
          <button
            className="btn-primary"
            data-testid="send-button"
            onClick={() => handleSendAndNext()}
            disabled={!input.trim()}
          >
            {respondAllAgentIds ? `Send to All (${respondAllAgentIds.length})` : isDirectReply ? 'Send' : 'Send & Next'}
          </button>
          {!isDirectReply && <button className="btn-secondary" onClick={handleSkip}>Skip</button>}
          {!isDirectReply && <button className="btn-secondary" onClick={() => setShowSnooze(true)}>Snooze</button>}
        </div>
        {showSnooze && agent && (
          <SnoozeDialog
            agentId={agent.agentId}
            agentName={agent.taskName ?? agent.agentId}
            onSnooze={(durationMs) => { handleSnooze(durationMs); setShowSnooze(false); }}
            onClose={() => setShowSnooze(false)}
          />
        )}
        {showHookSettings && agent && (
          <EffectiveHookSettingsModal
            sessionId={agent.agentId}
            onClose={() => {
              setShowHookSettings(false);
              hookSettingsTriggerRef.current?.focus();
            }}
          />
        )}
      </div>
    </div>
  );
}
