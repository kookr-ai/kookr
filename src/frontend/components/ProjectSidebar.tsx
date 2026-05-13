import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useKookrStore } from '../store/useStore.js';
import type { ProjectSummary } from '../../shared/protocol.js';
import { Tooltip } from './Tooltip.js';

type DropPosition = 'before' | 'after';

interface DragTarget {
  project: string | null;
  pinned: boolean;
  position: DropPosition;
}

interface ProjectContextMenuProps {
  x: number;
  y: number;
  pinned: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onPinToggle: () => void;
  onHide: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onOpenOrganizer: () => void;
}

function ProjectContextMenu({
  x,
  y,
  pinned,
  canMoveUp,
  canMoveDown,
  onPinToggle,
  onHide,
  onMoveUp,
  onMoveDown,
  onOpenOrganizer,
}: ProjectContextMenuProps) {
  return createPortal(
    <div className="project-sidebar-menu" style={{ top: y, left: x }} role="menu">
      <button className="project-sidebar-menu-item" onClick={onPinToggle} role="menuitem" type="button">
        {pinned ? 'Unpin' : 'Pin to sidebar'}
      </button>
      <button className="project-sidebar-menu-item" onClick={onHide} role="menuitem" type="button">
        Hide from sidebar
      </button>
      <button
        className="project-sidebar-menu-item"
        disabled={!canMoveUp}
        onClick={onMoveUp}
        role="menuitem"
        type="button"
      >
        Move up
      </button>
      <button
        className="project-sidebar-menu-item"
        disabled={!canMoveDown}
        onClick={onMoveDown}
        role="menuitem"
        type="button"
      >
        Move down
      </button>
      <div className="project-sidebar-menu-divider" />
      <button className="project-sidebar-menu-item" onClick={onOpenOrganizer} role="menuitem" type="button">
        Open organizer
      </button>
    </div>,
    document.body,
  );
}

function ProjectIcon({
  summary,
  selected,
  pinned,
  onClick,
  onContextMenu,
  onKeyDown,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  dragActive,
}: {
  summary: ProjectSummary;
  selected: boolean;
  pinned: boolean;
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
  onDragStart: (event: React.DragEvent<HTMLButtonElement>) => void;
  onDragEnd: () => void;
  onDragOver: (event: React.DragEvent<HTMLButtonElement>) => void;
  onDrop: (event: React.DragEvent<HTMLButtonElement>) => void;
  dragActive: boolean;
}) {
  const parts = summary.displayName.split('/');
  const orgChar = parts.length > 1 ? (parts[0]?.charAt(0) ?? '') : '';
  const repoChar = parts[parts.length - 1]?.charAt(0) ?? '?';
  const letter = (orgChar + repoChar).toUpperCase() || '?';
  const hasFindings = summary.findingCount > 0;
  const isActive = summary.activeAgents > 0;
  const taskLoad = getTaskLoad(summary.activeAgents, summary.stalledAgents ?? summary.findingCount);

  const tooltipText = [
    summary.displayName,
    pinned ? 'Pinned' : 'In sidebar',
    `${summary.activeAgents} active agent${summary.activeAgents !== 1 ? 's' : ''}`,
    isActive
      ? `${taskLoad.runningAgents} running · ${taskLoad.stalledAgents} stalled`
      : '0 running · 0 stalled',
    `${summary.findingCount} finding${summary.findingCount !== 1 ? 's' : ''}`,
    summary.dailyLimit !== undefined
      ? `PRs today: ${summary.todayPrCount}/${summary.dailyLimit}`
      : `PRs today: ${summary.todayPrCount}`,
  ].join(' · ');

  return (
    <Tooltip text={tooltipText}>
      <button
        aria-label={summary.displayName}
        className={`project-icon color-${summary.color}${selected ? ' selected' : ''}${!isActive && !hasFindings ? ' inactive' : ''}${dragActive ? ' drag-active' : ''}`}
        data-testid={`project-icon-${summary.project}`}
        draggable
        onClick={onClick}
        onContextMenu={onContextMenu}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragStart={onDragStart}
        onDrop={onDrop}
        onKeyDown={onKeyDown}
        type="button"
      >
        <span className="project-icon-letter">{letter}</span>
        {hasFindings && (
          <span className="project-icon-badge anomaly">{summary.findingCount}</span>
        )}
        {isActive && (
          <TaskCountBadge taskLoad={taskLoad} />
        )}
      </button>
    </Tooltip>
  );
}

