import type { AgentState } from '../shared/protocol.js';
import type { TaskStatus } from '../core/types.js';
import { isTerminalStatus } from '../shared/contracts/task-status.js';
import { isActiveFinding } from './store/finding-helpers.js';

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

export function buildAgentBuckets(agents: AgentState[], selectedProject: string | null): AgentBuckets {
  const filteredAgents = selectedProject
    ? agents.filter((agent) => agent.projectId === selectedProject)
    : agents;

  return {
    filteredAgents,
    pending: filteredAgents.filter((agent) => agent.taskStatus === 'pending'),
    completed: filteredAgents.filter((agent) => isTerminalTaskStatus(agent.taskStatus)),
    snoozed: filteredAgents
      .filter((agent) => agent.taskStatus !== 'pending' && !isTerminalTaskStatus(agent.taskStatus) && (!!agent.snoozedUntil || agent.suppressed))
      .sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0)),
    findings: filteredAgents.filter((agent) => agent.taskStatus !== 'pending' && !isTerminalTaskStatus(agent.taskStatus) && isActiveFinding(agent)),
    healthy: filteredAgents.filter(isHealthyRunningAgent),
    activeTaskCount: agents.filter((agent) => !isTerminalTaskStatus(agent.taskStatus)).length,
    completedTaskCount: agents.filter((agent) => isTerminalTaskStatus(agent.taskStatus)).length,
  };
}
