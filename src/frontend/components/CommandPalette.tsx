import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import {
  filterActions,
  filterFindings,
  filterProjects,
  filterTasks,
  groupActionsBySection,
  type CommandAction,
  type CommandFindingItem,
  type CommandProjectItem,
  type CommandTaskItem,
} from './command-palette-model.js';
import { taskStatusLabel } from '../presentation.js';

interface CommandPaletteProps {
  actions: CommandAction[];
  tasks: CommandTaskItem[];
  findings: CommandFindingItem[];
  projects: CommandProjectItem[];
  onSelectTask: (agentId: string, taskId: string) => void;
  onSelectFinding: (agentId: string, taskId?: string | null) => void;
  onSelectProject: (projectId: string) => void;
  /**
   * Launch a manual task scoped to a project, reusing the project drawer's
   * launch flow. When omitted, the palette hides the per-project launch action.
   */
  onLaunchProject?: (projectId: string) => void;
  onClose: () => void;
}

type SelectableItem =
  | { kind: 'action'; action: CommandAction }
  | { kind: 'task'; task: CommandTaskItem }
  | { kind: 'finding'; finding: CommandFindingItem }
  | { kind: 'project'; project: CommandProjectItem }
  | { kind: 'projectLaunch'; project: CommandProjectItem };

type RenderRow =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'item'; key: string; index: number; item: SelectableItem };

/**
 * The unified command palette (top-bar redesign). Opened from the top-bar
 * "Search actions & tasks" field or ⌘K / Ctrl+K. Empty query → a browsable,
 * categorised list of every action that used to live as a top-bar icon. Typing
 * filters and ranks actions, tasks, active findings, and projects.
 * ↑/↓ move, ↵ runs, Esc closes.
 */
