import React from 'react';
import type { AgentState, ClientMessage } from '../../../shared/protocol.js';
import { track } from '../../telemetry.js';
import {
  formatDuration,
  formatTokenUsage,
  formatCompactDateTime,
  formatRelativeTimeAgo,
} from '../../presentation.js';
import { useKookrStore } from '../../store/useStore.js';
import type { SchedulePrefill } from '../SchedulesDialog.js';
import { Tooltip } from '../Tooltip.js';
import { TaskIdCopyButton } from '../TaskIdCopyButton.js';
import { CoordinatorTaskChipView, coordinatorChipForTask } from '../CoordinatorSurfaces.js';
import { ChildRollupPill } from '../RelatedTasksSection.js';
import { agentProjectLabel, agentProjectColor, type QueueDeleteTaskHandler } from './shared.js';
import { RailRowSelectionTarget } from './RailRowSelectionTarget.js';
import { AgentProviderMark } from './AgentProviderMark.js';
import { PriorityBadge } from './PriorityBadge.js';
import { SpeakTaskSummaryControl } from './SpeakTaskSummaryControl.js';
import { SchedulePlaybookButton } from './SchedulePlaybookButton.js';
import { RalphLoopBadge } from './RalphLoopBadge.js';

export function CompletedRow({ agent, selected, send, pendingDeletion, onQueueDeleteTask, onSchedulePlaybook }: {
  agent: AgentState;
  selected: boolean;
  send: (msg: ClientMessage) => void;
  pendingDeletion: boolean;
  onQueueDeleteTask?: QueueDeleteTaskHandler;
  onSchedulePlaybook?: (prefill: SchedulePrefill) => void;
}) {
  const projectLabelText = agentProjectLabel(agent);
  const colorIdx = projectLabelText ? agentProjectColor(agent) : -1;
  const isCancelled = agent.taskStatus === 'cancelled';
  const isTerminated = agent.taskStatus === 'terminated';
  // A reaped task that had already delivered a merged PR before it hung (issue
  // #1559) — surfaced distinctly from a plain `terminated` so a successful
  // delivery isn't read as failure.
  const isDeliveredThenHung = isTerminated && agent.reapOutcome === 'delivered_then_hung';
  const coordinatorChip = coordinatorChipForTask(useKookrStore((s) => s.coordinator), agent.taskId);
  // The row's style variant: cancelled (user stopped), terminated (session died
  // without ack), or completed (default / user acknowledged). Keep CSS variants
  // aligned with rfc-task-loss-prevention D1. AgentProviderMark only knows the
  // base variants, so delivered-then-hung reuses the terminated mark and adds a
  // distinct row class + label of its own.
  const rowVariant = isCancelled ? 'cancelled' : isTerminated ? 'terminated' : 'completed';
  const deliveredThenHungClass = isDeliveredThenHung ? ' delivered-then-hung' : '';
  const terminalLabel = isCancelled
    ? 'Cancelled'
    : isDeliveredThenHung
      ? 'Delivered then hung'
      : isTerminated
        ? 'Terminated'
        : 'Completed';
  const finishedAt = formatCompactDateTime(agent.finishedAt);
  const finishedAgo = formatRelativeTimeAgo(agent.finishedAt);
  const finishedTitle = finishedAt
    ? `${terminalLabel} ${finishedAt}${finishedAgo ? ` (${finishedAgo})` : ''}`
    : terminalLabel;

  function selectCompletedAgent() {
    if (pendingDeletion) return;
    track({ type: 'agent_clicked', agentId: agent.agentId, source: 'completed_row', anomalyType: null });
    useKookrStore.getState().selectAgent(agent.agentId, agent.taskId);
  }

  return (
    <Tooltip text={agent.description}>
      <div
        className={`completed-row${selected ? ' selected' : ''} ${rowVariant}${deliveredThenHungClass}${pendingDeletion ? ' pending-deletion' : ''}`}
        onClick={selectCompletedAgent}
      >
        <RailRowSelectionTarget
          label={agent.taskName ?? agent.agentId}
          selected={selected}
          disabled={pendingDeletion}
          onActivate={selectCompletedAgent}
        />
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
          <PriorityBadge agent={agent} />
          <ChildRollupPill agent={agent} />
          <TaskIdCopyButton taskId={agent.taskId} compact />
          <SpeakTaskSummaryControl agent={agent} selected={selected} />
          <span className="completed-row-meta">
            {formatTokenUsage(agent.tokenUsage)}
            {agent.tokenUsage && agent.startedAt ? ' · ' : ''}
            {formatDuration(agent.startedAt, agent.finishedAt)}
          </span>
          <span className="completed-row-finished" title={finishedTitle} aria-label={finishedTitle}>
            <span className="completed-row-status-label">{terminalLabel}</span>
            {finishedAt && <time dateTime={agent.finishedAt}>{finishedAt}</time>}
          </span>
          {agent.taskId && (
            <button className="btn-xs" disabled={pendingDeletion} onClick={(e) => {
              e.stopPropagation();
              send({ type: 'reopenTask', taskId: agent.taskId! });
            }}>Reopen</button>
          )}
          <SchedulePlaybookButton agent={agent} onSchedule={onSchedulePlaybook} />
          {agent.taskId && (
            <button
              className="btn-xs btn-danger-xs"
              disabled={pendingDeletion}
              aria-label={`Delete ${agent.taskName ?? agent.agentId}`}
              onClick={(e) => {
                e.stopPropagation();
                onQueueDeleteTask?.({
                  taskId: agent.taskId!,
                  label: agent.taskName ?? agent.agentId,
                });
              }}
            >
              Delete
            </button>
          )}
          {pendingDeletion && (
            <span className="completed-row-pending-delete">deleting soon</span>
          )}
        </div>
        {agent.ralphLoop && (
          <RalphLoopBadge agent={agent} />
        )}
        <CoordinatorTaskChipView chip={coordinatorChip} agent={agent} send={send} />
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
