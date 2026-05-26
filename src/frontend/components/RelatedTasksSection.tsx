import React, { useMemo, useState } from 'react';
import type { AgentState } from '../../shared/protocol.js';
import { useKookrStore } from '../store/useStore.js';
import { buildRelatedTaskGroups, type RelatedTaskEntry } from './related-tasks-model.js';

type RelationFilterMode = 'off' | 'chain' | 'children';

interface RelatedTasksSectionProps {
  agent: AgentState;
}

/**
 * "Related tasks" detail-panel section (#601 UX).
 *
 * Renders one collapsible group per relation kind, plus inline filters for
 * `hide completed descendants`. The evidence panel for a relation opens
 * inline beneath the selected entry — no modal, no portal — so it stays
 * keyboard- and screen-reader-navigable.
 */
export function RelatedTasksSection({ agent }: RelatedTasksSectionProps): React.ReactElement | null {
  const taskRelations = useKookrStore((state) => state.taskRelations);
  const agents = useKookrStore((state) => state.agents);
  const relationFilter = useKookrStore((state) => state.relationFilter);
  const setRelationFilter = useKookrStore((state) => state.setRelationFilter);
  const [hideCompleted, setHideCompleted] = useState(false);
  const [openEvidenceFor, setOpenEvidenceFor] = useState<string | null>(null);

  const taskStatusByTaskId = useMemo(() => {
    const map = new Map<string, AgentState['taskStatus']>();
    for (const a of agents) {
      if (!a.taskId) continue;
      const prior = map.get(a.taskId);
      // First-write-wins keeps the agent_order-preserved status. Synthetic
      // entries (no taskStatus) get overwritten by a later real session.
      if (!prior && a.taskStatus) map.set(a.taskId, a.taskStatus);
      else if (!map.has(a.taskId)) map.set(a.taskId, a.taskStatus);
    }
    return map;
  }, [agents]);

  const taskLabelByTaskId = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents) {
      if (!a.taskId || map.has(a.taskId)) continue;
      map.set(a.taskId, a.taskName ?? a.agentId);
    }
    return map;
  }, [agents]);

  const activeFilterRootIsMe =
    relationFilter.mode !== 'off' && relationFilter.rootTaskId === agent.taskId;
  const activeFilterMode: RelationFilterMode = activeFilterRootIsMe ? relationFilter.mode : 'off';

  const setMode = (mode: RelationFilterMode): void => {
    if (mode === 'off') {
      setRelationFilter({ mode: 'off', rootTaskId: null });
    } else {
      setRelationFilter({ mode, rootTaskId: agent.taskId ?? null });
    }
  };

  const groups = useMemo(() => {
    if (!agent.taskId) return [];
    return buildRelatedTaskGroups({
      taskId: agent.taskId,
      relations: taskRelations,
      hideCompletedDescendants: hideCompleted,
      taskStatusByTaskId,
    });
  }, [agent.taskId, taskRelations, hideCompleted, taskStatusByTaskId]);

  if (!agent.taskId) return null;
  if (groups.length === 0 && taskRelations.length === 0) return null;

  return (
    <section className="related-tasks-section" data-testid="related-tasks-section" aria-label="Related tasks">
      <header className="related-tasks-header">
        <h3>Related tasks</h3>
        <div className="related-tasks-filters">
          <div className="related-tasks-scope-group" role="radiogroup" aria-label="Scope dashboard task list">
            <button
              type="button"
              role="radio"
              aria-checked={activeFilterMode === 'off'}
              className={`related-tasks-scope-btn${activeFilterMode === 'off' ? ' related-tasks-scope-btn--active' : ''}`}
              onClick={() => setMode('off')}
              data-testid="related-tasks-scope-all"
            >
              All tasks
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={activeFilterMode === 'chain'}
              className={`related-tasks-scope-btn${activeFilterMode === 'chain' ? ' related-tasks-scope-btn--active' : ''}`}
              onClick={() => setMode('chain')}
              data-testid="related-tasks-scope-chain"
            >
              Show chain
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={activeFilterMode === 'children'}
              className={`related-tasks-scope-btn${activeFilterMode === 'children' ? ' related-tasks-scope-btn--active' : ''}`}
              onClick={() => setMode('children')}
              data-testid="related-tasks-scope-children"
            >
              Show children
            </button>
          </div>
          <label className="related-tasks-filter">
            <input
              type="checkbox"
              checked={hideCompleted}
              onChange={(event) => setHideCompleted(event.target.checked)}
              data-testid="related-tasks-hide-completed"
            />
            <span>Hide completed descendants</span>
          </label>
        </div>
      </header>
      {groups.length === 0 ? (
        <p className="related-tasks-empty">No related tasks for this focus.</p>
      ) : (
        <ul className="related-tasks-groups">
          {groups.map((group) => (
            <li key={group.key} className="related-tasks-group" data-testid={`related-tasks-group-${group.key}`}>
              <h4 className="related-tasks-group-label">
                {group.label}
                <span className="related-tasks-group-count" aria-label={`${group.entries.length} entries`}>
                  {group.entries.length}
                </span>
              </h4>
              <ul className="related-tasks-entries">
                {group.entries.map((entry) => (
                  <RelatedTaskEntryRow
                    key={`${entry.relation.id}-${entry.outgoing ? 'out' : 'in'}`}
                    entry={entry}
                    label={taskLabelByTaskId.get(entry.otherTaskId) ?? entry.otherTaskId}
                    evidenceOpen={openEvidenceFor === entry.relation.id}
                    onToggleEvidence={() =>
                      setOpenEvidenceFor((prev) => (prev === entry.relation.id ? null : entry.relation.id))
                    }
                  />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface RelatedTaskEntryRowProps {
  entry: RelatedTaskEntry;
  label: string;
  evidenceOpen: boolean;
  onToggleEvidence: () => void;
}

function RelatedTaskEntryRow({ entry, label, evidenceOpen, onToggleEvidence }: RelatedTaskEntryRowProps): React.ReactElement {
  const { relation, inferred } = entry;
  const className = `related-task-entry${inferred ? ' related-task-entry--inferred' : ''}`;
  return (
    <li
      className={className}
      data-testid="related-task-entry"
      data-relation-id={relation.id}
      data-inferred={inferred ? 'true' : 'false'}
    >
      <div className="related-task-entry-row">
        <span className="related-task-entry-label">{label}</span>
        <span className="related-task-entry-type">{relation.type.replaceAll('_', ' ')}</span>
        {inferred && (
          <span className="related-task-badge related-task-badge--inferred" data-testid="related-task-badge-inferred">
            inferred
          </span>
        )}
        {!inferred && (
          <span className="related-task-badge related-task-badge--deterministic">
            {relation.source === 'api' || relation.source === 'kookr-spawn' ? 'deterministic' : relation.source}
          </span>
        )}
        <span className="related-task-confidence" title={`Confidence ${relation.confidence.toFixed(2)}`}>
          {Math.round(relation.confidence * 100)}%
        </span>
        <button
          type="button"
          className="related-task-evidence-toggle"
          aria-expanded={evidenceOpen}
          onClick={onToggleEvidence}
          data-testid="related-task-evidence-toggle"
        >
          {evidenceOpen ? 'Hide evidence' : `Why? (${relation.evidence.length})`}
        </button>
      </div>
      {evidenceOpen && (
        <div className="related-task-evidence" data-testid="related-task-evidence">
          {relation.evidence.length === 0 ? (
            <p className="related-task-evidence-empty">No evidence captured for this relation.</p>
          ) : (
            <ul className="related-task-evidence-list">
              {relation.evidence.map((ev, i) => (
                <li key={`${relation.id}-ev-${i}`} className="related-task-evidence-item">
                  {ev.snippet && <code className="related-task-evidence-snippet">{ev.snippet}</code>}
                  {ev.path && <span className="related-task-evidence-path">{ev.path}</span>}
                  <time dateTime={ev.observedAt} className="related-task-evidence-time">
                    {ev.observedAt}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Compact "{N} children · {running}/{completed}/{blocked}" pill for parent
 * rows in the task list (#601 UX). Returns null when the agent has no
 * rollup — most agents won't have one.
 */
export function ChildRollupPill({ agent }: { agent: AgentState }): React.ReactElement | null {
  const rollup = agent.childRollup;
  if (!rollup || rollup.childCount === 0) return null;
  const finding = rollup.mostUrgentChildFinding;
  const title = finding
    ? `${rollup.childCount} children — most urgent: ${finding.anomalyType} (${finding.severity}) — ${finding.explanation}`
    : `${rollup.childCount} children · ${rollup.running} running · ${rollup.completed} completed · ${rollup.blocked} blocked`;
  return (
    <span
      className={`child-rollup-pill${finding ? ` child-rollup-pill--${finding.severity}` : ''}`}
      data-testid="child-rollup-pill"
      title={title}
    >
      <span className="child-rollup-pill-count">{rollup.childCount}c</span>
      <span className="child-rollup-pill-breakdown">
        {rollup.running}/{rollup.completed}/{rollup.blocked}
      </span>
    </span>
  );
}
