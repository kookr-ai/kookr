import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useKookrStore } from '../store/useStore.js';
import type { AgentState, ClientMessage, AutonomyLevel } from '../../shared/protocol.js';
import { track, trackClick } from '../telemetry.js';
import { agentProviderPresentation, formatDuration, formatAge, ageColor, healthyDotClass, healthyStatusLabel, formatTokenUsage, projectLabel, projectColor, formatBranch, worktreeHealthLabel, worktreeHealthTitle } from '../presentation.js';
import { Tooltip } from './Tooltip.js';
import { SnoozeDialog } from './SnoozeDialog.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { DetectionStatsPanel } from './DetectionStatsPanel.js';
import { CircuitBreakerPanel } from './CircuitBreakerPanel.js';
import { groupFindings, groupLabel } from '../group-findings.js';
import { ScheduleSection } from './ScheduleSection.js';
import { useDnd } from '../hooks/useDnd.js';
import { usePersistedCollapsed } from '../hooks/usePersistedCollapsed.js';

export const HEALTHY_SECTION_COLLAPSED_KEY = 'kookr:findingsPanel.healthy';
export const PENDING_SECTION_COLLAPSED_KEY = 'kookr:findingsPanel.pending';
export const SNOOZED_SECTION_COLLAPSED_KEY = 'kookr:findingsPanel.snoozed';
export const COMPLETED_SECTION_COLLAPSED_KEY = 'kookr:findingsPanel.completed';

interface Props {
  findings: AgentState[];
  healthy: AgentState[];
  pending: AgentState[];
  completed: AgentState[];
  snoozed: AgentState[];
  selectedAgentId: string | null;
  send: (msg: ClientMessage) => void;
  /**
   * Unfiltered counts used by the "Clear completed" confirm dialog. The server
   * sweeps across all projects — the dialog copy must match that scope, not
   * the currently-filtered view. See App.tsx for derivation.
   */
  globalFinishedCount: number;
  globalTerminatedCount: number;
}

function agentProjectLabel(agent: AgentState): string {
  return agent.projectDisplayLabel ?? projectLabel(agent.cwd);
}

function agentProjectColor(agent: AgentState): number {
  return projectColor(agent.projectId ?? agent.cwd);
}

// ─── Ralph loop helpers ──────────────────────────────────────────────────────

function RalphLoopBadge({ agent }: { agent: AgentState }): React.ReactElement | null {
  const loop = agent.ralphLoop;
  if (!loop) return null;
  return (
    <span
      className="ralph-loop-badge"
      title={`Ralph loop: iteration ${loop.currentIteration}/${loop.iterationCap} (${loop.status})`}
    >
      {loop.currentIteration}/{loop.iterationCap}
    </span>
  );
}

function RalphLoopControls({ agent }: { agent: AgentState }): React.ReactElement | null {
  const loop = agent.ralphLoop;
  if (!loop) return null;
  const taskId = agent.taskId;
  if (!taskId) return null;
  const { handleAlert } = useKookrStore.getState();

  const isActive = loop.status === 'running' || loop.status === 'paused';

  async function callEndpoint(path: string, method = 'POST') {
    try {
      const res = await fetch(path, { method });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        handleAlert('', data.error ?? `Server error ${res.status}`, 'error');
      }
    } catch (err) {
      handleAlert('', String(err), 'error');
    }
  }

  if (!isActive) return null;

  return (
    <span className="ralph-loop-controls" onClick={(e) => e.stopPropagation()}>
      <RalphLoopBadge agent={agent} />
      {loop.status === 'running' && (
        <button
          className="btn-xs ralph-btn"
          aria-label="Pause Ralph loop"
          onClick={() => callEndpoint(`/api/tasks/${taskId}/ralph-loop/pause`)}
        >Pause</button>
      )}
      {loop.status === 'paused' && (
        <button
          className="btn-xs ralph-btn"
          aria-label="Resume Ralph loop"
          onClick={() => callEndpoint(`/api/tasks/${taskId}/ralph-loop/resume`)}
        >Resume</button>
      )}
      <button
        className="btn-xs ralph-btn"
        aria-label="Cancel Ralph loop"
        onClick={() => callEndpoint(`/api/tasks/${taskId}/ralph-loop`, 'DELETE')}
      >Cancel</button>
    </span>
  );
}

