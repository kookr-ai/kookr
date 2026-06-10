import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import {
  filterActions,
  filterTasks,
  groupActionsBySection,
  type CommandAction,
  type CommandTaskItem,
} from './command-palette-model.js';
import { taskStatusLabel } from '../presentation.js';

interface CommandPaletteProps {
  actions: CommandAction[];
  tasks: CommandTaskItem[];
  onSelectTask: (agentId: string) => void;
  onClose: () => void;
}

type SelectableItem =
  | { kind: 'action'; action: CommandAction }
  | { kind: 'task'; task: CommandTaskItem };

type RenderRow =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'item'; key: string; index: number; item: SelectableItem };

/**
 * The unified command palette (top-bar redesign). Opened from the top-bar
 * "Search actions & tasks" field or ⌘K / Ctrl+K. Empty query → a browsable,
 * categorised list of every action that used to live as a top-bar icon. Typing
 * filters and ranks both actions and tasks (a lightweight task switcher).
 * ↑/↓ move, ↵ runs, Esc closes.
 */
export function CommandPalette({ actions, tasks, onSelectTask, onClose }: CommandPaletteProps): React.ReactElement {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEscapeToClose(onClose);
  useDialogFocus({ dialogRef, initialFocusRef: inputRef });

  const { rows, selectable } = useMemo(() => {
    const matchedActions = filterActions(actions, query);
    const matchedTasks = filterTasks(tasks, query);
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
    }
    return { rows, selectable };
  }, [actions, tasks, query]);

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
      onSelectTask(item.task.agentId);
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
            value={query}
            placeholder="Search actions & tasks…"
            aria-label="Search actions and tasks"
            data-testid="command-palette-input"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="cmd-body" ref={listRef} data-testid="command-palette-list">
          {selectable.length === 0 ? (
            <p className="cmd-empty">No matches for “{query.trim()}”.</p>
          ) : (
            rows.map((row) =>
              row.kind === 'header' ? (
                <div key={row.key} className="cmd-section">
                  {row.label}
                </div>
              ) : (
                <CommandRow
                  key={row.key}
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
  item: SelectableItem;
  selected: boolean;
  onHover: () => void;
  onRun: () => void;
}

function CommandRow({ item, selected, onHover, onRun }: CommandRowProps): React.ReactElement {
  if (item.kind === 'action') {
    const { action } = item;
    return (
      <button
        type="button"
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
  const { task } = item;
  return (
    <button
      type="button"
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
