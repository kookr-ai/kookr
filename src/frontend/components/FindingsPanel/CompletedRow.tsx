import React, { useEffect, useRef, useState } from 'react';
import type { AgentState, ClientMessage, TaskCompletionFeedback } from '../../../shared/protocol.js';
import { track } from '../../telemetry.js';
import { MY_PROMPT_DOWN_REASON_LABEL } from '../CompleteDialogFooter.js';
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

function ratingCopy(feedback: TaskCompletionFeedback): { emoji: string; title: string } {
  const emoji = feedback.rating === 'up' ? '👍' : '👎';
  const ratingWord = feedback.rating === 'up' ? 'Rated good' : 'Rated bad';
  const downReasonLabel =
    feedback.downReason === 'agent_behavior'
      ? 'Agent behavior'
      : feedback.downReason === 'my_prompt'
        ? 'My prompt was unclear'
        : undefined;
  const ratingNoteParts = [feedback.note, downReasonLabel].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  const title =
    ratingNoteParts.length > 0 ? `${ratingWord}: ${ratingNoteParts.join(' — ')}` : ratingWord;
  return { emoji, title };
}

function nextFeedback(
  current: TaskCompletionFeedback | undefined,
  rating: 'up' | 'down',
): TaskCompletionFeedback {
  const next: TaskCompletionFeedback = { rating };
  if (current?.note) next.note = current.note;
  if (rating === 'down' && current?.downReason) next.downReason = current.downReason;
  return next;
}

function sameFeedback(
  a: TaskCompletionFeedback | undefined,
  b: TaskCompletionFeedback | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.rating === b.rating
    && (a.note ?? '') === (b.note ?? '')
    && a.downReason === b.downReason;
}

