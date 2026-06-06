import React, { useMemo } from 'react';
import type { AgentState } from '../../shared/protocol.js';
import { useKookrStore } from '../store/useStore.js';
import { buildDependencyRail, type RailNode } from './dependency-rail-model.js';

interface TaskDependencyRailProps {
  agent: AgentState;
}

/**
 * Compact one-line dependency rail that replaces the tall "Related tasks"
 * section (#601 follow-up). Shows `upstream → [this task] → downstream` derived
 * from the task-relations graph. Each neighbour is a button that navigates to
 * that task; relation type / confidence / inferred-ness live in the tooltip so
 * the line stays a single row. Renders nothing when the task has no
 * dependency-style edges.
 */
export function TaskDependencyRail({ agent }: TaskDependencyRailProps): React.ReactElement | null {
  const taskRelations = useKookrStore((state) => state.taskRelations);
  const agents = useKookrStore((state) => state.agents);
  const selectAgent = useKookrStore((state) => state.selectAgent);

  const { taskLabelByTaskId, taskStatusByTaskId, agentIdByTaskId } = useMemo(() => {
    const label = new Map<string, string>();
    const status = new Map<string, AgentState['taskStatus']>();
    const agentId = new Map<string, string>();
    for (const a of agents) {
      if (!a.taskId) continue;
      if (!label.has(a.taskId)) label.set(a.taskId, a.taskName ?? a.agentId);
      if (!agentId.has(a.taskId)) agentId.set(a.taskId, a.agentId);
      if (!status.has(a.taskId) && a.taskStatus) status.set(a.taskId, a.taskStatus);
    }
    return { taskLabelByTaskId: label, taskStatusByTaskId: status, agentIdByTaskId: agentId };
  }, [agents]);

  const rail = useMemo(() => {
    if (!agent.taskId) return { upstream: [], downstream: [] };
    return buildDependencyRail({
      taskId: agent.taskId,
      relations: taskRelations,
      taskLabelByTaskId,
      taskStatusByTaskId,
    });
  }, [agent.taskId, taskRelations, taskLabelByTaskId, taskStatusByTaskId]);

  if (!agent.taskId) return null;
  if (rail.upstream.length === 0 && rail.downstream.length === 0) return null;

  const navigate = (taskId: string): void => {
    const targetAgentId = agentIdByTaskId.get(taskId);
    if (targetAgentId) selectAgent(targetAgentId);
  };

  return (
    <section className="task-dependency-rail" data-testid="task-dependency-rail" aria-label="Task dependencies">
      <span className="dep-rail-label">Dependencies</span>
      <div className="dep-rail-track">
        {rail.upstream.map((node) => (
          <RailNodeChip key={`up-${node.taskId}`} node={node} onNavigate={navigate} />
        ))}
        {rail.upstream.length > 0 && <span className="dep-rail-arrow" aria-hidden="true">→</span>}
        <span className="dep-rail-current" title={agent.taskName ?? agent.agentId}>
          {agent.taskName ?? agent.agentId}
        </span>
        {rail.downstream.length > 0 && <span className="dep-rail-arrow" aria-hidden="true">→</span>}
        {rail.downstream.map((node) => (
          <RailNodeChip key={`down-${node.taskId}`} node={node} onNavigate={navigate} />
        ))}
      </div>
    </section>
  );
}

function dotClass(status: RailNode['status']): string {
  if (status === 'inProgress') return 'run';
  if (status === 'completed' || status === 'cancelled' || status === 'terminated') return 'done';
  return 'wait';
}

function RailNodeChip({ node, onNavigate }: { node: RailNode; onNavigate: (taskId: string) => void }): React.ReactElement {
  const pct = Math.round(node.confidence * 100);
  const tooltip = `${node.relationLabel}${node.inferred ? ' · inferred' : ''} · ${pct}% confidence`;
  return (
    <button
      type="button"
      className={`dep-rail-node${node.inferred ? ' dep-rail-node--inferred' : ''}`}
      title={tooltip}
      aria-label={`${node.label} — ${tooltip}`}
      data-testid="dep-rail-node"
      data-task-id={node.taskId}
      onClick={() => onNavigate(node.taskId)}
    >
      <span className={`dep-rail-dot ${dotClass(node.status)}`} aria-hidden="true" />
      <span className="dep-rail-node-label">{node.label}</span>
    </button>
  );
}
