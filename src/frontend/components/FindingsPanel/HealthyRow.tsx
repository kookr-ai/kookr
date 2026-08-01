import React, { useState } from 'react';
import type { AgentState, ClientMessage } from '../../../shared/protocol.js';
import { track, trackClick } from '../../telemetry.js';
import {
  formatTokenUsage,
  healthyDotClass,
  healthyStatusLabel,
  worktreeHealthLabel,
  worktreeHealthTitle,
} from '../../presentation.js';
import { useKookrStore } from '../../store/useStore.js';
import type { SchedulePrefill } from '../SchedulesDialog.js';
import { Tooltip } from '../Tooltip.js';
import { SnoozeDialog } from '../SnoozeDialog.js';
import { SupervisorFeedbackDialog } from '../SupervisorFeedbackDialog.js';
import { TaskIdCopyButton } from '../TaskIdCopyButton.js';
import { CoordinatorTaskChipView, coordinatorChipForTask } from '../CoordinatorSurfaces.js';
import { ChildRollupPill } from '../RelatedTasksSection.js';
import { agentProjectLabel, agentProjectColor } from './shared.js';
import { RailRowSelectionTarget } from './RailRowSelectionTarget.js';
import { AgentProviderMark } from './AgentProviderMark.js';
import { PriorityBadge } from './PriorityBadge.js';
import { StuckReasonBadge } from './StuckReasonBadge.js';
import { SpeakTaskSummaryControl } from './SpeakTaskSummaryControl.js';
import { TaskPriorityButton } from './TaskPriorityButton.js';
import { RalphLoopControls } from './RalphLoopControls.js';
import { RalphLoopBadge } from './RalphLoopBadge.js';
import { SchedulePlaybookButton } from './SchedulePlaybookButton.js';
import { ReplyIcon, SnoozeIcon, MissedIcon } from './icons.js';

