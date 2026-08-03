import type { AgentState } from '../shared/protocol.js';
import { isActiveFinding, isHealthyRunning } from '../shared/task-routing.js';
import { SEVERITY_ORDER } from './store/store-types.js';

export interface AgentOrderOptions {
  projectPriorityRanks?: ReadonlyMap<string, number>;
  chipTaskIds?: ReadonlySet<string>;
  originalIndex?: ReadonlyMap<string, number>;
  includeSeverity?: boolean;
  /** Precomputed startedAt → ms; when set, comparators skip Date parsing. */
  startedMsByAgentId?: ReadonlyMap<string, number>;
}

/**
 * Builds the routable task order exactly as the dashboard presents it for
 * empty-Enter navigation: active findings first (severity-aware), then healthy
 * running tasks (severity ignored), each sorted by {@link compareRoutableAgents}.
 *
 * This is the single source of truth for both the frontend cursor movement
 * (`nextTask`/`previousTask`) and the `orderedCandidateSessionIds` the client
 * hands the server, so server-driven advancement provably follows the same
 * order the user sees (#1079).
 */
export function buildRoutableOrder(agents: AgentState[], options: AgentOrderOptions = {}): AgentState[] {
  const findings = agents
    .filter(isActiveFinding)
    .sort((left, right) => compareRoutableAgents(left, right, options));
  const healthy = agents
    .filter(isHealthyRunning)
    .sort((left, right) => compareRoutableAgents(left, right, { ...options, includeSeverity: false }));
  return [...findings, ...healthy];
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
    // Effective severity bumps the parent up when a child has an urgent
    // finding (#601). Falls back to the agent's own anomaly severity when no
    // child bump applies.
    const leftSeverity = left.effectiveAttentionSeverity ?? left.anomaly.severity;
    const rightSeverity = right.effectiveAttentionSeverity ?? right.anomaly.severity;
    const bySeverity = SEVERITY_ORDER[leftSeverity] - SEVERITY_ORDER[rightSeverity];
    if (bySeverity !== 0) return bySeverity;
  }

  const byPriority = priorityRank(left) - priorityRank(right);
  if (byPriority !== 0) return byPriority;

  const byProject = projectRank(left, options.projectPriorityRanks) - projectRank(right, options.projectPriorityRanks);
  if (byProject !== 0) return byProject;

  const byTime = resolveStartedAtMs(left, options.startedMsByAgentId) - resolveStartedAtMs(right, options.startedMsByAgentId);
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

/** Parse startedAt once; unknown/invalid → UNKNOWN_TIME (sorts last). */
export function computeStartedAtMs(agent: AgentState): number {
  if (!agent.startedAt) return UNKNOWN_TIME;
  const ms = new Date(agent.startedAt).getTime();
  return Number.isFinite(ms) ? ms : UNKNOWN_TIME;
}

function resolveStartedAtMs(
  agent: AgentState,
  startedMsByAgentId: ReadonlyMap<string, number> | undefined,
): number {
  const cached = startedMsByAgentId?.get(agent.agentId);
  if (cached !== undefined) return cached;
  return computeStartedAtMs(agent);
}

function originalRank(agent: AgentState, originalIndex: ReadonlyMap<string, number> | undefined): number {
  return originalIndex?.get(agent.agentId) ?? UNRANKED_PROJECT;
}