function CompletedRowRatingControl({
  taskId,
  persisted,
  send,
}: {
  taskId: string;
  persisted: TaskCompletionFeedback | undefined;
  send: (msg: ClientMessage) => boolean | void;
}): JSX.Element {
  const [local, setLocal] = useState<TaskCompletionFeedback | undefined>(undefined);
  const [editorOpen, setEditorOpen] = useState(persisted === undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);
  const firstThumbRef = useRef<HTMLButtonElement>(null);
  const moveFocusIntoEditor = useRef(false);
  const sentRef = useRef<TaskCompletionFeedback | undefined>(persisted);
  const feedback = local ?? persisted;
  const feedbackRef = useRef(feedback);
  feedbackRef.current = feedback;

  // Adopt a snapshot that caught up with our last send, or an external
  // change from another client. Keep an unsent thumbs-down draft.
  useEffect(() => {
    const unsentDown = local?.rating === 'down' && !sameFeedback(sentRef.current, local);
    if (unsentDown) return;
    if (sameFeedback(sentRef.current, persisted) && local && sameFeedback(local, persisted)) {
      setLocal(undefined);
      return;
    }
    if (persisted && !sameFeedback(sentRef.current, persisted) && !sameFeedback(local, persisted)) {
      sentRef.current = persisted;
      setLocal(undefined);
    }
  }, [persisted, local]);
  // Unrated rows keep thumbs visible (there is no pill to reopen). Rated rows
  // keep the pill mounted and expand the editor beside it.
  const showEditor = editorOpen || feedback === undefined;

  function persist(next: TaskCompletionFeedback): boolean {
    if (sameFeedback(sentRef.current, next)) return true;
    const accepted = send({ type: 'setTaskFeedback', taskId, feedback: next });
    if (accepted === false) return false;
    sentRef.current = next;
    return true;
  }
  const persistRef = useRef(persist);
  persistRef.current = persist;

  // Keyboard collapse unmounts the row without a mousedown-outside. Persist
  // a thumbs-down draft so it is not discarded with the DOM.
  useEffect(() => {
    return () => {
      const draft = feedbackRef.current;
      if (draft?.rating === 'down') persistRef.current(draft);
    };
  }, []);

  function closeEditor(opts: { persistDraft?: boolean } = {}) {
    const persistDraft = opts.persistDraft !== false;
    const draft = feedbackRef.current;
    // Thumbs-down stays a local draft until the editor commits so my_prompt
    // can ride on the first setTaskFeedback (down amends auto-spawn reflect).
    if (persistDraft && draft?.rating === 'down' && !persist(draft)) return;
    setEditorOpen(false);
    queueMicrotask(() => pillRef.current?.focus());
  }

  useEffect(() => {
    // Unrated editors have no overlay to dismiss — skip outside-click / Escape
    // until a draft rating exists.
    if (!editorOpen || feedback === undefined) return;
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        closeEditor();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeEditor();
      }
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [editorOpen, feedback]);

  useEffect(() => {
    if (!showEditor || !moveFocusIntoEditor.current) return;
    moveFocusIntoEditor.current = false;
    firstThumbRef.current?.focus();
  }, [showEditor]);

  function submit(next: TaskCompletionFeedback, opts: { persistNow?: boolean } = {}) {
    // Unlike the complete dialog, late rating cannot clear — setTaskFeedback
    // always requires a rating. Clicking the active thumb is a no-op.
    if (sameFeedback(feedback, next)) return;
    const persistNow = opts.persistNow ?? next.rating === 'up';
    if (persistNow && !persist(next)) return;
    setLocal(next);
    feedbackRef.current = next;
    if (next.rating === 'up') closeEditor({ persistDraft: false });
  }

  const pill = feedback ? ratingCopy(feedback) : null;
  const pillLabel = pill ? `${pill.title}. Change rating.` : '';

  return (
    <div
      className="completed-row-rating-wrap"
      ref={wrapRef}
      onClick={(e) => e.stopPropagation()}
    >
      {pill && feedback && (
        <button
          ref={pillRef}
          type="button"
          className={`completed-row-rating completed-row-rating--${feedback.rating}`}
          title={pillLabel}
          aria-label={pillLabel}
          aria-expanded={showEditor}
          data-testid="completed-row-rating"
          onClick={() => {
            if (showEditor) {
              closeEditor();
              return;
            }
            moveFocusIntoEditor.current = true;
            setEditorOpen(true);
          }}
        >
          {pill.emoji}
        </button>
      )}
      {showEditor && (
        <div
          className="completed-row-rating-editor"
          role="group"
          aria-label={feedback ? 'Change task rating' : 'Rate this task'}
          data-testid="completed-row-rate-editor"
        >
          <button
            ref={firstThumbRef}
            type="button"
            className={`btn-thumb ${feedback?.rating === 'up' ? 'btn-thumb-active' : ''}`}
            onClick={() => submit(nextFeedback(feedback, 'up'))}
            aria-pressed={feedback?.rating === 'up'}
            aria-label="Thumbs up"
          >
            👍
          </button>
          <button
            type="button"
            className={`btn-thumb ${feedback?.rating === 'down' ? 'btn-thumb-active' : ''}`}
            onClick={() => submit(nextFeedback(feedback, 'down'))}
            aria-pressed={feedback?.rating === 'down'}
            aria-label="Thumbs down"
          >
            👎
          </button>
          {feedback?.rating === 'down' && (
            <label className="complete-feedback-checkbox">
              <input
                type="checkbox"
                checked={feedback.downReason === 'my_prompt'}
                onChange={(e) => {
                  const next: TaskCompletionFeedback = { rating: 'down' };
                  if (feedback.note) next.note = feedback.note;
                  if (e.target.checked) next.downReason = 'my_prompt';
                  submit(next, { persistNow: true });
                }}
              />
              <span>{MY_PROMPT_DOWN_REASON_LABEL}</span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}

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
  // Archive-only rows are not in the live task store. Reopen/Delete would 404
  // after prune, so they stay on live snapshot rows.
  const isLiveTask = useKookrStore((s) => Boolean(agent.taskId && s.agents.some((live) => live.taskId === agent.taskId)));
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

  // Completion rating (issues #3097 / #3330). Live completed rows can set or
  // change it here via setTaskFeedback; cancelled/terminated and archive-only
  // rows stay display-only when a rating already exists.
  const feedback = agent.completionFeedback;
  const canRate = Boolean(
    agent.taskId
    && isLiveTask
    && !pendingDeletion
    && agent.taskStatus === 'completed',
  );

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
          {canRate && agent.taskId && (
            <CompletedRowRatingControl
              taskId={agent.taskId}
              persisted={feedback}
              send={send}
            />
          )}
          {!canRate && feedback && (
            <span
              className={`completed-row-rating completed-row-rating--${feedback.rating}`}
              title={ratingCopy(feedback).title}
              aria-label={ratingCopy(feedback).title}
              data-testid="completed-row-rating"
            >
              {ratingCopy(feedback).emoji}
            </span>
          )}
          <span className="completed-row-finished" title={finishedTitle} aria-label={finishedTitle}>
            <span className="completed-row-status-label">{terminalLabel}</span>
            {finishedAt && <time dateTime={agent.finishedAt}>{finishedAt}</time>}
          </span>
          {agent.taskId && isLiveTask && (
            <button className="btn-xs" disabled={pendingDeletion} onClick={(e) => {
              e.stopPropagation();
              send({ type: 'reopenTask', taskId: agent.taskId! });
            }}>Reopen</button>
          )}
          <SchedulePlaybookButton agent={agent} onSchedule={onSchedulePlaybook} />
          {agent.taskId && isLiveTask && (
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
