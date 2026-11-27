/**
 * The desk's Fleet column: what is running, as one row per task, and under it what finished today.
 *
 * Everything comes from the agent buckets the dashboard already holds (`running` is its "Working" bucket,
 * `completed` its newest-first finished one), passed in by `App.tsx`; nothing is fetched here. A running row
 * shows the task's name, its project, how long it has run and what it has cost so far, and under the name one
 * line of what it is doing right now: the same current-tool label the dashboard's working rows show (no line
 * when the task has none). Tasks that need the operator carry the amber marker and come first. A row is a
 * button that leaves the room and opens the task; nothing in this column changes a task.
 *
 * The dashboard pushes state often, so a row is memoised on the few strings it shows: it draws again only when
 * one of them changes, and "how long" is refreshed once a minute, not on every push.
 */
import { memo, useEffect, useMemo, useState } from 'react';
import type { AgentState } from '../../shared/protocol.js';
import { formatCost, formatDuration, formatRelativeTimeAgo, healthyCurrentToolLabel, projectLabel } from '../presentation.js';
import { finishedToday } from './desk.js';

/** "How long" and "when" labels are refreshed this often. */
const CLOCK_MS = 60_000;

interface RowProps {
  taskId: string | undefined;
  name: string;
  project: string;
  /** Running rows: how long it has run. Finished rows: when it finished ("3h 2m ago"). */
  when: string;
  cost: string;
  /** Running rows: what it is doing now; empty when the data has nothing. */
  doing: string;
  needsYou: boolean;
  onOpen: ((taskId: string) => boolean) | undefined;
}

const FleetRow = memo(function FleetRow({ taskId, name, project, when, cost, doing, needsYou, onOpen }: RowProps) {
  const meta = [project, when, cost].filter(Boolean).join(' · ');
  const body = (
    <>
      <span className="avatar-desk-row-line">
        {needsYou && <span className="avatar-mark-diamond" aria-hidden="true" />}
        <span className="avatar-desk-row-name">{name}</span>
        {needsYou && <span className="sr-only"> needs you</span>}
      </span>
      {doing && <span className="avatar-desk-row-doing" data-testid="avatar-desk-row-doing" title={doing}>{doing}</span>}
      <span className="avatar-desk-row-meta">{meta}</span>
    </>
  );
  const className = `avatar-desk-row${needsYou ? ' avatar-desk-row-needs' : ''}`;
  return (
    <li>
      {taskId && onOpen ? (
        <button type="button" className={className} onClick={() => onOpen(taskId)} data-testid="avatar-desk-row" data-needs-you={needsYou ? 'true' : undefined}>
          {body}
        </button>
      ) : (
        <div className={className} data-testid="avatar-desk-row" data-needs-you={needsYou ? 'true' : undefined}>{body}</div>
      )}
    </li>
  );
});

const costText = (agent: AgentState): string => {
  const usd = agent.tokenUsage?.costUsd;
  return usd !== undefined && usd > 0 ? formatCost(usd) : '';
};

export const DeskFleet = memo(function DeskFleet({ running, completed, needsTaskIds, onOpenTask }: {
  running: readonly AgentState[];
  completed: readonly AgentState[];
  /** The tasks that wait on the operator (a question, a permission prompt or a finding). */
  needsTaskIds: readonly string[];
  onOpenTask?: (taskId: string) => boolean;
}) {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / CLOCK_MS));
  useEffect(() => {
    const timer = setInterval(() => setMinute(Math.floor(Date.now() / CLOCK_MS)), CLOCK_MS);
    return () => clearInterval(timer);
  }, []);
  const needsKey = needsTaskIds.join('\n');
  // Needs-you tasks first, the dashboard's order otherwise. Rebuilt only when the buckets or the waiting tasks change.
  const ordered = useMemo(() => {
    const needs = new Set(needsKey === '' ? [] : needsKey.split('\n'));
    const flagged = (agent: AgentState): boolean => agent.taskId !== undefined && needs.has(agent.taskId);
    return [...running.filter(flagged), ...running.filter((agent) => !flagged(agent))].map((agent) => ({ agent, needsYou: flagged(agent) }));
  }, [running, needsKey]);
  const finished = useMemo(() => finishedToday(completed, minute * CLOCK_MS), [completed, minute]);
  // `minute` is read so the labels below are recomputed once a minute even when the buckets do not change.
  const nowMs = minute * CLOCK_MS;

  return (
      <section className="avatar-desk-fleet" aria-label="Fleet" data-testid="avatar-desk-fleet">
        <div className="avatar-tray-title">
          <h2 className="avatar-tray-heading">
            Fleet <span aria-hidden="true">·</span> <span className="avatar-tray-heading-count" data-testid="avatar-desk-fleet-count">{running.length}</span> running
          </h2>
        </div>
        <div className="avatar-desk-fleet-body">
          {running.length === 0 ? (
            <p className="avatar-tray-empty" data-testid="avatar-desk-fleet-empty">No tasks are running.</p>
          ) : (
            <ul className="avatar-desk-rows" aria-label={`Running (${running.length})`} data-testid="avatar-desk-running">
              {ordered.map(({ agent, needsYou }) => (
                <FleetRow
                  key={agent.agentId}
                  taskId={agent.taskId}
                  name={agent.taskName ?? agent.agentId}
                  project={agent.projectDisplayLabel ?? projectLabel(agent.cwd)}
                  when={formatDuration(agent.startedAt)}
                  cost={costText(agent)}
                  doing={healthyCurrentToolLabel(agent.events)}
                  needsYou={needsYou}
                  onOpen={onOpenTask}
                />
              ))}
            </ul>
          )}
          {finished.length > 0 && (
            <>
              <h3 className="avatar-desk-subtitle">Finished today</h3>
              <ul className="avatar-desk-rows" aria-label={`Finished today (${finished.length})`} data-testid="avatar-desk-finished">
                {finished.map((agent) => (
                  <FleetRow
                    key={agent.agentId}
                    taskId={agent.taskId}
                    name={agent.taskName ?? agent.agentId}
                    project=""
                    when={formatRelativeTimeAgo(agent.finishedAt, nowMs)}
                    cost={costText(agent)}
                    doing=""
                    needsYou={false}
                    onOpen={onOpenTask}
                  />
                ))}
              </ul>
            </>
          )}
        </div>
      </section>
  );
});
