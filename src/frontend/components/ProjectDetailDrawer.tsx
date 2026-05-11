import React, { useState } from 'react';
import type { ProjectSummary, ClientMessage, TaskSummary } from '../../shared/protocol.js';

interface Props {
  project: ProjectSummary;
  onClose: () => void;
  send: (msg: ClientMessage) => void;
  onOpenWorkspace?: () => void;
  onRunPlaybook?: () => void;
}

const COLLAPSED_TASK_COUNT = 3;

function relativeDays(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const days = Math.floor(diffMs / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
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

export function ProjectDetailDrawer({ project, onClose, send, onOpenWorkspace, onRunPlaybook }: Props) {
  const [dailyLimit, setDailyLimit] = useState<string>(project.dailyLimit?.toString() ?? '');
  const [notes, setNotes] = useState(project.notes ?? '');
  const [dirty, setDirty] = useState(false);
  const [tasksExpanded, setTasksExpanded] = useState(false);

  const atLimit = project.dailyLimit !== undefined && project.todayPrCount >= project.dailyLimit;
  const showWeek = project.weekPrCount > 0;
  const showOpenPrs = project.openPrs > 0;
  const showPrLessons = project.prLessonsProcessed !== undefined;
  const showToday = project.dailyLimit !== undefined || project.todayPrCount > 0;
  const hasAnyStat = showToday || showWeek || showOpenPrs || showPrLessons;

  const visibleTasks = tasksExpanded ? project.recentTasks : project.recentTasks.slice(0, COLLAPSED_TASK_COUNT);
  const hiddenTaskCount = Math.max(0, project.recentTasks.length - COLLAPSED_TASK_COUNT);

  function handleSave() {
    const limit = parseInt(dailyLimit, 10);
    send({
      type: 'setProjectConfig',
      project: project.project,
      config: {
        project: project.project,
        dailyPrLimit: isNaN(limit) ? undefined : limit,
        notes: notes || undefined,
      },
    });
    setDirty(false);
  }

  const subParts: string[] = [];
  if (project.lastContribution) subParts.push(`Last PR ${relativeDays(project.lastContribution)}`);
  if (project.activeAgents > 0) subParts.push(`${project.activeAgents} running`);
  if (project.findingCount > 0) subParts.push(`${project.findingCount} finding${project.findingCount === 1 ? '' : 's'}`);
  if (subParts.length === 0) subParts.push('Idle');

  const limitPct = project.dailyLimit ? Math.min(100, Math.round((project.todayPrCount / project.dailyLimit) * 100)) : 0;

  return (
    <div className="project-drawer" data-testid="project-detail-drawer">
      <header className="project-drawer-head">
        <h3 className="project-drawer-title" title={project.displayName}>{project.displayName}</h3>
        <button className="project-drawer-close" onClick={onClose} title="Close" aria-label="Close">×</button>
        <div className="project-drawer-sub">{subParts.join(' · ')}</div>
      </header>

      {(onRunPlaybook || onOpenWorkspace) && (
        <div className="project-drawer-actions">
          {onRunPlaybook && (
            <button className="btn-primary project-drawer-cta" onClick={onRunPlaybook} data-testid="run-playbook-btn">
              Run playbook
            </button>
          )}
          {onOpenWorkspace && (
            <button className="project-drawer-link btn-workspace" onClick={onOpenWorkspace}>Workspace</button>
          )}
        </div>
      )}

      {hasAnyStat && (
        <section className="project-drawer-stats" aria-label="Project stats">
          {showToday && (
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
          )}
          {showWeek && <StatRow label="This week" value={project.weekPrCount} />}
          {showOpenPrs && <StatRow label="Open PRs" value={project.openPrs} />}
          {showPrLessons && (
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

      {project.recentTasks.length > 0 && (
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
    </div>
  );
}
