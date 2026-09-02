import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useKookrStore } from '../store/useStore.js';
import { useProjectNotificationMute } from '../hooks/useProjectNotificationMute.js';
import type { ProjectSummary } from '../../shared/protocol.js';
import { Tooltip } from './Tooltip.js';
import { formatCost } from '../presentation.js';

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
  muted: boolean;
  onPinToggle: () => void;
  onMuteToggle: () => void;
  onHide: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onOpenOrganizer: () => void;
  onClose: (restoreFocus: boolean) => void;
}

function ProjectContextMenu({
  x,
  y,
  pinned,
  canMoveUp,
  canMoveDown,
  muted,
  onPinToggle,
  onMuteToggle,
  onHide,
  onMoveUp,
  onMoveDown,
  onOpenOrganizer,
  onClose,
}: ProjectContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLButtonElement>('.project-sidebar-menu-item:not(:disabled)')
      ?.focus();
  }, []);

  function focusMenuItem(direction: 1 | -1): void {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('.project-sidebar-menu-item:not(:disabled)') ?? [],
    );
    if (items.length === 0) return;
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + direction + items.length) % items.length;
    items[nextIndex]?.focus();
  }

  function focusMenuBoundary(position: 'first' | 'last'): void {
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('.project-sidebar-menu-item:not(:disabled)') ?? [],
    );
    const item = position === 'first' ? items[0] : items[items.length - 1];
    item?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusMenuItem(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusMenuItem(-1);
        break;
      case 'Home':
        event.preventDefault();
        focusMenuBoundary('first');
        break;
      case 'End':
        event.preventDefault();
        focusMenuBoundary('last');
        break;
      case 'Escape':
        event.preventDefault();
        onClose(true);
        break;
    }
  }

  return createPortal(
    <div
      ref={menuRef}
      className="project-sidebar-menu"
      style={{ top: y, left: x }}
      role="menu"
      onKeyDown={handleKeyDown}
    >
      <button className="project-sidebar-menu-item" onClick={onPinToggle} role="menuitem" type="button">
        {pinned ? 'Unpin' : 'Pin to sidebar'}
      </button>
      <button className="project-sidebar-menu-item" onClick={onMuteToggle} role="menuitem" type="button">
        {muted ? 'Unmute notifications' : 'Mute notifications'}
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
  muted,
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
  muted: boolean;
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
    muted ? 'Notifications muted' : null,
    summary.automationEnabled === false ? 'Automation paused' : null,
    `${summary.activeAgents} active agent${summary.activeAgents !== 1 ? 's' : ''}`,
    isActive
      ? `${taskLoad.runningAgents} running · ${taskLoad.stalledAgents} stalled`
      : '0 running · 0 stalled',
    `${summary.findingCount} finding${summary.findingCount !== 1 ? 's' : ''}`,
    summary.dailyLimit !== undefined
      ? `PRs today: ${summary.todayPrCount}/${summary.dailyLimit}`
      : `PRs today: ${summary.todayPrCount}`,
    summary.costUsd !== undefined || (summary.budgetWarnUsd !== undefined && summary.budgetWarnUsd > 0)
      ? (summary.budgetWarnUsd !== undefined && summary.budgetWarnUsd > 0
        ? `Spend: ${formatCost(summary.costUsd ?? 0)}/${formatCost(summary.budgetWarnUsd)}`
        : `Spend: ${formatCost(summary.costUsd ?? 0)}`)
      : null,
  ].filter((part): part is string => Boolean(part)).join(' · ');

  return (
    <Tooltip text={tooltipText}>
      <button
        aria-label={[
          summary.displayName,
          muted ? 'notifications muted' : null,
          summary.automationEnabled === false ? 'automation paused' : null,
        ].filter(Boolean).join(', ')}
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
        {summary.automationEnabled === false && (
          <span
            className="project-icon-paused"
            data-testid={`project-automation-paused-${summary.project}`}
            aria-label="Project automation paused"
          />
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

/**
 * Decide whether a sidebar project row should stay visible for a typed query.
 *
 * Empty or whitespace-only queries match everything. Otherwise we do a
 * case-insensitive substring check against the project's display name and,
 * when present, its local checkout path — the two labels operators already
 * recognize in a dense multi-repo rail.
 */
export function projectMatchesSidebarFilter(
  summary: Pick<ProjectSummary, 'displayName' | 'localPath'>,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  if (summary.displayName.toLowerCase().includes(needle)) return true;
  const localPath = summary.localPath;
  return typeof localPath === 'string' && localPath.toLowerCase().includes(needle);
}

function ProjectSidebarFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });

  function syncAnchor(): void {
    const rect = inputRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({ top: rect.top, left: rect.left });
  }

  useEffect(() => {
    if (!focused) return undefined;
    function handleViewportChange(): void {
      const rect = inputRef.current?.getBoundingClientRect();
      if (!rect) return;
      setAnchor({ top: rect.top, left: rect.left });
    }
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [focused]);

  return (
    <label className={`project-sidebar-filter${value.trim() ? ' has-query' : ''}`}>
      <span className="sr-only">Filter projects</span>
      <input
        ref={inputRef}
        type="search"
        className="project-sidebar-filter-input"
        data-testid="project-sidebar-filter"
        placeholder="Filter"
        autoComplete="off"
        spellCheck={false}
        value={value}
        style={focused ? { position: 'fixed', top: anchor.top, left: anchor.left } : undefined}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => {
          syncAnchor();
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          onChange('');
        }}
      />
    </label>
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
  const projectMute = useProjectNotificationMute();
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
  // Capacity breakdown (issue #1526 Phase B / FM9): during the 2026-07-24
  // deadlock this exact number — cappedCount — read "12 running" while the
  // truth was 11 finished-awaiting-ack + 1 hung + 0 actually working. Derived
  // client-side from the same `agents`/`stuckReason` the WS snapshot already
  // carries (server: core/stuck-reason.ts), mirroring `GET /api/health`'s
  // `capacity.byClass` aggregate without a separate fetch.
  const finishedAwaitingAckCount = useMemo(
    () => agents.filter((a) => a.taskStatus === 'inProgress' && a.stuckReason === 'awaiting_completion_ack').length,
    [agents],
  );
  const hungSuspectCount = useMemo(
    () => agents.filter((a) => a.taskStatus === 'inProgress' && a.stuckReason === 'hung_suspect').length,
    [agents],
  );

  const [menuProjectId, setMenuProjectId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const [draggingProjectId, setDraggingProjectId] = useState<string | null>(null);
  const [dragTarget, setDragTarget] = useState<DragTarget | null>(null);
  // Session-only: sidebar prefs have no filter key, and the issue allows
  // keeping the query out of persisted sidebar state.
  const [filterQuery, setFilterQuery] = useState('');
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
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
  const filteredPinnedSummaries = useMemo(
    () => pinnedSummaries.filter((summary) => projectMatchesSidebarFilter(summary, filterQuery)),
    [pinnedSummaries, filterQuery],
  );
  const filteredUnpinnedSummaries = useMemo(
    () => unpinnedSummaries.filter((summary) => projectMatchesSidebarFilter(summary, filterQuery)),
    [unpinnedSummaries, filterQuery],
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
  // Only rendered when at least one task isn't genuinely working — an empty
  // breakdown (the common case) adds nothing over `capLabel` alone.
  const capacityBreakdownSegment = [
    finishedAwaitingAckCount > 0 ? `${finishedAwaitingAckCount} awaiting ack` : null,
    hungSuspectCount > 0 ? `${hungSuspectCount} hung?` : null,
  ].filter((s): s is string => Boolean(s)).join(', ') || null;
  const canAdjustCap = Boolean(onAdjustCap) && hasLimit;
  const adjustHint = canAdjustCap ? 'Right-click or Shift+F10 to adjust cap' : null;
  const allTooltipText = [
    'All Projects',
    `${allTaskLoad.activeAgents} active agent${allTaskLoad.activeAgents !== 1 ? 's' : ''}`,
    `${allTaskLoad.runningAgents} running · ${allTaskLoad.stalledAgents} stalled`,
    capLabel,
    capacityBreakdownSegment,
    queueSegment,
    adjustHint,
  ].filter((s): s is string => Boolean(s)).join(' · ');
  // Surface the at-cap / queued state in the accessible name so SR users
  // get the same information mouse users get from the red ring + badge.
  const allAriaLabel = [
    'All Projects',
    hasLimit ? capLabel : null,
    capacityBreakdownSegment,
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

  const filterActive = filterQuery.trim() !== '';
  const menuRow = menuProjectId ? visibleRowMap.get(menuProjectId) ?? null : null;
  const menuSection = menuRow?.pinned ? pinnedSummaries : unpinnedSummaries;
  const menuIndex = menuProjectId ? menuSection.findIndex((summary) => summary.project === menuProjectId) : -1;

  useEffect(() => {
    if (!menuProjectId) return undefined;

    function handlePointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.project-sidebar-menu')) return;
      closeMenu(false);
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') closeMenu(true);
    }

    window.addEventListener('mousedown', handlePointerDown, true);
    window.addEventListener('keydown', handleEscape, true);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown, true);
      window.removeEventListener('keydown', handleEscape, true);
    };
  }, [menuProjectId]);

  if (!projectSidebarVisible || projectSidebarRows.length === 0) return null;

  function closeMenu(restoreFocus: boolean): void {
    const trigger = menuTriggerRef.current;
    setMenuProjectId(null);
    menuTriggerRef.current = null;
    if (restoreFocus) {
      trigger?.focus();
    }
  }

  function openMenu(projectId: string, x: number, y: number, trigger: HTMLButtonElement) {
    menuTriggerRef.current = trigger;
    setMenuProjectId(projectId);
    setMenuPosition({ x, y });
  }

  function handleProjectContextMenu(projectId: string, event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    openMenu(projectId, event.clientX, event.clientY, event.currentTarget);
  }

  function handleProjectMenuKey(projectId: string, event: React.KeyboardEvent<HTMLButtonElement>) {
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openMenu(projectId, rect.right + 8, rect.top, event.currentTarget);
    }
  }

  function handleDragStart(projectId: string, event: React.DragEvent<HTMLButtonElement>) {
    if (filterActive) {
      event.preventDefault();
      return;
    }
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
          muted={projectMute.isMuted(summary.project)}
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

      <ProjectSidebarFilter value={filterQuery} onChange={setFilterQuery} />
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {filterQuery.trim() === ''
          ? ''
          : `${filteredPinnedSummaries.length + filteredUnpinnedSummaries.length} of ${visibleProjectSummaries.length} projects`}
      </span>

      <div className="project-sidebar-section">
        {filteredPinnedSummaries.map((summary) => renderProject(summary, true))}
        {renderSectionDropZone(true)}
      </div>

      {filteredPinnedSummaries.length > 0 && filteredUnpinnedSummaries.length > 0 && (
        <div className="project-sidebar-divider" />
      )}

      <div className="project-sidebar-section">
        {filteredUnpinnedSummaries.map((summary) => renderProject(summary, false))}
        {renderSectionDropZone(false)}
      </div>

      <div className="project-sidebar-spacer" />
      <OrganizerButton onManage={onManage} />

      {menuProjectId && menuRow && (
        <ProjectContextMenu
          canMoveDown={!filterActive && menuIndex >= 0 && menuIndex < menuSection.length - 1}
          canMoveUp={!filterActive && menuIndex > 0}
          muted={projectMute.isMuted(menuProjectId)}
          pinned={menuRow.pinned}
          x={menuPosition.x}
          y={menuPosition.y}
          onHide={() => {
            hideSidebarProject(menuProjectId);
            closeMenu(true);
          }}
          onMoveDown={() => {
            moveSidebarProject(menuProjectId, 'down');
            closeMenu(true);
          }}
          onMoveUp={() => {
            moveSidebarProject(menuProjectId, 'up');
            closeMenu(true);
          }}
          onMuteToggle={() => {
            projectMute.toggle(menuProjectId);
            closeMenu(true);
          }}
          onOpenOrganizer={() => {
            onManage();
            closeMenu(true);
          }}
          onPinToggle={() => {
            if (menuRow.pinned) {
              unpinSidebarProject(menuProjectId);
            } else {
              pinProjectToTop(menuProjectId);
            }
            closeMenu(true);
          }}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
