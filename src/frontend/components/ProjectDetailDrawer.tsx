import React, { useState } from 'react';
import type { ProjectSummary, ClientMessage, TaskSummary } from '../../shared/protocol.js';

interface Props {
  project: ProjectSummary;
  onClose: () => void;
  send: (msg: ClientMessage) => void;
  onOpenWorkspace?: () => void;
  onLaunchManual?: () => void;
  onRunPlaybook?: () => void;
  compact?: boolean;
}

const COLLAPSED_TASK_COUNT = 3;

function relativeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function StatRow({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="project-drawer-stat-row">
      <span className="project-drawer-stat-label">{label}</span>
      <span className="project-drawer-stat-value">
        {value}
        {hint}
      </span>
    </div>
  );
}

function TaskRow({ task }: { task: TaskSummary }) {
  const status = task.status === 'inProgress' ? 'running' : task.status;
  return (
    <div className="project-drawer-task">
      <span className={`task-status-dot ${task.status}`} aria-hidden />
      <span className="task-name" title={task.name ?? task.taskId}>{task.name ?? task.taskId.slice(0, 8)}</span>
      <span className="task-status-text">{status}</span>
    </div>
  );
}

export function ProjectDetailDrawer({ project, onClose, send, onOpenWorkspace, onLaunchManual, onRunPlaybook, compact = false }: Props) {
  const [dailyLimit, setDailyLimit] = useState<string>(project.dailyLimit?.toString() ?? '');
  const [budgetWarnUsd, setBudgetWarnUsd] = useState<string>(project.budgetWarnUsd?.toString() ?? '');
  const [notes, setNotes] = useState(project.notes ?? '');
  const [dirty, setDirty] = useState(false);
  const [tasksExpanded, setTasksExpanded] = useState(false);

  const atLimit = project.dailyLimit !== undefined && project.todayPrCount >= project.dailyLimit;
  const limitPct = project.dailyLimit ? Math.min(100, Math.round((project.todayPrCount / project.dailyLimit) * 100)) : 0;

  function handleSave() {
    const limit = parseInt(dailyLimit, 10);
    const budget = Number(budgetWarnUsd);
    send({
      type: 'setProjectConfig',
      project: project.project,
      config: {
        project: project.project,
        dailyPrLimit: isNaN(limit) ? undefined : limit,
        budgetWarnUsd: budgetWarnUsd.trim() === '' || !Number.isFinite(budget) ? null : budget,
        notes: notes || undefined,
      },
    });
    setDirty(false);
  }

  const repoHealth = project.repoHealth;
  const repoHealthFetchedAt = repoHealth?.lastFetchedAt;
  const repoHealthTooltip = repoHealthFetchedAt
    ? `Updated ${new Date(repoHealthFetchedAt).toLocaleString()}`
    : undefined;
  const repoHealthAgo = repoHealthFetchedAt ? relativeAgo(repoHealthFetchedAt) : undefined;
  const updatedHint = repoHealthAgo ? <span className="project-drawer-stat-hint"> · {repoHealthAgo}</span> : null;

  const tiedIssues = project.openIssuesTiedToActiveTasks ?? 0;
  const tiedPrs = project.openPrsTiedToActiveTasks ?? 0;
  const links = project.activeTaskGithubLinks ?? [];
  const issueLinks = links.filter((l) => l.kind === 'issue');
  const prLinks = links.filter((l) => l.kind === 'pr');
  const linksTooltip = (kindLinks: typeof links): string | undefined => {
    if (kindLinks.length === 0) return undefined;
    const lines = kindLinks.map((l) => `#${l.number} ← ${l.taskName ?? l.taskId.slice(0, 8)}`);
    return repoHealthTooltip ? [...lines, '', repoHealthTooltip].join('\n') : lines.join('\n');
  };

  const visibleTasks = tasksExpanded ? project.recentTasks : project.recentTasks.slice(0, COLLAPSED_TASK_COUNT);
  const hiddenTaskCount = Math.max(0, project.recentTasks.length - COLLAPSED_TASK_COUNT);

  return (
    <div className={`project-drawer${compact ? ' compact' : ''}`} data-testid="project-detail-drawer">
      <div className="project-drawer-header">
        <div className="project-drawer-header-row">
          <h3>{project.displayName}</h3>
          {repoHealth?.repoUrl && (
            <a
              className="project-drawer-repo-link"
              href={repoHealth.repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${repoHealth.repoUrl}`}
              aria-label="Open repository on GitHub"
              data-testid="open-on-github"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          )}
          <button className="project-drawer-close" onClick={onClose} title="Close" aria-label="Close">
            {'×'}
          </button>
        </div>
        {(onLaunchManual || onRunPlaybook || onOpenWorkspace) && (
          <div className="project-drawer-header-actions">
            {onLaunchManual && (
              <button
                className="project-drawer-action project-drawer-action-primary"
                onClick={onLaunchManual}
                data-testid="launch-manual-task-btn"
              >
                Manual task
              </button>
            )}
            {onRunPlaybook && (
              <button className="project-drawer-action" onClick={onRunPlaybook} data-testid="run-playbook-btn">Playbook task</button>
            )}
            {onOpenWorkspace && (
              <button
                className="project-drawer-action project-drawer-action-workspace"
                onClick={onOpenWorkspace}
                data-testid="project-workspace-btn"
              >
                Workspace
              </button>
            )}
          </div>
        )}
        {compact && (
          <div className="project-drawer-compact-stats" aria-label="Project summary">
            <span>{project.activeAgents} agent{project.activeAgents === 1 ? '' : 's'}</span>
            <span>{project.findingCount} finding{project.findingCount === 1 ? '' : 's'}</span>
            <span>{project.openContributionAttempts} contribution attempt{project.openContributionAttempts === 1 ? '' : 's'}</span>
            {tiedIssues > 0 && repoHealth && Number.isFinite(repoHealth.openIssues) && (
              <span data-testid="compact-tied-issues" title={linksTooltip(issueLinks)}>
                {tiedIssues}/{repoHealth.openIssues} issue{tiedIssues === 1 ? '' : 's'}
              </span>
            )}
            {tiedPrs > 0 && repoHealth && Number.isFinite(repoHealth.openPullRequests) && (
              <span data-testid="compact-tied-prs" title={linksTooltip(prLinks)}>
                {tiedPrs}/{repoHealth.openPullRequests} PR{tiedPrs === 1 ? '' : 's'}
              </span>
            )}
          </div>
        )}
      </div>

      {!compact && (
        <section className="project-drawer-stats" aria-label="Project stats">
          <div className={`project-drawer-stat-row${atLimit ? ' at-limit' : ''}`}>
            <span className="project-drawer-stat-label">Today</span>
            <span className="project-drawer-stat-value">
              {project.dailyLimit !== undefined ? (
                <span
                  className="project-drawer-meter"
                  role="progressbar"
                  aria-valuenow={project.todayPrCount}
                  aria-valuemin={0}
                  aria-valuemax={project.dailyLimit}
                  aria-label={`${project.todayPrCount} of ${project.dailyLimit} daily PRs${atLimit ? ' (limit reached)' : ''}`}
                >
                  <span className="project-drawer-meter-track">
                    <span className="project-drawer-meter-fill" style={{ width: `${limitPct}%` }} />
                  </span>
                  <span className="project-drawer-meter-text">{project.todayPrCount}/{project.dailyLimit}</span>
                </span>
              ) : (
                project.todayPrCount
              )}
            </span>
          </div>
          <StatRow label="This week" value={project.weekPrCount} />
          <StatRow label="Open contribution attempts" value={project.openContributionAttempts} />
          <StatRow label="Active agents" value={project.activeAgents} />
          {repoHealth && Number.isFinite(repoHealth.openIssues) && (
            <a
              className="project-drawer-stat-row project-drawer-stat-row-link"
              href={`${repoHealth.repoUrl}/issues`}
              target="_blank"
              rel="noopener noreferrer"
              title={linksTooltip(issueLinks) ?? repoHealthTooltip}
              data-testid="repo-open-issues"
            >
              <span className="project-drawer-stat-label">Open issues</span>
              <span className="project-drawer-stat-value">
                {tiedIssues > 0 ? (
                  <span data-testid="open-issues-tied">
                    <span className="project-drawer-tied-count">{tiedIssues}</span>
                    <span className="project-drawer-tied-sep">/</span>
                    {repoHealth.openIssues}
                  </span>
                ) : (
                  repoHealth.openIssues
                )}
                {updatedHint}
              </span>
            </a>
          )}
          {repoHealth && Number.isFinite(repoHealth.openPullRequests) && (
            <a
              className="project-drawer-stat-row project-drawer-stat-row-link"
              href={`${repoHealth.repoUrl}/pulls`}
              target="_blank"
              rel="noopener noreferrer"
              title={linksTooltip(prLinks) ?? repoHealthTooltip}
              data-testid="repo-open-prs"
            >
              <span className="project-drawer-stat-label">Open PRs</span>
              <span className="project-drawer-stat-value">
                {tiedPrs > 0 ? (
                  <span data-testid="open-prs-tied">
                    <span className="project-drawer-tied-count">{tiedPrs}</span>
                    <span className="project-drawer-tied-sep">/</span>
                    {repoHealth.openPullRequests}
                  </span>
                ) : (
                  repoHealth.openPullRequests
                )}
                {updatedHint}
              </span>
            </a>
          )}
          {project.prLessonsProcessed !== undefined && (
            <StatRow
              label="PR lessons"
              value={`${project.prLessonsProcessed} PRs`}
              hint={project.prLessonsDistillations !== undefined && (
                <span className="project-drawer-stat-hint"> · {project.prLessonsDistillations} distill</span>
              )}
            />
          )}
        </section>
      )}

      {!compact && repoHealth && repoHealth.pendingReviewPrs.length > 0 && (
        <div className="project-drawer-section" data-testid="pending-review-section">
          <h4>Needs your attention</h4>
          <div className="project-drawer-pending-prs">
            {repoHealth.pendingReviewPrs.map((pr) => (
              <a
                key={pr.number}
                className="project-drawer-pending-pr"
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
                title={pr.title}
              >
                <span className="pending-pr-number">#{pr.number}</span>
                <span className="pending-pr-title">{pr.title}</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {!compact && project.recentTasks.length > 0 && (
        <section className="project-drawer-section" aria-labelledby={`recent-agents-${project.project}`}>
          <h4 id={`recent-agents-${project.project}`}>Recent agents</h4>
          <div className="project-drawer-tasks">
            {visibleTasks.map((task) => (<TaskRow key={task.taskId} task={task} />))}
          </div>
          {!tasksExpanded && hiddenTaskCount > 0 && (
            <button className="project-drawer-link" onClick={() => setTasksExpanded(true)}>
              Show {hiddenTaskCount} more
            </button>
          )}
        </section>
      )}

      {!compact && (
        <section className="project-drawer-section" aria-labelledby={`settings-${project.project}`}>
          <h4 id={`settings-${project.project}`}>Settings</h4>
          <div className="project-drawer-setting">
            <label htmlFor={`daily-limit-${project.project}`}>Daily PR cap</label>
            <input
              id={`daily-limit-${project.project}`}
              type="number"
              min="0"
              max="100"
              value={dailyLimit}
              placeholder="—"
              onChange={(e) => { setDailyLimit(e.target.value); setDirty(true); }}
              className="project-drawer-input"
              data-testid="daily-limit-input"
            />
          </div>
          <div className="project-drawer-setting">
            <label htmlFor={`budget-warn-${project.project}`}>Cost warning (USD)</label>
            <input
              id={`budget-warn-${project.project}`}
              type="number"
              min="0"
              step="0.01"
              value={budgetWarnUsd}
              placeholder="Global default"
              onChange={(e) => { setBudgetWarnUsd(e.target.value); setDirty(true); }}
              className="project-drawer-input"
              data-testid="budget-warn-input"
            />
          </div>
          <div className="project-drawer-setting project-drawer-setting-block">
            <label htmlFor={`notes-${project.project}`}>Notes</label>
            <textarea
              id={`notes-${project.project}`}
              value={notes}
              onChange={(e) => { setNotes(e.target.value); setDirty(true); }}
              className="project-drawer-textarea"
              placeholder="Contribution strategy…"
              data-testid="project-notes-input"
            />
          </div>
          {dirty && (
            <button className="btn-primary project-drawer-save" onClick={handleSave} data-testid="save-config">
              Save
            </button>
          )}
        </section>
      )}
    </div>
  );
}
