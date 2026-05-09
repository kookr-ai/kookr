import React, { useState, useEffect } from 'react';
import { useKookrStore } from '../store/useStore.js';
import type { ProjectSummary, ClientMessage } from '../../shared/protocol.js';

interface Props {
  project: ProjectSummary;
  onClose: () => void;
  send: (msg: ClientMessage) => void;
  onOpenWorkspace?: () => void;
  onRunPlaybook?: () => void;
  compact?: boolean;
}

function ContributionDay({ date, count }: { date: string; count: number }) {
  const dayName = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
  return (
    <div className="contrib-day">
      <span className="contrib-day-name">{dayName}</span>
      <span className="contrib-day-count">
        {count > 0 ? `${count} PR${count !== 1 ? 's' : ''}` : '--'}
      </span>
    </div>
  );
}

export function ProjectDetailDrawer({ project, onClose, send, onOpenWorkspace, onRunPlaybook, compact = false }: Props) {
  const [dailyLimit, setDailyLimit] = useState<string>(
    project.dailyLimit?.toString() ?? '2',
  );
  const [notes, setNotes] = useState(project.notes ?? '');
  const [dirty, setDirty] = useState(false);

  // Build last 7 days timeline
  const timeline: Array<{ date: string; count: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    timeline.push({ date: dateStr, count: 0 });
  }

  const atLimit = project.dailyLimit !== undefined && project.todayPrCount >= project.dailyLimit;

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

  return (
    <div className={`project-drawer${compact ? ' compact' : ''}`} data-testid="project-detail-drawer">
      <div className="project-drawer-header">
        <div className="project-drawer-header-row">
          <h3>{project.displayName}</h3>
          <button className="project-drawer-close" onClick={onClose} title="Close" aria-label="Close">
            {'×'}
          </button>
        </div>
        {(onRunPlaybook || onOpenWorkspace) && (
          <div className="project-drawer-header-actions">
            {onRunPlaybook && (
              <button className="btn-xs btn-primary" onClick={onRunPlaybook} data-testid="run-playbook-btn">Run playbook...</button>
            )}
            {onOpenWorkspace && (
              <button className="btn-xs btn-workspace" onClick={onOpenWorkspace}>Workspace</button>
            )}
          </div>
        )}
        {compact && (
          <div className="project-drawer-compact-stats" aria-label="Project summary">
            <span>{project.activeAgents} agent{project.activeAgents === 1 ? '' : 's'}</span>
            <span>{project.findingCount} finding{project.findingCount === 1 ? '' : 's'}</span>
            <span>{project.openPrs} open PR{project.openPrs === 1 ? '' : 's'}</span>
          </div>
        )}
      </div>

      {!compact && <div className="project-drawer-stats">
        <div className={`project-drawer-stat${atLimit ? ' exceeded' : ''}`}>
          <span className="stat-label">Today's PRs</span>
          <span className="stat-value">
            {project.todayPrCount}{project.dailyLimit !== undefined ? `/${project.dailyLimit}` : ''}
            {atLimit && <span className="limit-badge">LIMIT</span>}
          </span>
        </div>
        <div className="project-drawer-stat">
          <span className="stat-label">This week</span>
          <span className="stat-value">{project.weekPrCount}</span>
        </div>
        <div className="project-drawer-stat">
          <span className="stat-label">Open PRs</span>
          <span className="stat-value">{project.openPrs}</span>
        </div>
        <div className="project-drawer-stat">
          <span className="stat-label">Active agents</span>
          <span className="stat-value">{project.activeAgents}</span>
        </div>
        {project.prLessonsProcessed !== undefined && (
          <div className="project-drawer-stat">
            <span className="stat-label">PR lessons</span>
            <span className="stat-value">
              {project.prLessonsProcessed} PRs
              {project.prLessonsDistillations !== undefined && ` / ${project.prLessonsDistillations} distill`}
            </span>
          </div>
        )}
      </div>}

      {!compact && <div className="project-drawer-section">
        <h4>Contribution History</h4>
        <div className="contrib-timeline">
          {timeline.map((day) => (
            <ContributionDay key={day.date} date={day.date} count={day.count} />
          ))}
        </div>
      </div>}

      {!compact && <div className="project-drawer-section">
        <h4>Settings</h4>
        <label className="project-drawer-label">
          Daily limit
          <input
            type="number"
            min="0"
            max="20"
            value={dailyLimit}
            onChange={(e) => { setDailyLimit(e.target.value); setDirty(true); }}
            className="project-drawer-input"
            data-testid="daily-limit-input"
          />
        </label>
        <label className="project-drawer-label">
          Notes
          <textarea
            value={notes}
            onChange={(e) => { setNotes(e.target.value); setDirty(true); }}
            className="project-drawer-textarea"
            placeholder="Contribution strategy notes..."
            data-testid="project-notes-input"
          />
        </label>
        {dirty && (
          <button className="btn-primary btn-xs" onClick={handleSave} data-testid="save-config">
            Save
          </button>
        )}
      </div>}

      {!compact && project.recentTasks.length > 0 && (
        <div className="project-drawer-section">
          <h4>Recent Tasks</h4>
          <div className="project-drawer-tasks">
            {project.recentTasks.map((task) => (
              <div key={task.taskId} className="project-drawer-task">
                <span className={`task-status-dot ${task.status}`} />
                <span className="task-name">{task.name ?? task.taskId.slice(0, 8)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
