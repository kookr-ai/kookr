import type { AgentState } from '../shared/protocol.js';
import type { CoordinatorSnapshotState } from '../shared/contracts/coordinator.js';
import type { TaskStatus } from '../shared/contracts/task-status.js';
import { isTerminalStatus } from '../shared/contracts/task-status.js';
import { TIME_TO_UNBLOCK_WINDOW_MS } from '../shared/contracts/time-to-unblock.js';
import { isActiveFinding, isHealthyRunning } from './store/finding-helpers.js';
import { compareRoutableAgents, computeStartedAtMs } from './agent-priority-order.js';

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

/** finishedAt, else startedAt, else 0 — parsed once for completed ordering. */
export function computeFinishedAtMs(agent: AgentState): number {
  const finished = agent.finishedAt ? Date.parse(agent.finishedAt) : Number.NaN;
  if (Number.isFinite(finished)) return finished;
  const started = agent.startedAt ? Date.parse(agent.startedAt) : Number.NaN;
  return Number.isFinite(started) ? started : 0;
}

/**
 * How many live agents reached a terminal status inside the rolling window.
 *
 * Uses `finishedAt` only — the startedAt fallback in {@link computeFinishedAtMs}
 * is for sort order, not throughput. The live snapshot drops aged/capped
 * completed rows, so this count is a lower bound on true 24h completions.
 */
export function countCompletedInWindow(
  agents: readonly Pick<AgentState, 'taskStatus' | 'finishedAt'>[],
  nowMs: number,
  windowMs: number = TIME_TO_UNBLOCK_WINDOW_MS,
): number {
  if (!Number.isFinite(nowMs) || !Number.isFinite(windowMs) || windowMs < 0) return 0;
  const cutoffMs = nowMs - windowMs;
  let count = 0;
  for (const agent of agents) {
    if (!isTerminalTaskStatus(agent.taskStatus) || !agent.finishedAt) continue;
    const finishedMs = Date.parse(agent.finishedAt);
    if (!Number.isFinite(finishedMs)) continue;
    if (finishedMs >= cutoffMs && finishedMs <= nowMs) count += 1;
  }
  return count;
}

/**
 * How many live agents started inside the rolling window.
 *
 * Uses `startedAt` only. A missing or unparseable start time is skipped —
 * never inferred from `finishedAt`. The live snapshot drops aged/capped
 * rows, so this count is a lower bound on true 24h launches.
 */
export function countLaunchedInWindow(
  agents: readonly Pick<AgentState, 'startedAt'>[],
  nowMs: number,
  windowMs: number = TIME_TO_UNBLOCK_WINDOW_MS,
): number {
  if (!Number.isFinite(nowMs) || !Number.isFinite(windowMs) || windowMs < 0) return 0;
  const cutoffMs = nowMs - windowMs;
  let count = 0;
  for (const agent of agents) {
    if (!agent.startedAt) continue;
    const startedMs = Date.parse(agent.startedAt);
    if (!Number.isFinite(startedMs)) continue;
    if (startedMs >= cutoffMs && startedMs <= nowMs) count += 1;
  }
  return count;
}

export function compareCompletedAgents(
  left: AgentState,
  right: AgentState,
  finishedMsByAgentId?: ReadonlyMap<string, number>,
): number {
  const rightMs = finishedMsByAgentId?.get(right.agentId) ?? computeFinishedAtMs(right);
  const leftMs = finishedMsByAgentId?.get(left.agentId) ?? computeFinishedAtMs(left);
  return rightMs - leftMs
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

  // Parse each agent's timestamps once for all sorts in this rebuild (#1944).
  const startedMsByAgentId = new Map(
    scopedAgents.map((agent) => [agent.agentId, computeStartedAtMs(agent)]),
  );
  const finishedMsByAgentId = new Map(
    scopedAgents.map((agent) => [agent.agentId, computeFinishedAtMs(agent)]),
  );

  const order = {
    chipTaskIds,
    originalIndex,
    projectPriorityRanks,
    startedMsByAgentId,
  } as const;

  const filteredAgents = [...scopedAgents].sort((left, right) => compareRoutableAgents(left, right, order));

  return {
    filteredAgents,
    pending: scopedAgents
      .filter((agent) => agent.taskStatus === 'pending')
      .sort((left, right) => compareRoutableAgents(left, right, order)),
    completed: scopedAgents
      .filter((agent) => isTerminalTaskStatus(agent.taskStatus))
      .sort((left, right) => compareCompletedAgents(left, right, finishedMsByAgentId)),
    snoozed: scopedAgents
      .filter((agent) => agent.taskStatus !== 'pending' && !isTerminalTaskStatus(agent.taskStatus) && (!!agent.snoozedUntil || agent.suppressed))
      .sort((a, b) => (a.snoozedUntil ?? 0) - (b.snoozedUntil ?? 0)),
    findings: scopedAgents
      .filter((agent) => agent.taskStatus !== 'pending' && !isTerminalTaskStatus(agent.taskStatus) && isActiveFinding(agent))
      .sort((left, right) => compareRoutableAgents(left, right, order)),
    healthy: scopedAgents
      .filter(isHealthyRunning)
      .sort((left, right) => compareRoutableAgents(left, right, { ...order, includeSeverity: false })),
    activeTaskCount: agents.filter((agent) => !isTerminalTaskStatus(agent.taskStatus)).length,
    completedTaskCount: agents.filter((agent) => isTerminalTaskStatus(agent.taskStatus)).length,
  };
}
