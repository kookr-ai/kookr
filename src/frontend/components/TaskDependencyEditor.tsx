import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useKookrStore } from '../store/useStore.js';
import type { AgentState } from '../../shared/protocol.js';
import type { TaskDependencyEdge } from '../../shared/contracts/task.js';
import { useDialogFocus } from '../hooks/useDialogFocus.js';
import { useEscapeToClose } from '../hooks/useEscapeToClose.js';
import { isTerminalStatus } from '../../shared/contracts/task-status.js';

type EdgeField = 'blocked_by' | 'blocks';

interface Props {
  agent: AgentState;
}

interface EdgePatchResponse {
  ok: boolean;
  task?: {
    blocks?: TaskDependencyEdge[];
    blocked_by?: TaskDependencyEdge[];
  };
  error?: string;
}

interface TaskOption {
  taskId: string;
  label: string;
}

function labelForEdge(edge: TaskDependencyEdge, tasksById: ReadonlyMap<string, TaskOption>): string {
  if (edge.startsWith('task:')) {
    const taskId = edge.slice('task:'.length);
    const task = tasksById.get(taskId);
    return task ? `${task.label} (${taskId.slice(0, 8)})` : taskId;
  }
  return edge.slice('milestone:'.length);
}

function edgeKind(edge: TaskDependencyEdge): string {
  return edge.startsWith('task:') ? 'Task' : 'Milestone';
}

function normalizeMilestoneInput(input: string): TaskDependencyEdge | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('task:') || trimmed.startsWith('milestone:')) {
    return trimmed as TaskDependencyEdge;
  }
  return `milestone:${trimmed}`;
}

