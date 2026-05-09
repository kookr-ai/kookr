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
  const atLimit = summary.dailyLimit !== undefined && summary.todayPrCount >= summary.dailyLimit;
  const nearLimit = summary.dailyLimit !== undefined && summary.todayPrCount >= summary.dailyLimit - 1;

  const tooltipText = [
    summary.displayName,
    pinned ? 'Pinned' : 'In sidebar',
    `${summary.activeAgents} active agent${summary.activeAgents !== 1 ? 's' : ''}`,
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
        {isActive && !hasFindings && (
          <span className="project-icon-dot active" />
        )}
        {summary.dailyLimit !== undefined && summary.todayPrCount > 0 && (
          <span className={`project-icon-pr-count${atLimit ? ' exceeded' : nearLimit ? ' approaching' : ''}`}>
            {summary.todayPrCount}/{summary.dailyLimit}
          </span>
        )}
      </button>
    </Tooltip>
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
}

export function ProjectSidebar({ onManage }: Props) {
  const {
    visibleProjectSummaries,
    projectSidebarRows,
    selectedProject,
    selectProject,
    projectSidebarVisible,
    pinProjectToTop,
    unpinSidebarProject,
    hideSidebarProject,
    moveSidebarProject,
    reorderSidebarProject,
  } = useKookrStore();

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
      <Tooltip text="All Projects">
        <button
          aria-label="All Projects"
          className={`project-icon all${selectedProject === null ? ' selected' : ''}`}
          data-testid="project-icon-all"
          onClick={() => selectProject(null)}
          type="button"
        >
          <span className="project-icon-letter">*</span>
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