interface TaskLoad {
  activeAgents: number;
  runningAgents: number;
  stalledAgents: number;
  label: string;
}

function getTaskLoad(activeAgents: number, stalledAgents: number): TaskLoad {
  const safeActiveAgents = Math.max(0, activeAgents);
  const safeStalledAgents = Math.max(0, Math.min(stalledAgents, safeActiveAgents));
  const runningAgents = Math.max(0, safeActiveAgents - safeStalledAgents);
  return {
    activeAgents: safeActiveAgents,
    runningAgents,
    stalledAgents: safeStalledAgents,
    label: safeStalledAgents > 0 ? `${runningAgents}/${safeActiveAgents}` : `${safeActiveAgents}`,
  };
}

function TaskCountBadge({ taskLoad, pendingCount = 0 }: { taskLoad: TaskLoad; pendingCount?: number }) {
  if (taskLoad.activeAgents <= 0 && pendingCount <= 0) return null;
  const className = [
    'project-icon-task-count',
    taskLoad.stalledAgents > 0 ? 'has-stalled' : '',
    pendingCount > 0 ? 'has-pending' : '',
  ].filter(Boolean).join(' ');
  return (
    <span className={className}>
      {taskLoad.activeAgents > 0 && taskLoad.label}
      {pendingCount > 0 && (
        <span className="project-icon-task-pending">
          {taskLoad.activeAgents > 0 ? `+${pendingCount}` : pendingCount}
        </span>
      )}
    </span>
  );
}

function OrganizerButton({ onManage }: { onManage: () => void }) {
  return (
    <Tooltip text="Organize projects">
      <button
        aria-label="Organize projects"
        className="project-sidebar-organizer"
        data-testid="project-sidebar-organizer"
        onClick={onManage}
        type="button"
      >
        ⋮
      </button>
    </Tooltip>
  );
}

interface Props {
  onManage: () => void;
  /**
   * Called when the user requests to adjust the server concurrency cap (e.g.
   * via right-click on the all-projects icon). The parent owns navigation —
   * typically opens Settings deep-linked to the maxActiveTasks field.
   */
  onAdjustCap?: () => void;
}