export function TaskDependencyEditor({ agent }: Props) {
  const agents = useKookrStore((s) => s.agents);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [blocks, setBlocks] = useState<TaskDependencyEdge[]>(agent.blocks ?? []);
  const [blockedBy, setBlockedBy] = useState<TaskDependencyEdge[]>(agent.blocked_by ?? []);
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<EdgeField>('blocked_by');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBlocks(agent.blocks ?? []);
    setBlockedBy(agent.blocked_by ?? []);
  }, [agent.taskId, agent.blocks, agent.blocked_by]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim().toLowerCase()), 150);
    return () => window.clearTimeout(timer);
  }, [query]);

  const taskOptions = useMemo(() => {
    const byId = new Map<string, TaskOption>();
    for (const candidate of agents) {
      if (!candidate.taskId || candidate.taskId === agent.taskId) continue;
      if (candidate.taskStatus && isTerminalStatus(candidate.taskStatus)) continue;
      if (byId.has(candidate.taskId)) continue;
      byId.set(candidate.taskId, {
        taskId: candidate.taskId,
        label: candidate.taskName ?? candidate.taskId,
      });
    }
    return Array.from(byId.values());
  }, [agent.taskId, agents]);

  const tasksById = useMemo(() => new Map(taskOptions.map((task) => [task.taskId, task])), [taskOptions]);

  const matches = useMemo(() => {
    const q = debouncedQuery;
    const ranked = taskOptions
      .filter((task) => {
        if (!q) return true;
        return task.taskId.toLowerCase().includes(q) || task.label.toLowerCase().includes(q);
      })
      .sort((left, right) => {
        if (!q) return left.label.localeCompare(right.label);
        const leftStarts = left.label.toLowerCase().startsWith(q) || left.taskId.toLowerCase().startsWith(q);
        const rightStarts = right.label.toLowerCase().startsWith(q) || right.taskId.toLowerCase().startsWith(q);
        if (leftStarts !== rightStarts) return leftStarts ? -1 : 1;
        return left.label.localeCompare(right.label);
      });
    return ranked.slice(0, 8);
  }, [debouncedQuery, taskOptions]);

  async function patchEdges(next: { blocks?: TaskDependencyEdge[]; blocked_by?: TaskDependencyEdge[] }) {
    if (!agent.taskId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(agent.taskId)}/edges`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const body = await res.json() as EdgePatchResponse;
      if (!res.ok) throw new Error(body.error ?? `edge update failed: ${res.status}`);
      setBlocks(body.task?.blocks ?? next.blocks ?? blocks);
      setBlockedBy(body.task?.blocked_by ?? next.blocked_by ?? blockedBy);
      setOpen(false);
      setQuery('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function addEdge(edge: TaskDependencyEdge) {
    if (saving) return;
    const current = field === 'blocks' ? blocks : blockedBy;
    if (current.includes(edge)) {
      setOpen(false);
      setQuery('');
      return;
    }
    const next = [...current, edge];
    void patchEdges(field === 'blocks' ? { blocks: next } : { blocked_by: next });
  }

  function addFreeText() {
    if (saving) return;
    const edge = normalizeMilestoneInput(query);
    if (!edge) return;
    addEdge(edge);
  }

  function removeEdge(targetField: EdgeField, edge: TaskDependencyEdge) {
    const current = targetField === 'blocks' ? blocks : blockedBy;
    const next = current.filter((candidate) => candidate !== edge);
    void patchEdges(targetField === 'blocks' ? { blocks: next } : { blocked_by: next });
  }

  if (!agent.taskId) return null;

  return (
    <section className="task-dependencies" aria-label="Task dependencies" data-testid="task-dependencies">
      <div className="task-dependencies-header">
        <span className="task-dependencies-title">Dependencies</span>
        <button
          ref={triggerRef}
          type="button"
          className="action-btn action-btn--neutral"
          data-testid="add-dependency-button"
          onClick={() => {
            setField('blocked_by');
            setOpen(true);
            setError(null);
          }}
        >
          Add dependency
        </button>
      </div>

      <EdgeList
        label="Blocked by"
        field="blocked_by"
        edges={blockedBy}
        tasksById={tasksById}
        saving={saving}
        onRemove={removeEdge}
      />
      <EdgeList
        label="Blocks"
        field="blocks"
        edges={blocks}
        tasksById={tasksById}
        saving={saving}
        onRemove={removeEdge}
      />

      {open && (
        <TaskDependencyModal
          field={field}
          query={query}
          matches={matches}
          saving={saving}
          error={error}
          onFieldChange={setField}
          onQueryChange={setQuery}
          onAddTask={(taskId) => addEdge(`task:${taskId}`)}
          onAddFreeText={addFreeText}
          onClose={() => setOpen(false)}
        />
      )}
    </section>
  );
}

function TaskDependencyModal({
  field,
  query,
  matches,
  saving,
  error,
  onFieldChange,
  onQueryChange,
  onAddTask,
  onAddFreeText,
  onClose,
}: {
  field: EdgeField;
  query: string;
  matches: TaskOption[];
  saving: boolean;
  error: string | null;
  onFieldChange: (field: EdgeField) => void;
  onQueryChange: (query: string) => void;
  onAddTask: (taskId: string) => void;
  onAddFreeText: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useDialogFocus({ dialogRef, initialFocusRef: inputRef });
  useEscapeToClose(onClose);

  return (
    <div className="dependency-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="dependency-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dependency-modal-title"
        tabIndex={-1}
        data-testid="dependency-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="dependency-modal-header">
          <h3 id="dependency-modal-title">Add dependency</h3>
          <button
            type="button"
            className="dependency-modal-close"
            aria-label="Close dependency dialog"
            onClick={onClose}
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </div>
        <div className="dependency-field-toggle" role="group" aria-label="Dependency direction">
          <button
            type="button"
            className={field === 'blocked_by' ? 'active' : ''}
            aria-pressed={field === 'blocked_by'}
            onClick={() => onFieldChange('blocked_by')}
          >
            Blocked by
          </button>
          <button
            type="button"
            className={field === 'blocks' ? 'active' : ''}
            aria-pressed={field === 'blocks'}
            onClick={() => onFieldChange('blocks')}
          >
            Blocks
          </button>
        </div>
        <label className="dependency-search-label" htmlFor="dependency-search-input">
          Search tasks or type milestone
        </label>
        <input
          ref={inputRef}
          id="dependency-search-input"
          className="dependency-search-input"
          data-testid="dependency-search-input"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !saving) onAddFreeText();
              }}
          placeholder="Search tasks or type milestone"
        />
        <div className="dependency-results" data-testid="dependency-results">
          {matches.map((task) => (
            <button
              type="button"
              key={task.taskId}
              className="dependency-result"
              disabled={saving}
              onClick={() => onAddTask(task.taskId)}
            >
              <span>{task.label}</span>
              <code>{task.taskId.slice(0, 8)}</code>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="btn-secondary dependency-free-text"
          data-testid="dependency-free-text"
          disabled={!query.trim() || saving}
          onClick={onAddFreeText}
        >
          Add milestone
        </button>
        {error && <div className="dependency-error" role="alert">{error}</div>}
      </div>
    </div>
  );
}

function EdgeList({
  label,
  field,
  edges,
  tasksById,
  saving,
  onRemove,
}: {
  label: string;
  field: EdgeField;
  edges: TaskDependencyEdge[];
  tasksById: ReadonlyMap<string, TaskOption>;
  saving: boolean;
  onRemove: (field: EdgeField, edge: TaskDependencyEdge) => void;
}) {
  return (
    <div className="dependency-edge-row">
      <span className="dependency-edge-label">{label}</span>
      <div className="dependency-edge-chips">
        {edges.length === 0 ? (
          <span className="dependency-edge-empty">None</span>
        ) : edges.map((edge) => (
          <span className="dependency-chip" key={edge} title={edge}>
            <span className="dependency-chip-kind">{edgeKind(edge)}</span>
            <span>{labelForEdge(edge, tasksById)}</span>
            <button
              type="button"
              aria-label={`Remove ${labelForEdge(edge, tasksById)}`}
              disabled={saving}
              onClick={() => onRemove(field, edge)}
            >
              ×
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