function AttachRalphDialog({ taskId, onClose }: { taskId: string; onClose: () => void }): React.ReactElement {
  const { handleAlert } = useKookrStore.getState();
  const [prompt, setPrompt] = useState('');
  const [iterationCap, setIterationCap] = useState('');
  const [stopPredicate, setStopPredicate] = useState('');
  const [zeroDiff, setZeroDiff] = useState('');
  const [costCap, setCostCap] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (submitting) return;
    if (!prompt.trim()) return;

    setSubmitting(true);
    const cap = parseInt(iterationCap, 10);
    const body: Record<string, unknown> = {
      prompt: prompt.trim(),
    };
    if (Number.isInteger(cap)) body.iterationCap = cap;
    if (stopPredicate.trim()) body.stopPredicate = stopPredicate.trim();
    const zd = parseInt(zeroDiff, 10);
    if (Number.isInteger(zd) && zd > 0) body.zeroDiffConvergence = { consecutiveIterations: zd };
    const cc = parseFloat(costCap);
    if (isFinite(cc) && cc > 0) body.costCapUsd = cc;

    try {
      const res = await fetch(`/api/tasks/${taskId}/ralph-loop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        handleAlert('', 'Ralph loop attached', 'info');
        onClose();
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string };
        setError(data.error ?? `Server error ${res.status}`);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div role="dialog" aria-label="Attach Ralph loop" onClick={(e) => e.stopPropagation()}>
      <h4>Attach Ralph loop</h4>
      {error && <div role="alert" className="ralph-attach-error">{error}</div>}
      <form onSubmit={handleSubmit}>
        <label>
          Prompt
          <textarea
            id={`ralph-attach-prompt-${taskId}`}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            required
          />
        </label>
        <label>
          Iteration cap
          <input
            type="number"
            name="ralph-attach-iteration-cap"
            value={iterationCap}
            onChange={(e) => setIterationCap(e.target.value)}
            min={1}
            step={1}
            required
          />
        </label>
        <label>
          Stop predicate (optional)
          <input
            type="text"
            name="ralph-attach-stop-predicate"
            value={stopPredicate}
            onChange={(e) => setStopPredicate(e.target.value)}
          />
        </label>
        <label>
          Zero-diff threshold (optional)
          <input
            type="number"
            name="ralph-attach-zero-diff-threshold"
            value={zeroDiff}
            onChange={(e) => setZeroDiff(e.target.value)}
            min={1}
            step={1}
          />
        </label>
        <label>
          Cost cap USD (optional)
          <input
            type="number"
            name="ralph-attach-cost-cap"
            value={costCap}
            onChange={(e) => setCostCap(e.target.value)}
            min={0.01}
            step={0.01}
          />
        </label>
        <div>
          <button type="submit" disabled={submitting}>Attach</button>
          <button type="button" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

function AttachRalphButton({ agent }: { agent: AgentState }): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  if (!agent.taskId) return null;
  // Only offer attach when there is no loop at all (new or after terminal cleanup)
  if (agent.ralphLoop) return null;

  return (
    <>
      <button
        className="btn-xs ralph-btn"
        aria-label="Attach Ralph loop"
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
      >Ralph loop</button>
      {open && (
        <AttachRalphDialog
          taskId={agent.taskId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

// ─── End Ralph loop helpers ───────────────────────────────────────────────────

function severityClass(agent: AgentState): string {
  if (!agent.anomaly) return '';
  switch (agent.anomaly.type) {
    case 'permission_blocked': return 'permission';
    case 'repeated_error': return 'error';
    case 'needs_input': return 'input';
  }
}

function severityLabel(agent: AgentState): string {
  if (!agent.anomaly) return '';
  switch (agent.anomaly.type) {
    case 'permission_blocked': return 'Permission';
    case 'repeated_error': return 'Repeated Error';
    case 'needs_input': return 'Needs Input';
  }
}

function EditableName({ agent, send, onBeforeEdit }: {
  agent: AgentState;
  send: (msg: ClientMessage) => void;
  onBeforeEdit?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function startEditing(e: React.MouseEvent) {
    e.stopPropagation();
    onBeforeEdit?.();
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
        className="finding-task-edit"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          if (e.key === 'Escape') setEditing(false);
        }}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <div className="finding-task" onDoubleClick={agent.taskId ? startEditing : undefined}>
      {agent.taskName ?? agent.agentId}
    </div>
  );
}

function AutonomyBadge({ agent, send }: {
  agent: AgentState;
  send: (msg: ClientMessage) => void;
}) {
  if (!agent.taskId || !agent.autonomy) return null;
  const isAuto = agent.autonomy === 'autonomous';
  const nextLevel: AutonomyLevel = isAuto ? 'supervised' : 'autonomous';
  const title = isAuto
    ? 'Autonomous — auto-proceeds when stopped. Click to switch to supervised.'
    : 'Supervised — waits for your input. Click to switch to autonomous.';

  return (
    <span
      className={`autonomy-badge-inline ${isAuto ? 'auto' : 'supervised'}`}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        send({ type: 'setAutonomy', taskId: agent.taskId!, level: nextLevel });
      }}
    >
      {isAuto ? 'AUTO' : 'SUPERVISED'}
    </span>
  );
}

function AgentProviderMark({
  agent,
  state,
}: {
  agent: AgentState;
  state: 'running' | 'done' | 'pending' | 'snoozed' | 'completed' | 'cancelled' | 'terminated' | 'finding';
}): React.ReactElement {
  if (!agent.agentType) {
    return <span className={`agent-provider-mark agent-provider-mark--fallback agent-provider-mark--${state}`} aria-hidden="true" />;
  }

  const provider = agentProviderPresentation(agent.agentType);
  const title = `${provider.label} by ${provider.provider}`;

  return (
    <span
      className={`agent-provider-mark agent-provider-mark--${agent.agentType} agent-provider-mark--${state}`}
      title={title}
      role="img"
      aria-label={title}
    >
      <svg className="agent-provider-mark-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d={provider.iconPath} />
      </svg>
    </span>
  );
}

function formatAutoProceedCountdown(proceedAt: string): string {
  const remaining = Math.max(0, new Date(proceedAt).getTime() - Date.now());
  if (remaining === 0) return 'proceeding...';
  const totalSec = Math.ceil(remaining / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `auto-proceed in ${m}m ${s}s`;
  return `auto-proceed in ${s}s`;
}

function FindingCard({ agent, selected, send }: {
  agent: AgentState;
  selected: boolean;
  send: (msg: ClientMessage) => void;
}) {
  const [showSnooze, setShowSnooze] = useState(false);
  const { selectAgent, nextBottleneck } = useKookrStore();
  const selectedProject = useKookrStore((s) => s.selectedProject);
  const dnd = useDnd();
  const cls = severityClass(agent);
  const autoProceedingAt = agent.anomaly?.autoProceedingAt;
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const arrivedDuringDnd =
    dnd.enabled &&
    dnd.startedAt !== null &&
    agent.anomaly?.detectedAt !== undefined &&
    new Date(agent.anomaly.detectedAt).getTime() >= dnd.startedAt;

  // Clean up pending click timer on unmount
  useEffect(() => {
    return () => { if (clickTimer.current) clearTimeout(clickTimer.current); };
  }, []);

  // Tick every second to update countdown
  const [, setCountdownTick] = useState(0);
  useEffect(() => {
    if (!autoProceedingAt) return;
    const id = setInterval(() => setCountdownTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [autoProceedingAt]);

  function handleSkip() {
    track({ type: 'finding_skipped', agentId: agent.agentId, anomalyType: agent.anomaly?.type ?? null, method: 'button' });
    trackClick('skip');
    send({ type: 'skip', agentId: agent.agentId });
    nextBottleneck();
  }

  function handleFlagFP() {
    if (!agent.anomaly) return;
    trackClick('flag_fp');
    send({
      type: 'findingFeedback',
      agentId: agent.agentId,
      anomalyType: agent.anomaly.type,
      explanation: agent.anomaly.explanation,
      verdict: 'false_positive',
    });
    nextBottleneck();
  }

  function handleSnooze(durationMs: number) {
    trackClick('snooze');
    send({ type: 'snooze', agentId: agent.agentId, taskId: agent.taskId, durationMs });
  }

  const tooltipText = [agent.description, agent.anomaly?.explanation].filter(Boolean).join('\n\n');
  const showProjectBadge = !selectedProject || agent.projectId !== selectedProject;

  return (
    <Tooltip text={tooltipText}>
      <div
        className={`finding-card ${cls} ${selected ? 'selected' : ''}`}
        aria-current={selected ? 'true' : undefined}
        onClick={() => {
          if (selected || clickTimer.current) {
            // Already selected or a prior click is pending — no new timer needed.
            // Fire immediately if selected (no layout shift risk).
            if (selected) {
              track({ type: 'agent_clicked', agentId: agent.agentId, source: 'finding_card', anomalyType: agent.anomaly?.type ?? null });
              selectAgent(agent.agentId);
            }
            return;
          }
          // Delay selectAgent to allow dblclick on .finding-task to cancel it.
          // Without this, the first click causes a layout shift (detail panel appears)
          // that moves the card, breaking the second click of the dblclick.
          clickTimer.current = setTimeout(() => {
            track({ type: 'agent_clicked', agentId: agent.agentId, source: 'finding_card', anomalyType: agent.anomaly?.type ?? null });
            selectAgent(agent.agentId);
            clickTimer.current = null;
          }, 200);
        }}
      >
        <div className="finding-header">
          <span className="finding-header-left">
            <AgentProviderMark agent={agent} state="finding" />
            <span className={`finding-severity ${cls}`} aria-label={`${severityLabel(agent)}${agent.anomaly?.detectedAt && formatAge(agent.anomaly.detectedAt) ? `, waiting ${formatAge(agent.anomaly.detectedAt)}` : ''}`}>{severityLabel(agent)}</span>
            {arrivedDuringDnd && (
              <span
                className="dnd-arrived-badge"
                title="Arrived while Do Not Disturb was on"
                aria-label="Arrived while Do Not Disturb was on"
              >
                while away
              </span>
            )}
          </span>
          <span className="finding-meta">
            {autoProceedingAt ? (
              <span
                className="age-badge auto-proceed-badge"
                title="Click to cancel auto-proceed"
                onClick={(e) => {
                  e.stopPropagation();
                  send({ type: 'cancelAutoProceed', agentId: agent.agentId });
                }}
              >
                {formatAutoProceedCountdown(autoProceedingAt)}
              </span>
            ) : (
              agent.anomaly?.detectedAt && formatAge(agent.anomaly.detectedAt) && (
                <span className={`age-badge ${ageColor(agent.anomaly.detectedAt)}`}>
                  waiting {formatAge(agent.anomaly.detectedAt)}
                </span>
              )
            )}
          </span>
        </div>
        <EditableName agent={agent} send={send} onBeforeEdit={() => {
          if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
        }} />
        <div className="finding-context">
          {showProjectBadge && agentProjectLabel(agent) && (
            <span className={`project-badge color-${agentProjectColor(agent)}`} title={agent.cwd}>
              {agentProjectLabel(agent)}
            </span>
          )}
          {agent.worktreeHealth && agent.worktreeHealth !== 'ok' && (
            <span className={`worktree-health worktree-health--${agent.worktreeHealth}`} title={worktreeHealthTitle(agent.worktreeHealth, agent.worktreeRegistryStale)}>
              {worktreeHealthLabel(agent.worktreeHealth, agent.worktreeRegistryStale)}
            </span>
          )}
          {agent.gitBranch && (
            <>
              {agent.cwd && <span className="finding-context-sep">{'·'}</span>}
              <span className="branch-label" title={agent.gitIsWorktree ? `Worktree: ${agent.cwd}` : agent.gitBranch}>
                <span className="branch-icon">{'⎇'}</span>{formatBranch(agent.gitBranch)}
                {agent.gitIsWorktree && <span className="worktree-indicator" title="Git worktree">{'🌳'}</span>}
              </span>
            </>
          )}
          {!agent.gitBranch && agent.gitCommit && (
            <>
              {agent.cwd && <span className="finding-context-sep">{'·'}</span>}
              <span className="branch-label detached" title="Detached HEAD">
                <span className="branch-icon">{'⎇'}</span>({agent.gitCommit})
              </span>
            </>
          )}
          {(agent.cwd || agent.gitBranch || agent.gitCommit) && agent.autonomy && <span className="finding-context-sep">{'·'}</span>}
          <AutonomyBadge agent={agent} send={send} />
        </div>
        {agent.ralphLoop && (
          <div className="finding-loop-row" onClick={(e) => e.stopPropagation()}>
            <RalphLoopControls agent={agent} />
            {!agent.ralphLoop || (agent.ralphLoop.status !== 'running' && agent.ralphLoop.status !== 'paused') ? (
              <RalphLoopBadge agent={agent} />
            ) : null}
          </div>
        )}
        {agent.anomaly && (
          <div className="finding-explanation">{agent.anomaly.explanation}</div>
        )}
        {(agent.tokenUsage || agent.startedAt) && (
          <div className="finding-cost">
            {formatTokenUsage(agent.tokenUsage)}
            {agent.tokenUsage && agent.startedAt ? ' · ' : ''}
            {formatDuration(agent.startedAt)}
          </div>
        )}
        <div className="finding-actions">
          <button className="btn-xs" onClick={(e) => { e.stopPropagation(); handleSkip(); }}>Skip</button>
          <button className="btn-xs" onClick={(e) => { e.stopPropagation(); setShowSnooze(true); }}>Snooze</button>
          <button className="btn-xs btn-fp" onClick={(e) => { e.stopPropagation(); handleFlagFP(); }} title="Mark as false positive">Flag FP</button>
        </div>
        {showSnooze && (
          <SnoozeDialog
            agentId={agent.agentId}
            agentName={agent.taskName ?? agent.agentId}
            onSnooze={(durationMs) => { handleSnooze(durationMs); setShowSnooze(false); }}
            onClose={() => setShowSnooze(false)}
          />
        )}
      </div>
    </Tooltip>
  );
}

function HealthyRow({ agent, selected, send }: {
  agent: AgentState;
  selected: boolean;
  send: (msg: ClientMessage) => void;
}) {
  const [showSnooze, setShowSnooze] = useState(false);
  const selectedProject = useKookrStore((s) => s.selectedProject);
  const projectLabelText = agentProjectLabel(agent);
  const colorIdx = projectLabelText ? agentProjectColor(agent) : -1;
  const showProjectBadge = !selectedProject || agent.projectId !== selectedProject;

  function handleReply(e: React.MouseEvent) {
    e.stopPropagation();
    track({ type: 'agent_clicked', agentId: agent.agentId, source: 'reply_button', anomalyType: null });
    useKookrStore.getState().selectAgent(agent.agentId);
    // Focus the response input after React re-renders
    requestAnimationFrame(() => {
      const input = document.querySelector('.response-area input') as HTMLInputElement | null;
      input?.focus();
    });
  }

  function handleSnooze(durationMs: number) {
    trackClick('snooze');
    send({ type: 'snooze', agentId: agent.agentId, taskId: agent.taskId, durationMs });
  }

  return (
    <Tooltip text={agent.description}>
      <div
        className={`healthy-row${colorIdx >= 0 ? ` project-color-${colorIdx}` : ''}${selected ? ' selected' : ''}${healthyDotClass(agent.events) === 'running' ? ' running-accent' : ''}`}
        aria-current={selected ? 'true' : undefined}
        onClick={() => {
          track({ type: 'agent_clicked', agentId: agent.agentId, source: 'healthy_row', anomalyType: null });
          track({ type: 'healthy_agent_inspected', agentId: agent.agentId });
          useKookrStore.getState().selectAgent(agent.agentId);
        }}
      >
        <div className="healthy-row-top">
          <AgentProviderMark agent={agent} state={healthyDotClass(agent.events)} />
          {showProjectBadge && projectLabelText && (
            <span className={`project-badge color-${colorIdx}`} title={agent.cwd}>
              {projectLabelText}
            </span>
          )}
          {agent.worktreeHealth && agent.worktreeHealth !== 'ok' && (
            <span className={`worktree-health worktree-health--${agent.worktreeHealth}`} title={worktreeHealthTitle(agent.worktreeHealth, agent.worktreeRegistryStale)}>
              {worktreeHealthLabel(agent.worktreeHealth, agent.worktreeRegistryStale)}
            </span>
          )}
          {agent.gitBranch && (
            <span className="branch-label" title={agent.gitIsWorktree ? `Worktree: ${agent.cwd}` : agent.gitBranch}>
              <span className="branch-icon">{'⎇'}</span>{formatBranch(agent.gitBranch, 20)}
            </span>
          )}
          <AutonomyBadge agent={agent} send={send} />
          <span className="healthy-row-name" title={agent.taskName ?? agent.agentId}>
            {agent.taskName ?? agent.agentId}
          </span>
          <button
            className="btn-reply"
            data-testid="reply-button"
            onClick={handleReply}
            title={`Send message to ${agent.taskName ?? agent.agentId}`}
          >
            Reply
          </button>
          <button
            className="btn-reply"
            onClick={(e) => { e.stopPropagation(); setShowSnooze(true); }}
            title={`Snooze ${agent.taskName ?? agent.agentId}`}
          >
            Snooze
          </button>
        </div>
        <div className="healthy-row-details">
          <div className="healthy-row-controls">
            <RalphLoopControls agent={agent} />
            {agent.ralphLoop && agent.ralphLoop.status !== 'running' && agent.ralphLoop.status !== 'paused' && (
              <RalphLoopBadge agent={agent} />
            )}
            <AttachRalphButton agent={agent} />
          </div>
        </div>
        <div className="healthy-row-meta">
          {formatTokenUsage(agent.tokenUsage)}
          {agent.tokenUsage ? ' · ' : ''}
          {healthyStatusLabel(agent.events, agent.startedAt)}
        </div>
        {showSnooze && (
          <SnoozeDialog
            agentId={agent.agentId}
            agentName={agent.taskName ?? agent.agentId}
            onSnooze={(durationMs) => { handleSnooze(durationMs); setShowSnooze(false); }}
            onClose={() => setShowSnooze(false)}
          />
        )}
      </div>
    </Tooltip>
  );
}

function PlaybookGroup({ playbookId, agents, selectedAgentId, send }: {
  playbookId: string;
  agents: AgentState[];
  selectedAgentId: string | null;
  send: (msg: ClientMessage) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const latest = agents[0]; // Most recent iteration (agents sorted by startedAt descending)

  return (
    <div className="playbook-group">
      <div
        className="playbook-group-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="playbook-group-toggle">{expanded ? '▾' : '▸'}</span>
        <span className="playbook-group-name">{latest.taskName ?? playbookId}</span>
        <span className="playbook-group-count">{agents.length} runs</span>
      </div>
      {expanded && agents.map((agent) => (
        <HealthyRow
          key={agent.agentId}
          agent={agent}
          selected={agent.agentId === selectedAgentId}
          send={send}
        />
      ))}
      {!expanded && (
        <HealthyRow
          agent={latest}
          selected={latest.agentId === selectedAgentId}
          send={send}
        />
      )}
    </div>
  );
}

function FindingGroup({ type, agents, selectedAgentId, send }: {
  type: string;
  agents: AgentState[];
  selectedAgentId: string | null;
  send: (msg: ClientMessage) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { setRespondAllAgentIds, selectAgent } = useKookrStore();
  const cls = agents[0] ? severityClass(agents[0]) : '';

  function handleRespondAll(e: React.MouseEvent) {
    e.stopPropagation();
    const agentIds = agents.map(a => a.agentId);
    setRespondAllAgentIds(agentIds);
    // Select the first agent so the detail panel has context
    selectAgent(agents[0].agentId);
    // Re-set respondAllAgentIds since selectAgent clears it
    useKookrStore.getState().setRespondAllAgentIds(agentIds);
    trackClick('respond_all');
    // Focus the response input after React re-renders
    requestAnimationFrame(() => {
      const input = document.querySelector('.response-area input') as HTMLInputElement | null;
      input?.focus();
    });
  }

  function handleSkipAll(e: React.MouseEvent) {
    e.stopPropagation();
    trackClick('skip_all');
    send({ type: 'skipAll', agentIds: agents.map(a => a.agentId) });
  }

  return (
    <div className={`finding-group ${cls}`}>
      <div
        className="finding-group-header"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="finding-group-toggle">{expanded ? '▾' : '▸'}</span>
        <span className={`finding-severity ${cls}`}>{severityLabel(agents[0])}</span>
        <span className="finding-group-label">
          {agents.length} agents {groupLabel(type)}
        </span>
        <span className="finding-group-actions">
          <button className="btn-xs" onClick={handleSkipAll}>Skip All</button>
          <button className="btn-xs btn-primary-xs" onClick={handleRespondAll}>Respond to All</button>
        </span>
      </div>
      {expanded && agents.map((agent) => (
        <FindingCard
          key={agent.agentId}
          agent={agent}
          selected={agent.agentId === selectedAgentId}
          send={send}
        />
      ))}
    </div>
  );
}

function formatCountdown(snoozedUntil: number): string {
  const remaining = Math.max(0, snoozedUntil - Date.now());
  if (remaining === 0) return 'resuming...';
  const totalSec = Math.ceil(remaining / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `resumes in ${h}h ${m}m`;
  if (m > 0) return `resumes in ${m}m ${s}s`;
  return `resumes in ${s}s`;
}

function PendingRow({ agent, selected, send }: {
  agent: AgentState;
  selected: boolean;
  send: (msg: ClientMessage) => void;
}) {
  const projectLabelText = agentProjectLabel(agent);
  const colorIdx = projectLabelText ? agentProjectColor(agent) : -1;
  return (
    <Tooltip text={agent.description}>
      <div
        className={`pending-row${selected ? ' selected' : ''}`}
        aria-current={selected ? 'true' : undefined}
        onClick={() => {
          track({ type: 'agent_clicked', agentId: agent.agentId, source: 'pending_row', anomalyType: null });
          useKookrStore.getState().selectAgent(agent.agentId);
        }}
      >
        <div className="pending-row-top">
          <AgentProviderMark agent={agent} state="pending" />
          {projectLabelText && (
            <span className={`project-badge color-${colorIdx}`} title={agent.cwd}>
              {projectLabelText}
            </span>
          )}
          <AutonomyBadge agent={agent} send={send} />
          <span className="pending-row-name" title={agent.taskName ?? agent.agentId}>
            {agent.taskName ?? agent.agentId}
          </span>
        </div>
        <div className="pending-row-meta">
          Queued · waiting for slot
          {agent.taskId && (
            <button className="btn-xs btn-danger-xs" onClick={(e) => {
              e.stopPropagation();
              send({ type: 'cancelTask', taskId: agent.taskId! });
            }}>Cancel</button>
          )}
        </div>
      </div>
    </Tooltip>
  );
}

function SnoozedRow({ agent, selected, send }: {
  agent: AgentState;
  selected: boolean;
  send: (msg: ClientMessage) => void;
}) {
  const [, setTick] = useState(0);
  const projectLabelText = agentProjectLabel(agent);
  const colorIdx = projectLabelText ? agentProjectColor(agent) : -1;

  // Update countdown every second
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <Tooltip text={agent.description}>
      <div
        className={`snoozed-row${selected ? ' selected' : ''}`}
        aria-current={selected ? 'true' : undefined}
        onClick={() => {
          track({ type: 'agent_clicked', agentId: agent.agentId, source: 'snoozed_row', anomalyType: agent.anomaly?.type ?? null });
          useKookrStore.getState().selectAgent(agent.agentId);
        }}
      >
        <div className="snoozed-row-top">
          <AgentProviderMark agent={agent} state="snoozed" />
          {projectLabelText && (
            <span className={`project-badge color-${colorIdx}`} title={agent.cwd}>
              {projectLabelText}
            </span>
          )}
          <span className="snoozed-row-name" title={agent.taskName ?? agent.agentId}>
            {agent.taskName ?? agent.agentId}
          </span>
        </div>
        <div className="snoozed-countdown">
          {agent.suppressed ? 'Paused' : `Snoozed · ${formatCountdown(agent.snoozedUntil!)}`}
          {!agent.suppressed && (
            <button
              className="btn-xs"
              onClick={(e) => {
                e.stopPropagation();
                send({ type: 'cancelSnooze', agentId: agent.agentId, taskId: agent.taskId });
              }}
            >
              Resume now
            </button>
          )}
        </div>
      </div>
    </Tooltip>
  );
}

// Clear-completed control lives inside the Completed section header so the
// action is co-located with the content it acts on. Confirmation uses the
// shared modal ConfirmDialog — the familiar OK/Cancel shape matches the rest
// of the app (cancel/complete task dialogs) and gives Enter/Escape bindings
// for free. Default scope sweeps user-initiated terminal states (completed +
// cancelled); terminated is opt-in via the checkbox inside the dialog. See
// rfc-task-loss-prevention.md D2.
//
// Counts are GLOBAL (unfiltered by the current project selection) because
// the server's clearCompleted has no project scope — it sweeps across all
// projects. The dialog copy must match that scope, not the visible subset.
function ClearCompletedButton({ finishedCount, terminatedCount, send }: {
  finishedCount: number;
  terminatedCount: number;
  send: (msg: ClientMessage) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [includeTerminated, setIncludeTerminated] = useState(false);

  // Hide when there is nothing we would sweep by default. The "Clear completed"
  // label would otherwise promise an action that produces a silent no-op —
  // the exact failure mode this PR set out to eliminate. Terminated-only cases
  // are handled by the per-row Ack / Reopen flow, not by bulk sweep.
  if (finishedCount === 0) return null;

  const openConfirm = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIncludeTerminated(false);
    setConfirmOpen(true);
  };
  const cancelConfirm = () => setConfirmOpen(false);
  const confirmClear = () => {
    send({ type: 'clearCompleted', includeTerminated });
    setConfirmOpen(false);
  };

  return (
    <>
      <button
        className="btn-clear-completed"
        onClick={openConfirm}
        aria-label="Clear completed tasks"
        title="Remove finished tasks (completed and cancelled) from the list"
      >
        Clear
      </button>
      {confirmOpen && (
        <ConfirmDialog
          title="Clear completed tasks"
          message={`Delete ${finishedCount} finished task${finishedCount === 1 ? '' : 's'}?`}
          confirmLabel="Delete"
          confirmClass="btn-danger"
          onConfirm={confirmClear}
          onClose={cancelConfirm}
        >
          {terminatedCount > 0 && (
            <label className="clear-completed-include-terminated">
              <input
                type="checkbox"
                checked={includeTerminated}
                onChange={(e) => setIncludeTerminated(e.target.checked)}
              />
              Also delete {terminatedCount} terminated task{terminatedCount === 1 ? '' : 's'}
            </label>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}

function CompletedRow({ agent, selected, send }: {
  agent: AgentState;
  selected: boolean;
  send: (msg: ClientMessage) => void;
}) {
  const projectLabelText = agentProjectLabel(agent);
  const colorIdx = projectLabelText ? agentProjectColor(agent) : -1;
  const isCancelled = agent.taskStatus === 'cancelled';
  const isTerminated = agent.taskStatus === 'terminated';
  // The row's style variant: cancelled (user stopped), terminated (session died
  // without ack), or completed (default / user acknowledged). Keep CSS variants
  // aligned with rfc-task-loss-prevention D1.
  const rowVariant = isCancelled ? 'cancelled' : isTerminated ? 'terminated' : 'completed';

  return (
    <Tooltip text={agent.description}>
      <div
        className={`completed-row${selected ? ' selected' : ''} ${rowVariant}`}
        aria-current={selected ? 'true' : undefined}
        onClick={() => {
          track({ type: 'agent_clicked', agentId: agent.agentId, source: 'completed_row', anomalyType: null });
          useKookrStore.getState().selectAgent(agent.agentId);
        }}
      >
        <div className="completed-row-top">
          <AgentProviderMark agent={agent} state={rowVariant} />
          {projectLabelText && (
            <span className={`project-badge color-${colorIdx}`} title={agent.cwd}>
              {projectLabelText}
            </span>
          )}
          <span className="completed-row-name" title={agent.taskName ?? agent.agentId}>
            {agent.taskName ?? agent.agentId}
          </span>
          <span className="completed-row-meta">
            {isCancelled && <span className="completed-cancelled-label">cancelled</span>}
            {isCancelled && (agent.tokenUsage || agent.startedAt) && ' · '}
            {formatTokenUsage(agent.tokenUsage)}
            {agent.tokenUsage && agent.startedAt ? ' · ' : ''}
            {formatDuration(agent.startedAt)}
          </span>
          {agent.taskId && (
            <button className="btn-xs" onClick={(e) => {
              e.stopPropagation();
              send({ type: 'reopenTask', taskId: agent.taskId! });
            }}>Reopen</button>
          )}
        </div>
        {agent.ralphLoop && (
          <RalphLoopBadge agent={agent} />
        )}
        {agent.completionDigest && agent.completionDigest.bullets.length > 0 && (
          <ul className="completed-digest">
            {agent.completionDigest.bullets.map((bullet, i) => (
              <li key={i}>{bullet}</li>
            ))}
          </ul>
        )}
      </div>
    </Tooltip>
  );
}

/** Group healthy agents: playbook iterations are collapsed, standalone agents shown individually. */
function groupHealthyAgents(agents: AgentState[]): { standalone: AgentState[]; groups: Map<string, AgentState[]> } {
  const groups = new Map<string, AgentState[]>();
  const standalone: AgentState[] = [];

  for (const agent of agents) {
    if (agent.playbookId) {
      const list = groups.get(agent.playbookId) ?? [];
      list.push(agent);
      groups.set(agent.playbookId, list);
    } else {
      standalone.push(agent);
    }
  }

  // Only group if there are 2+ agents with the same playbookId
  const realGroups = new Map<string, AgentState[]>();
  for (const [id, list] of groups) {
    if (list.length >= 2) {
      // Sort by startedAt descending (most recent first)
      list.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
      realGroups.set(id, list);
    } else {
      standalone.push(...list);
    }
  }

  return { standalone, groups: realGroups };
}

export function FindingsPanel({ findings, healthy, pending, completed, snoozed, selectedAgentId, send, globalFinishedCount, globalTerminatedCount }: Props) {
  const { standalone, groups } = useMemo(() => groupHealthyAgents(healthy), [healthy]);
  const totalAgents = findings.length + healthy.length + pending.length + completed.length + snoozed.length;
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const prevFindingIds = useRef<Set<string>>(new Set());
  const [healthyCollapsed, toggleHealthy] = usePersistedCollapsed(HEALTHY_SECTION_COLLAPSED_KEY, false);
  const [pendingCollapsed, togglePending] = usePersistedCollapsed(PENDING_SECTION_COLLAPSED_KEY, false);
  const [snoozedCollapsed, toggleSnoozed] = usePersistedCollapsed(SNOOZED_SECTION_COLLAPSED_KEY, true);
  const [completedCollapsed, toggleCompleted] = usePersistedCollapsed(COMPLETED_SECTION_COLLAPSED_KEY, true);
  const [isInitialLoad, setIsInitialLoad] = useState(true);

  // Single tick counter to refresh age badges across all cards (every 60s)
  const [, setAgeTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setAgeTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Auto-scroll to top when a genuinely new finding arrives (ID-set comparison)
  // Suppressed during initial load so the user sees oldest-first without jarring scroll
  useEffect(() => {
    const currentIds = new Set(findings.map(f => f.agentId));
    const hasNew = findings.some(f => !prevFindingIds.current.has(f.agentId));
    prevFindingIds.current = currentIds;

    if (hasNew && !isInitialLoad) {
      const timer = setTimeout(() => {
        scrollAreaRef.current?.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior });
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [findings, isInitialLoad]);

  // Sort findings oldest-first on initial load, default order otherwise
  const displayFindings = useMemo(() => {
    if (!isInitialLoad) return findings;
    return [...findings].sort((a, b) => {
      const aTime = a.anomaly?.detectedAt ? new Date(a.anomaly.detectedAt).getTime() : 0;
      const bTime = b.anomaly?.detectedAt ? new Date(b.anomaly.detectedAt).getTime() : 0;
      return aTime - bTime;
    });
  }, [findings, isInitialLoad]);

  // Group findings by anomaly type when ≥3 share the same type
  const { ungrouped: ungroupedFindings, groups: findingGroups } = useMemo(
    () => groupFindings(displayFindings),
    [displayFindings],
  );

  function handlePanelClick(e: React.MouseEvent) {
    if (isInitialLoad) setIsInitialLoad(false);
    // Only deselect if clicking directly on the panel background, not on a child card/row
    if (e.target === e.currentTarget && selectedAgentId) {
      track({ type: 'agent_deselected', method: 'panel_click' });
      useKookrStore.getState().selectAgent(null);
    }
  }

  return (
    <div className="findings-panel kookr-tour-target-findings kookr-tour-target-layout" onClick={handlePanelClick}>
      <div className="findings-header">
        <span>Supervisor Findings</span>
        {findings.length > 0 && (
          <span className="findings-count">{findings.length} active</span>
        )}
      </div>
      <div className="findings-scroll-area" ref={scrollAreaRef}>
        {findings.length === 0 && totalAgents === 0 && (
          <div className="findings-empty">
            No agents running yet — launch one to begin.
          </div>
        )}
        {Array.from(findingGroups.entries()).map(([type, agents]) => (
          <FindingGroup
            key={`group-${type}`}
            type={type}
            agents={agents}
            selectedAgentId={selectedAgentId}
            send={send}
          />
        ))}
        {ungroupedFindings.map((agent) => (
          <FindingCard
            key={agent.agentId}
            agent={agent}
            selected={agent.agentId === selectedAgentId}
            send={send}
          />
        ))}
      </div>
      {(healthy.length > 0 || pending.length > 0 || snoozed.length > 0 || completed.length > 0) && (
        <div className="bottom-sections">
          {healthy.length > 0 && (
            <div className="healthy-section">
              <div className="section-header" onClick={toggleHealthy} aria-expanded={!healthyCollapsed}>
                <span className="section-chevron">{healthyCollapsed ? '▸' : '▾'}</span>
                <span className="healthy-label">Healthy ({healthy.length})</span>
              </div>
              {!healthyCollapsed && (
                <>
                  {Array.from(groups.entries()).map(([playbookId, agents]) => (
                    <PlaybookGroup
                      key={playbookId}
                      playbookId={playbookId}
                      agents={agents}
                      selectedAgentId={selectedAgentId}
                      send={send}
                    />
                  ))}
                  {standalone.map((agent) => (
                    <HealthyRow
                      key={agent.agentId}
                      agent={agent}
                      selected={agent.agentId === selectedAgentId}
                      send={send}
                    />
                  ))}
                </>
              )}
            </div>
          )}
          {pending.length > 0 && (
            <div className="pending-section">
              <div className="section-header" onClick={togglePending} aria-expanded={!pendingCollapsed}>
                <span className="section-chevron">{pendingCollapsed ? '▸' : '▾'}</span>
                <span className="pending-label">Pending ({pending.length})</span>
              </div>
              {!pendingCollapsed && pending.map((agent) => (
                <PendingRow
                  key={agent.agentId}
                  agent={agent}
                  selected={agent.agentId === selectedAgentId}
                  send={send}
                />
              ))}
            </div>
          )}
          {snoozed.length > 0 && (
            <div className="snoozed-section">
              <div className="section-header" onClick={toggleSnoozed} aria-expanded={!snoozedCollapsed}>
                <span className="section-chevron">{snoozedCollapsed ? '▸' : '▾'}</span>
                <span className="snoozed-label">Snoozed ({snoozed.length})</span>
              </div>
              {!snoozedCollapsed && snoozed.map((agent) => (
                <SnoozedRow
                  key={agent.agentId}
                  agent={agent}
                  selected={agent.agentId === selectedAgentId}
                  send={send}
                />
              ))}
            </div>
          )}
          {completed.length > 0 && (
            <div className="completed-section">
              <div className="section-header" onClick={toggleCompleted} aria-expanded={!completedCollapsed}>
                <span className="section-chevron">{completedCollapsed ? '▸' : '▾'}</span>
                <span className="completed-label">Completed ({completed.length})</span>
                <ClearCompletedButton
                  finishedCount={globalFinishedCount}
                  terminatedCount={globalTerminatedCount}
                  send={send}
                />
              </div>
              {!completedCollapsed && completed.map((agent) => (
                <CompletedRow
                  key={agent.agentId}
                  agent={agent}
                  selected={agent.agentId === selectedAgentId}
                  send={send}
                />
              ))}
            </div>
          )}
        </div>
      )}
      <ScheduleSection schedules={useKookrStore((s) => s.schedules)} />
      <DetectionStatsPanel />
      <CircuitBreakerPanel send={send} />
    </div>
  );
}