export function HealthyRow({ agent, selected, send, onSchedulePlaybook }: {
  agent: AgentState;
  selected: boolean;
  send: (msg: ClientMessage) => void;
  onSchedulePlaybook?: (prefill: SchedulePrefill) => void;
}) {
  const [showSnooze, setShowSnooze] = useState(false);
  const [showFlagMissed, setShowFlagMissed] = useState(false);
  const selectedProject = useKookrStore((s) => s.selectedProject);
  const coordinatorChip = coordinatorChipForTask(useKookrStore((s) => s.coordinator), agent.taskId);
  const projectLabelText = agentProjectLabel(agent);
  const colorIdx = projectLabelText ? agentProjectColor(agent) : -1;
  const showProjectBadge = !selectedProject || agent.projectId !== selectedProject;
  // Both live-updating values; render each (with its leading separator) only
  // when it has content, so a row without token usage never trails a stray "·".
  const durText = healthyStatusLabel(agent.events, agent.startedAt);
  const costText = agent.tokenUsage ? formatTokenUsage(agent.tokenUsage) : '';

  function handleReply(e: React.MouseEvent) {
    e.stopPropagation();
    track({ type: 'agent_clicked', agentId: agent.agentId, source: 'reply_button', anomalyType: null });
    useKookrStore.getState().selectAgent(agent.agentId, agent.taskId);
    // Focus the response input after React re-renders
    requestAnimationFrame(() => {
      const input = document.querySelector('.response-area textarea') as HTMLTextAreaElement | null;
      input?.focus();
    });
  }

  function handleSnooze(durationMs: number) {
    trackClick('snooze');
    send({ type: 'snooze', agentId: agent.agentId, taskId: agent.taskId, durationMs });
  }

  function selectHealthyAgent() {
    track({ type: 'agent_clicked', agentId: agent.agentId, source: 'healthy_row', anomalyType: null });
    track({ type: 'healthy_agent_inspected', agentId: agent.agentId });
    useKookrStore.getState().selectAgent(agent.agentId, agent.taskId);
  }

  return (
    <Tooltip text={agent.description}>
      <div
        className={`healthy-row${colorIdx >= 0 ? ` project-color-${colorIdx}` : ''}${selected ? ' selected' : ''}${healthyDotClass(agent.events) === 'running' ? ' running-accent' : ''}`}
        onClick={selectHealthyAgent}
      >
        <RailRowSelectionTarget
          label={agent.taskName ?? agent.agentId}
          selected={selected}
          onActivate={selectHealthyAgent}
        />
        {/* Title Lead: the task name owns its own full-width line; the info row
            below leads with stable-width fields (avatar, project) so the
            live-updating duration/cost that trail never shove them or the
            right-pinned action rail as their widths change. The click-to-copy id
            sits (icon-only) in that rail; the branch/worktree lives in the detail
            panel, not the card. */}
        <div className="healthy-row-name" title={agent.taskName ?? agent.agentId}>
          {agent.taskName ?? agent.agentId}
        </div>
        <div className="healthy-row-info">
          <div className="healthy-row-meta">
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
            <PriorityBadge agent={agent} />
            <StuckReasonBadge agent={agent} />
            <ChildRollupPill agent={agent} />
            {durText && (
              <>
                <span className="healthy-row-sep" aria-hidden="true">·</span>
                <span className="healthy-row-dur">{durText}</span>
              </>
            )}
            {costText && (
              <>
                <span className="healthy-row-sep" aria-hidden="true">·</span>
                <span className="healthy-row-cost">{costText}</span>
              </>
            )}
          </div>
          <div className="healthy-row-controls">
            <TaskIdCopyButton taskId={agent.taskId} iconOnly />
            <SpeakTaskSummaryControl agent={agent} selected={selected} />
            <TaskPriorityButton agent={agent} send={send} variant="icon" />
            <button
              className="btn-reply btn-icon"
              data-testid="reply-button"
              onClick={handleReply}
              title={`Send message to ${agent.taskName ?? agent.agentId}`}
              aria-label={`Send message to ${agent.taskName ?? agent.agentId}`}
            >
              <ReplyIcon />
            </button>
            <button
              className="btn-icon btn-snooze"
              onClick={(e) => { e.stopPropagation(); setShowSnooze(true); }}
              title={`Snooze ${agent.taskName ?? agent.agentId}`}
              aria-label={`Snooze ${agent.taskName ?? agent.agentId}`}
            >
              <SnoozeIcon />
            </button>
            <button
              className="btn-icon btn-fn"
              onClick={(e) => { e.stopPropagation(); setShowFlagMissed(true); }}
              title="Report that Kookr missed a real issue on this agent"
              aria-label={`Missed a real issue — report for ${agent.taskName ?? agent.agentId}`}
            >
              <MissedIcon />
            </button>
            <RalphLoopControls agent={agent} />
            {agent.ralphLoop && agent.ralphLoop.status !== 'running' && agent.ralphLoop.status !== 'paused' && (
              <RalphLoopBadge agent={agent} />
            )}
            <SchedulePlaybookButton agent={agent} onSchedule={onSchedulePlaybook} />
          </div>
        </div>
        <CoordinatorTaskChipView chip={coordinatorChip} agent={agent} send={send} />
        {showSnooze && (
          <SnoozeDialog
            agentId={agent.agentId}
            agentName={agent.taskName ?? agent.agentId}
            onSnooze={(durationMs) => { handleSnooze(durationMs); setShowSnooze(false); }}
            onClose={() => setShowSnooze(false)}
          />
        )}
        {showFlagMissed && (
          <SupervisorFeedbackDialog
            mode="false_negative"
            agentName={agent.taskName ?? agent.agentId}
            onSubmit={({ userReason, suspectedType }) => {
              trackClick('flag_missed_submitted');
              send({
                type: 'missedFinding',
                agentId: agent.agentId,
                userReason,
                ...(suspectedType ? { suspectedType } : {}),
              });
              setShowFlagMissed(false);
            }}
            onClose={() => setShowFlagMissed(false)}
          />
        )}
      </div>
    </Tooltip>
  );
}
