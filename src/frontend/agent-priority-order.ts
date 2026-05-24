import type { AgentState } from '../shared/protocol.js';
import { SEVERITY_ORDER } from './store/store-types.js';

export interface AgentOrderOptions {
  projectPriorityRanks?: ReadonlyMap<string, number>;
  chipTaskIds?: ReadonlySet<string>;
  originalIndex?: ReadonlyMap<string, number>;
  includeSeverity?: boolean;
}

const UNRANKED_PROJECT = Number.MAX_SAFE_INTEGER;
const UNKNOWN_TIME = Number.MAX_SAFE_INTEGER;

export function compareRoutableAgents(
  left: AgentState,
  right: AgentState,
  options: AgentOrderOptions = {},
): number {
  const leftChip = hasChip(left, options.chipTaskIds);
  const rightChip = hasChip(right, options.chipTaskIds);
  if (leftChip !== rightChip) return leftChip ? -1 : 1;

  if (options.includeSeverity !== false && left.anomaly && right.anomaly) {
    const bySeverity = SEVERITY_ORDER[left.anomaly.severity] - SEVERITY_ORDER[right.anomaly.severity];
    if (bySeverity !== 0) return bySeverity;
  }

  const byPriority = priorityRank(left) - priorityRank(right);
  if (byPriority !== 0) return byPriority;

  const byProject = projectRank(left, options.projectPriorityRanks) - projectRank(right, options.projectPriorityRanks);
  if (byProject !== 0) return byProject;

  const byTime = startedAtMs(left) - startedAtMs(right);
  if (byTime !== 0) return byTime;

  const leftId = left.taskId ?? left.agentId;
  const rightId = right.taskId ?? right.agentId;
  const byId = leftId.localeCompare(rightId);
  if (byId !== 0) return byId;

  return originalRank(left, options.originalIndex) - originalRank(right, options.originalIndex);
}

function hasChip(agent: AgentState, chipTaskIds: ReadonlySet<string> | undefined): boolean {
  return Boolean(agent.taskId && chipTaskIds?.has(agent.taskId));
}

function priorityRank(agent: AgentState): number {
  return agent.priority === 'high' ? 0 : 1;
}

function projectRank(agent: AgentState, projectPriorityRanks: ReadonlyMap<string, number> | undefined): number {
  if (!agent.projectId || !projectPriorityRanks) return UNRANKED_PROJECT;
  return projectPriorityRanks.get(agent.projectId) ?? UNRANKED_PROJECT;
}

function startedAtMs(agent: AgentState): number {
  if (!agent.startedAt) return UNKNOWN_TIME;
  const ms = new Date(agent.startedAt).getTime();
  return Number.isFinite(ms) ? ms : UNKNOWN_TIME;
}

function originalRank(agent: AgentState, originalIndex: ReadonlyMap<string, number> | undefined): number {
  return originalIndex?.get(agent.agentId) ?? UNRANKED_PROJECT;
}
