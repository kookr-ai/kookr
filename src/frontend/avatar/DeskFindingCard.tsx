/**
 * A finding in the desk's Decisions column (a task that says it is finished, is over budget, has gone quiet...):
 * a compact card with the finding's kind in words, the task's name, the first line of the finding's own
 * explanation when the data has one, and ONE button, "Open task". Nothing here changes a task: snoozing,
 * closing or answering stays on the dashboard's finding card and on the question and permission cards.
 * The name and the explanation come from a task, so they are text, never markup.
 */
import { useState } from 'react';
import type { AgentState } from '../../shared/protocol.js';
import { OPEN_TASK_FAILED_TEXT } from './AskCard.js';
import { findingExplanationLine, findingWords } from './desk.js';

export function DeskFindingCard({ id, agent, onOpenTask }: {
  /** The entry's id in `buildNeedsYou`'s list, which "Next:" finds the card by. */
  id: string;
  agent: AgentState;
  onOpenTask?: (taskId: string) => boolean;
}) {
  const [failed, setFailed] = useState(false);
  const name = agent.taskName ?? agent.agentId;
  const explanation = findingExplanationLine(agent);
  const taskId = agent.taskId;
  return (
    <li className="avatar-ask avatar-ask-pending avatar-desk-finding" data-testid="avatar-desk-finding" data-desk-finding={id}>
      <div className="avatar-ask-head">
        <span className="avatar-mark-diamond" aria-hidden="true" />
        <span className="avatar-ask-who" data-testid="avatar-desk-finding-kind">{findingWords(agent).kind}</span>
      </div>
      <p className="avatar-desk-finding-name" title={name}>{name}</p>
      {explanation && <p className="avatar-desk-finding-line" title={explanation} data-testid="avatar-desk-finding-line">{explanation}</p>}
      {taskId && onOpenTask && (
        <div className="avatar-launch-buttons">
          <button
            type="button"
            className="avatar-ask-option"
            aria-label={`Open task ${name}`}
            onClick={() => setFailed(!onOpenTask(taskId))}
            data-testid="avatar-desk-finding-open"
          >
            Open task
          </button>
        </div>
      )}
      {failed && <p className="avatar-ask-note" role="status">{OPEN_TASK_FAILED_TEXT}</p>}
    </li>
  );
}
