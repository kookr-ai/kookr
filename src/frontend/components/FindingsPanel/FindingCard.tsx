import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { AgentState, ClientMessage, QuickAction } from '../../../shared/protocol.js';
import { track, trackClick } from '../../telemetry.js';
import {
  formatDuration,
  formatAge,
  ageColor,
  findingWaitStartedAt,
  formatTokenUsage,
  formatCostRate,
  worktreeHealthLabel,
  worktreeHealthTitle,
  turnStateLabel,
  turnStateClass,
} from '../../presentation.js';
import { useKookrStore } from '../../store/useStore.js';
import { useDnd } from '../../hooks/useDnd.js';
import { Tooltip } from '../Tooltip.js';
import { SnoozeDialog } from '../SnoozeDialog.js';
import { SupervisorFeedbackDialog } from '../SupervisorFeedbackDialog.js';
import { TaskIdCopyButton } from '../TaskIdCopyButton.js';
import { CoordinatorTaskChipView, coordinatorChipForTask } from '../CoordinatorSurfaces.js';
import { ChildRollupPill } from '../RelatedTasksSection.js';
import { formatDiagnosticIdentifier } from '../diagnostics-format.js';
import { severityClass, severityLabel, agentProjectLabel, agentProjectColor } from './shared.js';
import { RailRowSelectionTarget } from './RailRowSelectionTarget.js';
import { AgentProviderMark } from './AgentProviderMark.js';
import { LikelyRootCauseBadge } from './LikelyRootCauseBadge.js';
import { SpeakTaskSummaryControl } from './SpeakTaskSummaryControl.js';
import { EditableName } from './EditableName.js';
import { PriorityBadge } from './PriorityBadge.js';
import { TaskPriorityButton } from './TaskPriorityButton.js';
import { RalphLoopControls } from './RalphLoopControls.js';
import { RalphLoopBadge } from './RalphLoopBadge.js';
import { FindingTranscriptContext } from './FindingTranscriptContext.js';
import { recommendedResponseFor } from './recommendedResponses.js';
import { CopyExplanationButton } from './CopyExplanationButton.js';
import { FindingPrChip } from './FindingPrChip.js';
import {
  isPermissionQuickAction,
  visibleFindingCardQuickActions,
} from './finding-card-quick-actions.js';

function resolveParentAgent(
  agents: readonly AgentState[],
  parentTaskId: string | undefined,
): AgentState | undefined {
  if (!parentTaskId) return undefined;
  return agents.find((candidate) => candidate.taskId === parentTaskId);
}

function parentDisplayName(parent: AgentState): string {
  return parent.taskName ?? parent.agentId;
}

/**
 * Compact `parent: <name>` chip for child findings. Hidden when the parent id
 * is missing or the parent is not in the current snapshot.
 */
