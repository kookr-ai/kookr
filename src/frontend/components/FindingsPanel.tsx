import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useKookrStore } from '../store/useStore.js';
import type { AgentState, ClientMessage, AutonomyLevel } from '../../shared/protocol.js';
import { track, trackClick } from '../telemetry.js';
import { formatDuration, formatAge, ageColor, healthyDotClass, healthyStatusLabel, copyAttachCommand, formatTokenUsage, projectLabel, projectColor, formatBranch } from '../presentation.js';
import { Tooltip } from './Tooltip.js';
import { SnoozeDialog } from './SnoozeDialog.js';
import { DetectionStatsPanel } from './DetectionStatsPanel.js';
import { CircuitBreakerPanel } from './CircuitBreakerPanel.js';
import { groupFindings, groupLabel } from '../group-findings.js';
import { ScheduleSection } from './ScheduleSection.js';

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
  const { selectAgent, nextBottleneck, snoozeAgent, handleAlert } = useKookrStore();
  const cls = severityClass(agent);
  const autoProceedingAt = agent.anomaly?.autoProceedingAt;
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    send({ type: 'snooze', agentId: agent.agentId, durationMs });
    snoozeAgent(agent.agentId, durationMs);
  }

  const tooltipText = [agent.description, agent.anomaly?.explanation].filter(Boolean).join('\n\n');

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
          <span className={`finding-severity ${cls}`} aria-label={`${severityLabel(agent)}${agent.anomaly?.detectedAt && formatAge(agent.anomaly.detectedAt) ? `, waiting ${formatAge(agent.anomaly.detectedAt)}` : ''}`}>{severityLabel(agent)}</span>
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
          {agent.cwd && (
            <span className={`project-badge color-${projectColor(agent.cwd)}`} title={agent.cwd}>
              {projectLabel(agent.cwd)}
            </span>
          )}
          {agent.gitBranch && (
            <>
              {agent.cwd && <span className="finding-context-sep">{'\u00B7'}</span>}
              <span className="branch-label" title={agent.gitIsWorktree ? `Worktree: ${agent.cwd}` : agent.gitBranch}>
                <span className="branch-icon">{'\u2387'}</span>{formatBranch(agent.gitBranch)}
                {agent.gitIsWorktree && <span className="worktree-indicator" title="Git worktree">{'\uD83C\uDF33'}</span>}
              </span>
            </>
          )}
          {!agent.gitBranch && agent.gitCommit && (
            <>
              {agent.cwd && <span className="finding-context-sep">{'\u00B7'}</span>}
              <span className="branch-label detached" title="Detached HEAD">
                <span className="branch-icon">{'\u2387'}</span>({agent.gitCommit})
              </span>
            </>
          )}
          {(agent.cwd || agent.gitBranch || agent.gitCommit) && agent.autonomy && <span className="finding-context-sep">{'\u00B7'}</span>}
          <AutonomyBadge agent={agent} send={send} />
        </div>
        {agent.anomaly && (
          <div className="finding-explanation">{agent.anomaly.explanation}</div>
        )}
        {(agent.tokenUsage || agent.startedAt) && (
          <div className="finding-cost">
            {formatTokenUsage(agent.tokenUsage)}
            {agent.tokenUsage && agent.startedAt ? ' \u00B7 ' : ''}
            {formatDuration(agent.startedAt)}
          </div>
        )}
        <div className="finding-actions">
          <button className="btn-xs" onClick={(e) => { e.stopPropagation(); handleSkip(); }}>Skip</button>
          <button className="btn-xs" onClick={(e) => { e.stopPropagation(); setShowSnooze(true); }}>Snooze</button>
          <button className="btn-xs btn-fp" onClick={(e) => { e.stopPropagation(); handleFlagFP(); }} title="Mark as false positive">Flag FP</button>
          <button className="btn-xs" onClick={(e) => {
            e.stopPropagation();
            copyAttachCommand(agent.agentId, handleAlert);
          }}>Attach</button>
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
  const colorIdx = agent.cwd ? projectColor(agent.cwd) : -1;

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
          <span className="healthy-dot-wrap">
            <span className={`healthy-dot ${healthyDotClass(agent.events)}`} />
            {healthyDotClass(agent.events) === 'running' && <span className="healthy-dot-ring" />}
          </span>
          {agent.cwd && (
            <span className={`project-badge color-${colorIdx}`} title={agent.cwd}>
              {projectLabel(agent.cwd)}
            </span>
          )}
          {agent.gitBranch && (
            <span className="branch-label" title={agent.gitIsWorktree ? `Worktree: ${agent.cwd}` : agent.gitBranch}>
              <span className="branch-icon">{'\u2387'}</span>{formatBranch(agent.gitBranch, 20)}
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
        </div>
        <div className="healthy-row-meta">
          {formatTokenUsage(agent.tokenUsage)}
          {agent.tokenUsage ? ' · ' : ''}
          {healthyStatusLabel(agent.events, agent.startedAt)}
        </div>
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
        <span className="playbook-group-toggle">{expanded ? '\u25BE' : '\u25B8'}</span>
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
        <span className="finding-group-toggle">{expanded ? '\u25BE' : '\u25B8'}</span>
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
  const colorIdx = agent.cwd ? projectColor(agent.cwd) : -1;
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
          <span className="pending-dot" />
          {agent.cwd && (
            <span className={`project-badge color-${colorIdx}`} title={agent.cwd}>
              {projectLabel(agent.cwd)}
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

function SnoozedRow({ agent, selected }: {
  agent: AgentState;
  selected: boolean;
}) {
  const [, setTick] = useState(0);
  const colorIdx = agent.cwd ? projectColor(agent.cwd) : -1;

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
          <span className="snoozed-dot" />
          {agent.cwd && (
            <span className={`project-badge color-${colorIdx}`} title={agent.cwd}>
              {projectLabel(agent.cwd)}
            </span>
          )}
          <span className="snoozed-row-name" title={agent.taskName ?? agent.agentId}>
            {agent.taskName ?? agent.agentId}
          </span>
        </div>
        <div className="snoozed-countdown">
          {agent.suppressed ? 'Paused' : `Snoozed · ${formatCountdown(agent.snoozedUntil!)}`}
        </div>
      </div>
    </Tooltip>
  );
}

// Clear-completed control lives inside the Completed section header so the
// action is co-located with the content it acts on. Default scope sweeps
// user-initiated terminal states (completed + cancelled); terminated is an
// opt-in via the inline checkbox. See rfc-task-loss-prevention.md D2.
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
  const cancelConfirm = (e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmOpen(false);
  };
  const confirmClear = (e: React.MouseEvent) => {
    e.stopPropagation();
    send({ type: 'clearCompleted', includeTerminated });
    setConfirmOpen(false);
  };

  if (!confirmOpen) {
    return (
      <button
        className="btn-clear-completed"
        onClick={openConfirm}
        aria-label="Clear completed tasks"
        title="Remove finished tasks (completed and cancelled) from the list"
      >
        Clear
      </button>
    );
  }

  // Note: no role="dialog" here. This is an inline disclosure, not a modal —
  // there is no focus trap, no Escape-to-close, and focus stays in reading
  // order. Labelling it dialog would mislead assistive tech. role="group"
  // gives a labelled boundary without the modal contract.
  return (
    <span
      className="clear-completed-confirm"
      role="group"
      aria-label="Confirm clear completed"
      onClick={(e) => e.stopPropagation()}
    >
      <span className="clear-completed-confirm-copy">
        Delete {finishedCount} finished task{finishedCount === 1 ? '' : 's'}?
      </span>
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
      <button className="btn-clear-completed-confirm" onClick={confirmClear}>Confirm</button>
      <button className="btn-clear-completed-cancel" onClick={cancelConfirm}>Cancel</button>
    </span>
  );
}

function CompletedRow({ agent, selected, send }: {
  agent: AgentState;
  selected: boolean;
  send: (msg: ClientMessage) => void;
}) {
  const colorIdx = agent.cwd ? projectColor(agent.cwd) : -1;
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
          <span className={`task-status-dot ${rowVariant}`} aria-label={rowVariant} />
          {agent.cwd && (
            <span className={`project-badge color-${colorIdx}`} title={agent.cwd}>
              {projectLabel(agent.cwd)}
            </span>
          )}
          <span className="completed-row-name" title={agent.taskName ?? agent.agentId}>
            {agent.taskName ?? agent.agentId}
          </span>
          <span className="completed-row-meta">
            {isCancelled && <span className="completed-cancelled-label">cancelled</span>}
            {isCancelled && (agent.tokenUsage || agent.startedAt) && ' \u00B7 '}
            {formatTokenUsage(agent.tokenUsage)}
            {agent.tokenUsage && agent.startedAt ? ' \u00B7 ' : ''}
            {formatDuration(agent.startedAt)}
          </span>
          {agent.taskId && (
            <button className="btn-xs" onClick={(e) => {
              e.stopPropagation();
              send({ type: 'reopenTask', taskId: agent.taskId! });
            }}>Reopen</button>
          )}
        </div>
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
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [isInitialLoad, setIsInitialLoad] = useState(true);

  // Single tick counter to refresh age badges across all cards (every 60s)
  const [, setAgeTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setAgeTick(t => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  function toggleSection(section: string) {
    setCollapsed(prev => ({ ...prev, [section]: !prev[section] }));
  }

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
    <div className="findings-panel" onClick={handlePanelClick}>
      <div className="findings-header">
        <span>Supervisor Findings</span>
        {findings.length > 0 && (
          <span className="findings-count">{findings.length} active</span>
        )}
      </div>
      <div className="findings-scroll-area" ref={scrollAreaRef}>
        {findings.length === 0 && totalAgents === 0 && (
          <div className="findings-empty">
            No agents running. Click <strong>+ Launch</strong> to start one.
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
              <div className="section-header" onClick={() => toggleSection('healthy')}>
                <span className="section-chevron">{collapsed.healthy ? '\u25B8' : '\u25BE'}</span>
                <span className="healthy-label">Healthy ({healthy.length})</span>
              </div>
              {!collapsed.healthy && (
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
              <div className="section-header" onClick={() => toggleSection('pending')}>
                <span className="section-chevron">{collapsed.pending ? '\u25B8' : '\u25BE'}</span>
                <span className="pending-label">Pending ({pending.length})</span>
              </div>
              {!collapsed.pending && pending.map((agent) => (
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
              <div className="section-header" onClick={() => toggleSection('snoozed')}>
                <span className="section-chevron">{collapsed.snoozed ? '\u25B8' : '\u25BE'}</span>
                <span className="snoozed-label">Snoozed ({snoozed.length})</span>
              </div>
              {!collapsed.snoozed && snoozed.map((agent) => (
                <SnoozedRow
                  key={agent.agentId}
                  agent={agent}
                  selected={agent.agentId === selectedAgentId}
                />
              ))}
            </div>
          )}
          {completed.length > 0 && (
            <div className="completed-section">
              <div className="section-header" onClick={() => toggleSection('completed')}>
                <span className="section-chevron">{collapsed.completed ? '\u25B8' : '\u25BE'}</span>
                <span className="completed-label">Completed ({completed.length})</span>
                <ClearCompletedButton
                  finishedCount={globalFinishedCount}
                  terminatedCount={globalTerminatedCount}
                  send={send}
                />
              </div>
              {!collapsed.completed && completed.map((agent) => (
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
