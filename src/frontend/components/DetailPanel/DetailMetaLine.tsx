import React, { useEffect, useState } from 'react';
import type { AgentState } from '../../../shared/contracts/agent-state.js';
import { formatBranch, formatCost, formatDuration, formatRelativeTimeAgo, worktreeHealthLabel, worktreeHealthTitle } from '../../presentation.js';

type StateChip = { label: string; kind: 'work' | 'done' | 'idle' };

function stateChip(status: AgentState['taskStatus']): StateChip | null {
  switch (status) {
    case 'pending': return { label: 'Pending', kind: 'idle' };
    case 'completed': return { label: 'Finished', kind: 'done' };
    case 'cancelled': return { label: 'Cancelled', kind: 'idle' };
    case 'terminated': return { label: 'Stopped', kind: 'idle' };
    case 'inProgress':
    case 'open': return { label: 'Working', kind: 'work' };
    default: return null;
  }
}

function timeLabel(agent: AgentState): string {
  const status = agent.taskStatus;
  if (status === 'completed' || status === 'cancelled' || status === 'terminated') {
    const ago = formatRelativeTimeAgo(agent.terminalAt ?? agent.finishedAt);
    return ago ? `finished ${ago}` : '';
  }
  if (status === 'pending') {
    const ago = formatRelativeTimeAgo(agent.taskCreatedAt);
    return ago ? `queued ${ago}` : '';
  }
  const running = formatDuration(agent.sessionCreatedAt ?? agent.startedAt ?? agent.taskCreatedAt);
  return running ? `running ${running}` : '';
}

/**
 * The reading pane's one meta line (issue #3561 slice 4b): state, project,
 * branch, time and cost under the title. Badges that mark something the
 * operator must notice (finding kind, bypass mode, operator needed, share
 * approval, blockers, worktree health) stay on this line, so collapsing the
 * facts column never hides them. A leaf component owns the minute clock, so the
 * tick does not re-render the terminal.
 */
export function DetailMetaLine({
  agent,
  projectLabel,
  badges,
  shareBadge,
}: {
  agent: AgentState;
  projectLabel: string;
  badges: React.ReactNode;
  shareBadge: string | null;
}) {
  const [, setClock] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setClock((n) => n + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const chip = agent.anomaly ? null : stateChip(agent.taskStatus);
  const branch = agent.gitBranch ? formatBranch(agent.gitBranch) : agent.gitCommit ? `(${agent.gitCommit})` : '';
  const time = timeLabel(agent);
  const cost = agent.tokenUsage && agent.tokenUsage.costUsd > 0 ? formatCost(agent.tokenUsage.costUsd) : '';
  const blockerCount = agent.blocked_by?.length ?? 0;
  const items: Array<{ key: string; node: React.ReactNode }> = [];
  if (projectLabel) items.push({ key: 'project', node: <span className="detail-meta-project" title={agent.cwd}>{projectLabel}</span> });
  if (branch) items.push({ key: 'branch', node: <span className="detail-meta-mono" title="Git branch">{branch}</span> });
  if (time) items.push({ key: 'time', node: <span>{time}</span> });
  if (cost) items.push({ key: 'cost', node: <span className="detail-meta-mono">{cost}</span> });

  return (
    <div className="detail-meta" data-testid="detail-meta">
      {chip && (
        <span className={`detail-state-chip detail-state-chip--${chip.kind}`} data-testid="detail-state-chip">
          <i className="detail-state-chip-mark" aria-hidden="true" />
          {chip.label}
        </span>
      )}
      {badges}
      {items.map((item, index) => (
        <React.Fragment key={item.key}>
          {index > 0 && <span className="detail-meta-sep" aria-hidden="true">/</span>}
          {item.node}
        </React.Fragment>
      ))}
      {blockerCount > 0 && (
        <span className="detail-meta-flag" data-testid="detail-meta-blocked">
          blocked by {blockerCount}
        </span>
      )}
      {shareBadge && <span className="detail-meta-flag" data-testid="detail-meta-share">{shareBadge}</span>}
      {agent.worktreeHealth && agent.worktreeHealth !== 'ok' && (
        <span
          className={`detail-header-warning worktree-health worktree-health--${agent.worktreeHealth}`}
          title={worktreeHealthTitle(agent.worktreeHealth, agent.worktreeRegistryStale)}
        >
          {worktreeHealthLabel(agent.worktreeHealth, agent.worktreeRegistryStale)}
        </span>
      )}
    </div>
  );
}
