import type { AgentState } from '../shared/protocol.js';
import type { CoordinatorSnapshotState } from '../shared/contracts/coordinator.js';
import type { TaskStatus } from '../shared/contracts/task-status.js';
import { isTerminalStatus } from '../shared/contracts/task-status.js';
import { isActiveFinding } from './store/finding-helpers.js';
import { compareRoutableAgents } from './agent-priority-order.js';

export interface AgentBuckets {
  filteredAgents: AgentState[];
  pending: AgentState[];
  completed: AgentState[];
  snoozed: AgentState[];
  findings: AgentState[];
  healthy: AgentState[];
  activeTaskCount: number;
  completedTaskCount: number;
}

export function isTerminalTaskStatus(status: TaskStatus | undefined): boolean {
  return status !== undefined && isTerminalStatus(status);
}

export function isHealthyRunningAgent(agent: AgentState): boolean {
  return agent.anomaly === null
    && !agent.snoozedUntil
    && !agent.suppressed
    && agent.taskStatus !== 'pending'
    && !isTerminalTaskStatus(agent.taskStatus);
}

function finishedAtMs(agent: AgentState): number {
  const finished = agent.finishedAt ? Date.parse(agent.finishedAt) : Number.NaN;
  if (Number.isFinite(finished)) return finished;
  const started = agent.startedAt ? Date.parse(agent.startedAt) : Number.NaN;
  return Number.isFinite(started) ? started : 0;
}

export function compareCompletedAgents(left: AgentState, right: AgentState): number {
  return finishedAtMs(right) - finishedAtMs(left)
    || (right.taskId ?? right.agentId).localeCompare(left.taskId ?? left.agentId);
}

export function buildAgentBuckets(
  agents: AgentState[],
  selectedProject: string | null,
  coordinator?: CoordinatorSnapshotState | null,
  projectPriorityRanks?: ReadonlyMap<string, number>,
): AgentBuckets {
  const chipTaskIds = new Set((coordinator?.chips ?? []).map((chip) => chip.taskId));
  const originalIndex = new Map(agents.map((agent, index) => [agent.agentId, index]));
  const scopedAgents = (selectedProject
    ? agents.filter((agent) => agent.projectId === selectedProject)
    : agents);
  const filteredAgents = [...scopedAgents].sort((left, right) => compareRoutableAgents(left, right, {
      chipTaskIds,
      originalIndex,
      projectPriorityRanks,
  }));

  return {
    filteredAgents,
    pending: scopedAgents
      .filter((agent) => agent.taskStatus === 'pending')
      .sort((left, right) => compareRoutableAgents(left, right, { chipTaskIds, originalIndex, projectPriorityRanks })),
    completed: scopedAgents
      .filter((agent) => isTerminalTaskStatus(agent.taskStatus))
      .sort(compareCompletedAgents),
    snoozed: scopedAgents
      .filter((agent) => agent.taskStatus !== 'pending' && !isTerminalTaskStatus(agent.taskStatus) && (!!agent.snoozedUntil || agent.suppressed))
      .sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0)),
    findings: scopedAgents
      .filter((agent) => agent.taskStatus !== 'pending' && !isTerminalTaskStatus(agent.taskStatus) && isActiveFinding(agent))
      .sort((left, right) => compareRoutableAgents(left, right, { chipTaskIds, originalIndex, projectPriorityRanks })),
    healthy: scopedAgents
      .filter(isHealthyRunningAgent)
      .sort((left, right) => compareRoutableAgents(left, right, { chipTaskIds, originalIndex, projectPriorityRanks, includeSeverity: false })),
    activeTaskCount: agents.filter((agent) => !isTerminalTaskStatus(agent.taskStatus)).length,
    completedTaskCount: agents.filter((agent) => isTerminalTaskStatus(agent.taskStatus)).length,
  };
}