export function CommandPalette({
  actions,
  tasks,
  findings,
  projects,
  onSelectTask,
  onSelectFinding,
  onSelectProject,
  onLaunchProject,
  onClose,
}: CommandPaletteProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const paletteId = useId();
  const listId = `${paletteId}-listbox`;

  useEscapeToClose(onClose);
  useDialogFocus({ dialogRef, initialFocusRef: inputRef });

  const { rows, selectable } = useMemo(() => {
    const matchedActions = filterActions(actions, query);
    const matchedTasks = filterTasks(tasks, query);
    const matchedFindings = filterFindings(findings, query);
    const matchedProjects = filterProjects(projects, query);
    const browse = query.trim().length === 0;

    const rows: RenderRow[] = [];
    const selectable: SelectableItem[] = [];
    const pushAction = (action: CommandAction): void => {
      const index = selectable.length;
      selectable.push({ kind: 'action', action });
      rows.push({ kind: 'item', key: `action-${action.id}`, index, item: { kind: 'action', action } });
    };

    if (browse) {
      for (const group of groupActionsBySection(matchedActions)) {
        rows.push({ kind: 'header', key: `h-${group.section}`, label: group.label });
        group.actions.forEach(pushAction);
      }
    } else {
      if (matchedActions.length > 0) {
        rows.push({ kind: 'header', key: 'h-actions', label: 'Actions' });
        matchedActions.forEach(pushAction);
      }
      if (matchedTasks.length > 0) {
        rows.push({ kind: 'header', key: 'h-tasks', label: 'Tasks' });
        for (const task of matchedTasks) {
          const index = selectable.length;
          selectable.push({ kind: 'task', task });
          rows.push({ kind: 'item', key: `task-${task.taskId}`, index, item: { kind: 'task', task } });
        }
      }
      if (matchedFindings.length > 0) {
        rows.push({ kind: 'header', key: 'h-findings', label: 'Findings' });
        for (const finding of matchedFindings) {
          const index = selectable.length;
          selectable.push({ kind: 'finding', finding });
          rows.push({ kind: 'item', key: `finding-${finding.agentId}`, index, item: { kind: 'finding', finding } });
        }
      }
      if (matchedProjects.length > 0) {
        rows.push({ kind: 'header', key: 'h-projects', label: 'Projects' });
        for (const project of matchedProjects) {
          const selectIndex = selectable.length;
          selectable.push({ kind: 'project', project });
          rows.push({ kind: 'item', key: `project-${project.projectId}`, index: selectIndex, item: { kind: 'project', project } });
          // A distinct, keyboard-navigable "launch" row sits under each project
          // result so activating it launches work in that project instead of
          // merely selecting it. Only offered when a launch handler is wired.
          if (onLaunchProject) {
            const launchIndex = selectable.length;
            const launchItem: SelectableItem = { kind: 'projectLaunch', project };
            selectable.push(launchItem);
            rows.push({ kind: 'item', key: `project-launch-${project.projectId}`, index: launchIndex, item: launchItem });
          }
        }
      }
    }
    return { rows, selectable };
  }, [actions, findings, projects, tasks, query, onLaunchProject]);

  // Keep the selection in range as the result set shrinks/grows.
  useEffect(() => {
    setSelectedIndex((prev) => (selectable.length === 0 ? 0 : Math.min(prev, selectable.length - 1)));
  }, [selectable.length]);

  const run = (item: SelectableItem): void => {
    if (item.kind === 'action') {
      onClose();
      item.action.run();
    } else {
      onClose();
      if (item.kind === 'task') {
        onSelectTask(item.task.agentId, item.task.taskId);
      } else if (item.kind === 'finding') {
        onSelectFinding(item.finding.agentId, item.finding.taskId);
      } else if (item.kind === 'projectLaunch') {
        onLaunchProject?.(item.project.projectId);
      } else {
        onSelectProject(item.project.projectId);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (selectable.length === 0 ? 0 : (prev + 1) % selectable.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (selectable.length === 0 ? 0 : (prev - 1 + selectable.length) % selectable.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = selectable[selectedIndex];
      if (item) run(item);
    }
  };

  // Scroll the active row into view on keyboard navigation.
  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('.cmd-row.sel');
    active?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedIndex]);

  const selectedRow = rows.find((row) => row.kind === 'item' && row.index === selectedIndex);
  const activeDescendant = selectedRow ? getCommandRowId(listId, selectedRow.key) : undefined;

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="cmd-input-row">
          <span className="cmd-input-mag" aria-hidden="true">🔍</span>
          <input
            ref={inputRef}
            className="cmd-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeDescendant}
            value={query}
            placeholder="Search actions, tasks, findings, projects…"
            aria-label="Search actions, tasks, findings, and projects"
            data-testid="command-palette-input"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div
          className="cmd-body"
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Command palette results"
          data-testid="command-palette-list"
        >
          {selectable.length === 0 ? (
            <div className="cmd-empty" role="option" aria-disabled="true" aria-selected="false">
              No matches for “{query.trim()}”.
            </div>
          ) : (
            rows.map((row) =>
              row.kind === 'header' ? (
                <div key={row.key} className="cmd-section">
                  {row.label}
                </div>
              ) : (
                <CommandRow
                  key={row.key}
                  id={getCommandRowId(listId, row.key)}
                  item={row.item}
                  selected={row.index === selectedIndex}
                  onHover={() => setSelectedIndex(row.index)}
                  onRun={() => run(row.item)}
                />
              ),
            )
          )}
        </div>
        <div className="cmd-foot">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> run</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

interface CommandRowProps {
  id: string;
  item: SelectableItem;
  selected: boolean;
  onHover: () => void;
  onRun: () => void;
}

function getCommandRowId(listId: string, rowKey: string): string {
  return `${listId}-${rowKey}`;
}

function CommandRow({ id, item, selected, onHover, onRun }: CommandRowProps): React.ReactElement {
  if (item.kind === 'action') {
    const { action } = item;
    return (
      <button
        id={id}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={selected}
        aria-label={`Action: ${action.label}`}
        className={`cmd-row${selected ? ' sel' : ''}`}
        data-testid="command-palette-action"
        data-action-id={action.id}
        onMouseMove={onHover}
        onClick={onRun}
      >
        <span className="cmd-row-label">{action.label}</span>
        <span className="cmd-row-meta">
          {action.badge && (
            <span className={`cmd-row-badge cmd-row-badge--${action.badge.tone}`}>{action.badge.text}</span>
          )}
          {action.shortcut && <kbd className="cmd-row-kbd">{action.shortcut}</kbd>}
        </span>
      </button>
    );
  }
  if (item.kind === 'task') {
    const { task } = item;
    return (
      <button
        id={id}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={selected}
        aria-label={`Task: ${task.label}`}
        className={`cmd-row${selected ? ' sel' : ''}`}
        data-testid="command-palette-task"
        data-task-id={task.taskId}
        onMouseMove={onHover}
        onClick={onRun}
      >
        <span className="cmd-row-label">
          {task.label}
          {task.projectLabel && <span className="cmd-row-sub">{task.projectLabel}</span>}
        </span>
        {task.status && <span className="cmd-row-meta cmd-row-status">{taskStatusLabel(task.status)}</span>}
      </button>
    );
  }
  if (item.kind === 'finding') {
    const { finding } = item;
    return (
      <button
        id={id}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={selected}
        aria-label={`Finding: ${finding.label}`}
        className={`cmd-row${selected ? ' sel' : ''}`}
        data-testid="command-palette-finding"
        data-agent-id={finding.agentId}
        onMouseMove={onHover}
        onClick={onRun}
      >
        <span className="cmd-row-label">
          {finding.label}
          {finding.projectLabel && <span className="cmd-row-sub">{finding.projectLabel}</span>}
        </span>
        <span className="cmd-row-meta cmd-row-status">{finding.severity} · {finding.type}</span>
      </button>
    );
  }
  if (item.kind === 'projectLaunch') {
    const { project } = item;
    return (
      <button
        id={id}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={selected}
        // Keep the visible primary text ("Launch task in <label>") as a leading
        // substring of the accessible name so speech-input activation matches
        // (WCAG 2.5.3), while still naming the affordance for screen readers.
        aria-label={`Launch task in ${project.label} — opens the manual launch dialog`}
        className={`cmd-row${selected ? ' sel' : ''}`}
        data-testid="command-palette-project-launch"
        data-project-id={project.projectId}
        onMouseMove={onHover}
        onClick={onRun}
      >
        <span className="cmd-row-label">
          Launch task in {project.label}
          <span className="cmd-row-sub">Opens the manual launch dialog for this project</span>
        </span>
      </button>
    );
  }
  const { project } = item;
  const projectMeta = [
    `${project.activeAgents} active agent${project.activeAgents === 1 ? '' : 's'}`,
    project.findingCount > 0 ? `${project.findingCount} finding${project.findingCount === 1 ? '' : 's'}` : null,
  ].filter((value): value is string => Boolean(value)).join(' · ');
  return (
    <button
      id={id}
      type="button"
      role="option"
      tabIndex={-1}
      aria-selected={selected}
      aria-label={`Project: ${project.label}`}
      className={`cmd-row${selected ? ' sel' : ''}`}
      data-testid="command-palette-project"
      data-project-id={project.projectId}
      onMouseMove={onHover}
      onClick={onRun}
    >
      <span className="cmd-row-label">
        {project.label}
        <span className="cmd-row-sub">{project.projectId}</span>
      </span>
      <span className="cmd-row-meta cmd-row-status">{projectMeta}</span>
    </button>
  );
}