export function ProjectSidebar({ onManage, onAdjustCap }: Props) {
  const {
    visibleProjectSummaries,
    projectSummaries,
    projectSidebarRows,
    selectedProject,
    selectProject,
    projectSidebarVisible,
    pinProjectToTop,
    unpinSidebarProject,
    hideSidebarProject,
    moveSidebarProject,
    reorderSidebarProject,
    agents,
    maxActiveTasks,
  } = useKookrStore();
  const pendingCount = useMemo(
    () => agents.filter((a) => a.taskStatus === 'pending').length,
    [agents],
  );
  // Count compared against `maxActiveTasks` must match the launch-service
  // gate (`TaskStore.getActiveCount()` in src/core/tasks.ts) so the indicator
  // doesn't lie. The project-summary `activeAgents` filters out snoozed
  // tasks, which would let the gauge show "9/10" while the server actually
  // queues the next launch. Count raw inProgress agents instead.
  const cappedCount = useMemo(
    () => agents.filter((a) => a.taskStatus === 'inProgress').length,
    [agents],
  );

  const [menuProjectId, setMenuProjectId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
  const visibleRowMap = useMemo(() => {
    const rowMap = new Map<string, (typeof projectSidebarRows)[number]>();
    for (const row of projectSidebarRows) {
      if (!row.hidden && !row.offline) rowMap.set(row.project, row);
    }
    return rowMap;
  }, [projectSidebarRows]);

  const pinnedSummaries = useMemo(
    () => visibleProjectSummaries.filter((summary) => visibleRowMap.get(summary.project)?.pinned),
    [visibleProjectSummaries, visibleRowMap],
  );
  const unpinnedSummaries = useMemo(
    () => visibleProjectSummaries.filter((summary) => !visibleRowMap.get(summary.project)?.pinned),
    [visibleProjectSummaries, visibleRowMap],
  );
  const allTaskLoad = useMemo(() => {
    return projectSummaries.reduce(
      (total, summary) => {
        const projectTaskLoad = getTaskLoad(
          summary.activeAgents,
          summary.stalledAgents ?? summary.findingCount,
        );
        return getTaskLoad(
          total.activeAgents + projectTaskLoad.activeAgents,
          total.stalledAgents + projectTaskLoad.stalledAgents,
        );
      },
      getTaskLoad(0, 0),
    );
  }, [projectSummaries]);
  // Capacity context for the all-projects icon. `hasLimit` gates the cap UI
  // until the first snapshot carries `maxActiveTasks` (the store treats 0 as
  // unknown — see TransportSessionSlice.maxActiveTasks docs).
  const hasLimit = maxActiveTasks > 0;
  const atCap = hasLimit && cappedCount >= maxActiveTasks;
  const hasPending = pendingCount > 0;
  const capLabel = hasLimit ? `${cappedCount}/${maxActiveTasks} of cap` : `${cappedCount} active`;
  const queueSegment = hasPending
    ? `${pendingCount} queued${atCap ? ', waiting for a slot' : ''}`
    : (atCap ? 'at capacity, new launches will queue' : null);
  const canAdjustCap = Boolean(onAdjustCap) && hasLimit;
  const adjustHint = canAdjustCap ? 'Right-click or Shift+F10 to adjust cap' : null;
  const allTooltipText = [
    'All Projects',
    `${allTaskLoad.activeAgents} active agent${allTaskLoad.activeAgents !== 1 ? 's' : ''}`,
    `${allTaskLoad.runningAgents} running · ${allTaskLoad.stalledAgents} stalled`,
    capLabel,
    queueSegment,
    adjustHint,
  ].filter((s): s is string => Boolean(s)).join(' · ');
  // Surface the at-cap / queued state in the accessible name so SR users
  // get the same information mouse users get from the red ring + badge.
  const allAriaLabel = [
    'All Projects',
    hasLimit ? capLabel : null,
    hasPending ? `${pendingCount} queued` : null,
    atCap ? 'at capacity' : null,
  ].filter((s): s is string => Boolean(s)).join(', ');

  function handleAllProjectsAdjust(event: React.SyntheticEvent) {
    if (!onAdjustCap || !hasLimit) return;
    event.preventDefault();
    onAdjustCap();
  }
  function handleAllProjectsKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    // Keyboard equivalent of right-click — mirrors handleProjectMenuKey
    // below so the deep-link is reachable without a pointing device.
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      handleAllProjectsAdjust(event);
    }
  }

  const menuRow = menuProjectId ? visibleRowMap.get(menuProjectId) ?? null : null;
  const menuSection = menuRow?.pinned ? pinnedSummaries : unpinnedSummaries;
  const menuIndex = menuProjectId ? menuSection.findIndex((summary) => summary.project === menuProjectId) : -1;

  useEffect(() => {
    if (!menuProjectId) return undefined;

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.project-sidebar-menu')) return;
      setMenuProjectId(null);
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuProjectId(null);
    }

    window.addEventListener('mousedown', handlePointerDown, true);
    window.addEventListener('keydown', handleEscape, true);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown, true);
      window.removeEventListener('keydown', handleEscape, true);
    };
  }, [menuProjectId]);

  if (!projectSidebarVisible || projectSidebarRows.length === 0) return null;

  function openMenu(projectId: string, x: number, y: number) {
    setMenuProjectId(projectId);
    setMenuPosition({ x, y });
  }

  function handleProjectContextMenu(projectId: string, event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    openMenu(projectId, event.clientX, event.clientY);
  }

  function handleProjectMenuKey(projectId: string, event: React.KeyboardEvent<HTMLButtonElement>) {
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openMenu(projectId, rect.right + 8, rect.top);
    }
  }

  function handleDragStart(projectId: string, event: React.DragEvent<HTMLButtonElement>) {
    setMenuProjectId(null);
    setDraggingProjectId(projectId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', projectId);
  }

  function handleDragEnd() {
    setDraggingProjectId(null);
    setDragTarget(null);
  }

  function updateDragTarget(
    event: React.DragEvent<HTMLElement>,
    project: string | null,
    pinned: boolean,
  ) {
    if (!draggingProjectId || draggingProjectId === project) return;
    event.preventDefault();
    const position: DropPosition = (() => {
      if (!project) return 'after';
      const rect = event.currentTarget.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    })();
    setDragTarget({ project, pinned, position });
  }

  function commitDrop(targetPinned: boolean, targetProject: string | null, position: DropPosition) {
    if (!draggingProjectId || draggingProjectId === targetProject) return;
    reorderSidebarProject(draggingProjectId, targetPinned, targetProject, position);
    setDraggingProjectId(null);
    setDragTarget(null);
  }

  function renderProject(summary: ProjectSummary, pinned: boolean) {
    const isDragTarget = dragTarget?.project === summary.project;
    const targetClass = isDragTarget ? `project-sidebar-drop-target ${dragTarget.position}` : '';

    return (
      <div key={summary.project} className={targetClass}>
        <ProjectIcon
          summary={summary}
          pinned={pinned}
          selected={selectedProject === summary.project}
          dragActive={draggingProjectId === summary.project}
          onClick={() => selectProject(summary.project)}
          onContextMenu={(event) => handleProjectContextMenu(summary.project, event)}
          onDragEnd={handleDragEnd}
          onDragOver={(event) => updateDragTarget(event, summary.project, pinned)}
          onDragStart={(event) => handleDragStart(summary.project, event)}
          onDrop={(event) => {
            event.preventDefault();
            const position = dragTarget?.project === summary.project ? dragTarget.position : 'after';
            commitDrop(pinned, summary.project, position);
          }}
          onKeyDown={(event) => handleProjectMenuKey(summary.project, event)}
        />
      </div>
    );
  }

  function renderSectionDropZone(targetPinned: boolean) {
    if (!draggingProjectId) return null;
    const isTarget = dragTarget?.project === null && dragTarget?.pinned === targetPinned;
    return (
      <div
        className={`project-sidebar-drop-zone${isTarget ? ' active' : ''}`}
        onDragOver={(event) => updateDragTarget(event, null, targetPinned)}
        onDrop={(event) => {
          event.preventDefault();
          commitDrop(targetPinned, null, 'after');
        }}
      />
    );
  }

  return (
    <div className="project-sidebar kookr-tour-target-layout" data-testid="project-sidebar">
      <Tooltip text={allTooltipText}>
        <button
          aria-label={allAriaLabel}
          className={[
            'project-icon',
            'all',
            selectedProject === null ? 'selected' : '',
            atCap ? 'at-cap' : '',
          ].filter(Boolean).join(' ')}
          data-testid="project-icon-all"
          onClick={() => selectProject(null)}
          onContextMenu={canAdjustCap ? handleAllProjectsAdjust : undefined}
          onKeyDown={canAdjustCap ? handleAllProjectsKeyDown : undefined}
          type="button"
        >
          <span className="project-icon-letter">*</span>
          <TaskCountBadge taskLoad={allTaskLoad} pendingCount={pendingCount} />
        </button>
      </Tooltip>

      <div className="project-sidebar-section">
        {pinnedSummaries.map((summary) => renderProject(summary, true))}
        {renderSectionDropZone(true)}
      </div>

      {pinnedSummaries.length > 0 && unpinnedSummaries.length > 0 && (
        <div className="project-sidebar-divider" />
      )}

      <div className="project-sidebar-section">
        {unpinnedSummaries.map((summary) => renderProject(summary, false))}
        {renderSectionDropZone(false)}
      </div>

      <div className="project-sidebar-spacer" />
      <OrganizerButton onManage={onManage} />

      {menuProjectId && menuRow && (
        <ProjectContextMenu
          canMoveDown={menuIndex >= 0 && menuIndex < menuSection.length - 1}
          canMoveUp={menuIndex > 0}
          pinned={menuRow.pinned}
          x={menuPosition.x}
          y={menuPosition.y}
          onHide={() => {
            hideSidebarProject(menuProjectId);
            setMenuProjectId(null);
          }}
          onMoveDown={() => {
            moveSidebarProject(menuProjectId, 'down');
            setMenuProjectId(null);
          }}
          onMoveUp={() => {
            moveSidebarProject(menuProjectId, 'up');
            setMenuProjectId(null);
          }}
          onOpenOrganizer={() => {
            onManage();
            setMenuProjectId(null);
          }}
          onPinToggle={() => {
            if (menuRow.pinned) {
              unpinSidebarProject(menuProjectId);
            } else {
              pinProjectToTop(menuProjectId);
            }
            setMenuProjectId(null);
          }}
        />
      )}
    </div>
  );
}