function FindingParentChip({
  parentTaskId,
  onSelect,
}: {
  parentTaskId: string | undefined;
  onSelect: (parent: AgentState) => void;
}): React.ReactElement | null {
  const parent = useKookrStore((state) => resolveParentAgent(state.agents, parentTaskId));
  if (!parent) return null;
  const name = parentDisplayName(parent);
  return (
    <button
      type="button"
      className="finding-parent-chip"
      data-testid="finding-parent-chip"
      title={`Parent task: ${name}`}
      aria-label={`Select parent: ${name}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(parent);
      }}
    >
      {`parent: ${name}`}
    </button>
  );
}

export const FindingCard = React.memo(function FindingCard({ agent, selected, send }: {
  agent: AgentState;
  selected: boolean;
  send: (msg: ClientMessage) => boolean | void;
}): React.ReactElement {
  const [showSnooze, setShowSnooze] = useState(false);
  const [showFlagFP, setShowFlagFP] = useState(false);
  const [permissionButtonsDisabled, setPermissionButtonsDisabled] = useState(false);
  const selectAgent = useKookrStore((s) => s.selectAgent);
  const nextBottleneck = useKookrStore((s) => s.nextBottleneck);
  const clearSuggestion = useKookrStore((s) => s.clearSuggestion);
  const handleAlert = useKookrStore((s) => s.handleAlert);
  const suggestion = useKookrStore((s) => s.suggestions[agent.agentId]);
  const cardQuickActions = suggestion
    ? visibleFindingCardQuickActions(suggestion.quickActions)
    : [];
  const selectedProject = useKookrStore((s) => s.selectedProject);
  const dnd = useDnd();
  const cls = severityClass(agent);
  const recommended = agent.anomaly ? recommendedResponseFor(agent.anomaly.type) : undefined;
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const waitStartedAt = findingWaitStartedAt(agent);
  const waitAge = formatAge(waitStartedAt);
  const arrivedDuringDnd =
    dnd.enabled &&
    dnd.startedAt !== null &&
    waitStartedAt !== undefined &&
    new Date(waitStartedAt).getTime() >= dnd.startedAt;

  // Clean up pending click timer on unmount
  useEffect(() => {
    return () => { if (clickTimer.current) clearTimeout(clickTimer.current); };
  }, []);

  // A new live prompt must re-enable chips; the card stays mounted across
  // successive permission_blocked suggestions for the same agent.
  useEffect(() => {
    setPermissionButtonsDisabled(false);
  }, [suggestion]);

  function handleSkip() {
    track({ type: 'finding_skipped', agentId: agent.agentId, anomalyType: agent.anomaly?.type ?? null, method: 'button' });
    trackClick('skip');
    send({ type: 'skip', agentId: agent.agentId });
    nextBottleneck();
  }

  function submitFlagFP(userReason: string) {
    if (!agent.anomaly) return;
    trackClick('flag_fp_submitted');
    send({
      type: 'findingFeedback',
      agentId: agent.agentId,
      anomalyType: agent.anomaly.type,
      explanation: agent.anomaly.explanation,
      verdict: 'false_positive',
      ...(userReason ? { userReason } : {}),
    });
    setShowFlagFP(false);
    nextBottleneck();
  }

  function handleSnooze(durationMs: number) {
    trackClick('snooze');
    send({ type: 'snooze', agentId: agent.agentId, taskId: agent.taskId, durationMs });
  }

  function handleCardQuickAction(action: QuickAction) {
    if (isPermissionQuickAction(action)) {
      const { keystroke, permissionRequest } = action;
      if (!keystroke || !permissionRequest || permissionButtonsDisabled) return;
      setPermissionButtonsDisabled(true);
      track({ type: 'quick_action_clicked', agentId: agent.agentId, actionLabel: `permission:${keystroke}` });
      const sent = send({ type: 'permissionChoice', agentId: agent.agentId, keystroke, permissionRequest });
      if (sent === false) {
        setPermissionButtonsDisabled(false);
        handleAlert('', 'Message not sent — connection lost. Please try again.', 'error');
        return;
      }
      clearSuggestion(agent.agentId);
      nextBottleneck();
      return;
    }
    track({
      type: 'response_sent',
      agentId: agent.agentId,
      method: 'quick_action',
      charCount: action.value.length,
      anomalyType: agent.anomaly?.type ?? null,
    });
    track({ type: 'quick_action_clicked', agentId: agent.agentId, actionLabel: action.value.slice(0, 50) });
    const sent = send({ type: 'respond', agentId: agent.agentId, input: action.value });
    if (sent === false) {
      handleAlert('', 'Message not sent — connection lost. Please try again.', 'error');
      return;
    }
    clearSuggestion(agent.agentId);
    nextBottleneck();
  }

  const tooltipText = [agent.description, agent.anomaly?.explanation].filter(Boolean).join('\n\n');
  const showProjectBadge = !selectedProject || agent.projectId !== selectedProject;
  const coordinator = useKookrStore((s) => s.coordinator);
  const coordinatorChip = useMemo(
    () => coordinatorChipForTask(coordinator, agent.taskId),
    [coordinator, agent.taskId],
  );
  const taskGithub = useKookrStore((s) => (
    agent.taskId ? s.githubState[agent.taskId] : undefined
  ));

  function selectFinding() {
    track({ type: 'agent_clicked', agentId: agent.agentId, source: 'finding_card', anomalyType: agent.anomaly?.type ?? null });
    selectAgent(agent.agentId, agent.taskId);
  }

  function selectFindingImmediately() {
    if (clickTimer.current) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    selectFinding();
  }

  return (
    <Tooltip text={tooltipText}>
      <div
        className={`finding-card ${cls} ${selected ? 'selected' : ''}`}
        onClick={() => {
          if (selected || clickTimer.current) {
            // Already selected or a prior click is pending — no new timer needed.
            // Fire immediately if selected (no layout shift risk).
            if (selected) {
              selectFinding();
            }
            return;
          }
          // Delay selectAgent to allow dblclick on .finding-task to cancel it.
          // Without this, the first click causes a layout shift (detail panel appears)
          // that moves the card, breaking the second click of the dblclick.
          clickTimer.current = setTimeout(() => {
            selectFinding();
            clickTimer.current = null;
          }, 200);
        }}
      >
        <RailRowSelectionTarget
          label={agent.taskName ?? agent.agentId}
          selected={selected}
          onActivate={selectFindingImmediately}
        />
        <div className="finding-header">
          <span className="finding-header-left">
            <AgentProviderMark agent={agent} state="finding" />
            <span className={`finding-severity ${cls}`} aria-label={`${severityLabel(agent)}${waitAge ? `, waiting ${waitAge}` : ''}`}>{severityLabel(agent)}</span>
            {arrivedDuringDnd && (
              <span
                className="dnd-arrived-badge"
                title="Arrived while Do Not Disturb was on"
                aria-label="Arrived while Do Not Disturb was on"
              >
                while away
              </span>
            )}
            <LikelyRootCauseBadge agent={agent} />
          </span>
          <span className="finding-meta">
            <SpeakTaskSummaryControl agent={agent} selected={selected} />
            {waitStartedAt && waitAge && (
              <span className={`age-badge ${ageColor(waitStartedAt)}`}>
                waiting {waitAge}
              </span>
            )}
          </span>
        </div>
        <EditableName agent={agent} send={send} onBeforeEdit={() => {
          if (clickTimer.current) { clearTimeout(clickTimer.current); clickTimer.current = null; }
        }} />
        <PriorityBadge agent={agent} />
        <ChildRollupPill agent={agent} />
        <div className="finding-context">
          <TaskIdCopyButton taskId={agent.taskId} compact />
          {showProjectBadge && agentProjectLabel(agent) && (
            <span className={`project-badge color-${agentProjectColor(agent)}`} title={agent.cwd}>
              {agentProjectLabel(agent)}
            </span>
          )}
          <FindingParentChip
            parentTaskId={agent.parentTaskId}
            onSelect={(parent) => {
              if (clickTimer.current) {
                clearTimeout(clickTimer.current);
                clickTimer.current = null;
              }
              selectAgent(parent.agentId, parent.taskId);
            }}
          />
          {agent.worktreeHealth && agent.worktreeHealth !== 'ok' && (
            <span className={`worktree-health worktree-health--${agent.worktreeHealth}`} title={worktreeHealthTitle(agent.worktreeHealth, agent.worktreeRegistryStale)}>
              {worktreeHealthLabel(agent.worktreeHealth, agent.worktreeRegistryStale)}
            </span>
          )}
          <FindingPrChip
            prs={taskGithub?.prs}
            onSelect={selectFindingImmediately}
          />
          {/* Branch / worktree is intentionally omitted here — it's detail-panel
              context, too granular for the card. See the detail panel's
              `.detail-branch` row. Do not add gitBranch to this row. */}
        </div>
        {agent.ralphLoop && (
          <div className="finding-loop-row" onClick={(e) => e.stopPropagation()}>
            <RalphLoopControls agent={agent} />
            {!agent.ralphLoop || (agent.ralphLoop.status !== 'running' && agent.ralphLoop.status !== 'paused') ? (
              <RalphLoopBadge agent={agent} />
            ) : null}
          </div>
        )}
        {turnStateLabel(agent.turnState) && (
          <div
            className={`finding-turn-state turn-state--${turnStateClass(agent.turnState)}`}
            data-testid="finding-turn-state"
          >
            {turnStateLabel(agent.turnState)}
          </div>
        )}
        {agent.anomaly && (
          <div className="finding-explanation-row">
            <div className="finding-explanation">{agent.anomaly.explanation}</div>
            <CopyExplanationButton text={agent.anomaly.explanation} />
          </div>
        )}
        {agent.anomaly && recommended && (
          <div className="finding-recommended" data-testid="finding-recommended" title={recommended}>
            <span className="finding-recommended-label">Recommended:</span>{' '}
            {recommended}
          </div>
        )}
        {(agent.anomaly?.type === 'stale_agent' || agent.anomaly?.type === 'hook_disconnected') && agent.sessionHealth && (
          <div className="finding-health-evidence">
            Health: {formatDiagnosticIdentifier(agent.sessionHealth.classification)}
            {agent.sessionHealth.evidence.length > 0 ? ` — ${agent.sessionHealth.evidence.join(' · ')}` : ''}
          </div>
        )}
        <FindingTranscriptContext agent={agent} />
        <CoordinatorTaskChipView chip={coordinatorChip} agent={agent} send={send} />
        {(agent.tokenUsage || agent.startedAt) && (
          <div className="finding-cost">
            {[
              formatTokenUsage(agent.tokenUsage),
              formatCostRate(agent.tokenUsage?.costUsd, agent.startedAt),
              formatDuration(agent.startedAt, agent.finishedAt),
            ].filter(Boolean).join(' · ')}
          </div>
        )}
        {cardQuickActions.length > 0 && (
          <div
            className="finding-quick-actions"
            data-testid="finding-quick-actions"
            onClick={(e) => e.stopPropagation()}
          >
            {cardQuickActions.map((action) => {
              const permissionChip = isPermissionQuickAction(action);
              return (
                <button
                  key={`${action.keystroke ?? ''}:${action.value}`}
                  type="button"
                  data-testid="finding-quick-action"
                  className={`btn-quick-action${permissionChip ? ' permission-action' : ''}`}
                  title={action.label}
                  disabled={permissionChip && permissionButtonsDisabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCardQuickAction(action);
                  }}
                >
                  <span>{action.label}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="finding-actions">
          <TaskPriorityButton agent={agent} send={send} />
          <button className="btn-xs" onClick={(e) => { e.stopPropagation(); handleSkip(); }}>Skip</button>
          <button className="btn-xs" onClick={(e) => { e.stopPropagation(); setShowSnooze(true); }}>Snooze</button>
          <button className="btn-xs btn-fp" onClick={(e) => { e.stopPropagation(); setShowFlagFP(true); }} title="Flag this finding as a false positive">Not a real issue</button>
        </div>
        {showSnooze && (
          <SnoozeDialog
            agentId={agent.agentId}
            agentName={agent.taskName ?? agent.agentId}
            onSnooze={(durationMs) => { handleSnooze(durationMs); setShowSnooze(false); }}
            onClose={() => setShowSnooze(false)}
          />
        )}
        {showFlagFP && agent.anomaly && (
          <SupervisorFeedbackDialog
            mode="false_positive"
            agentName={agent.taskName ?? agent.agentId}
            supervisorExplanation={agent.anomaly.explanation}
            onSubmit={({ userReason }) => submitFlagFP(userReason)}
            onClose={() => setShowFlagFP(false)}
          />
        )}
      </div>
    </Tooltip>
  );
});
