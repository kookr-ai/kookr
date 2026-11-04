import React, { useEffect, useState } from 'react';
import type { AgentState } from '../../shared/contracts/agent-state.js';
import { formatAbsoluteDateTime, formatDuration, formatRelativeTimeAgo } from '../presentation.js';

function TimelineTime({ value }: { value: string | undefined }) {
  const label = formatAbsoluteDateTime(value);
  const relative = formatRelativeTimeAgo(value);
  return value && label ? <time dateTime={value}>{label}{relative ? ` · ${relative}` : ''}</time> : <span>Unavailable</span>;
}

function terminalLabel(source: AgentState['terminalAtSource']): string {
  switch (source) {
    case 'terminal_receipt':
    case 'finished_at':
    case 'terminated_at': return 'Task became terminal';
    case 'last_session_activity': return 'Last observed hook activity';
    case 'task_updated_at': return 'Task record updated';
    case 'archive_last_activity': return 'Last activity before archival';
    default: return 'Terminal time unavailable';
  }
}

/** Explicit task/session/archive timestamps with their source meaning. */
export function TaskTimeline({ agent }: { agent: AgentState }) {
  const [, setClock] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setClock((n) => n + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const isTerminal = agent.taskStatus === 'completed' || agent.taskStatus === 'cancelled' || agent.taskStatus === 'terminated';
  const taskEnd = isTerminal ? agent.terminalAt ?? agent.finishedAt : undefined;
  const sessionElapsed = !isTerminal && agent.sessionCreatedAt ? formatDuration(agent.sessionCreatedAt) : '';
  const taskAge = agent.taskCreatedAt
    ? (isTerminal ? (taskEnd ? formatDuration(agent.taskCreatedAt, taskEnd) : '') : formatDuration(agent.taskCreatedAt))
    : '';
  const knownTerminalTransition = agent.terminalAtSource === 'terminal_receipt'
    || agent.terminalAtSource === 'finished_at'
    || agent.terminalAtSource === 'terminated_at';
  const ageLabel = isTerminal
    ? knownTerminalTransition ? 'Task age at status change' : 'Task age at last recorded evidence'
    : 'Task age';

  return (
    <section className="task-timeline" aria-label="Task timeline" data-testid="task-timeline">
      <div className="task-timeline__row"><strong>Task created</strong><TimelineTime value={agent.taskCreatedAt} /></div>
      <div className="task-timeline__row"><strong>Kookr session recorded</strong><TimelineTime value={agent.sessionCreatedAt} /></div>
      {isTerminal && <div className="task-timeline__row"><strong>{terminalLabel(agent.terminalAtSource)}</strong><TimelineTime value={taskEnd} /></div>}
      {agent.archivedAt && <div className="task-timeline__row"><strong>Archived</strong><TimelineTime value={agent.archivedAt} /></div>}
      <div className="task-timeline__row"><strong>{ageLabel}</strong><span>{taskAge || 'Unavailable'}</span></div>
      {!isTerminal && agent.sessionCreatedAt && <div className="task-timeline__row"><strong>Session age</strong><span>{sessionElapsed || 'Unavailable'}</span></div>}
      {isTerminal && <div className="task-timeline__row"><strong>Execution runtime</strong><span>Unavailable — no session end time recorded</span></div>}
      <p className="task-timeline__note">A task status-change time does not prove when the conversation or process stopped; fallback timestamps are labeled by source. {agent.archivedAt ? 'Archive time is shown separately. ' : ''}No separate close time recorded.</p>
    </section>
  );
}
