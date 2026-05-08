import type { AgentState } from '../../shared/protocol.js';
import { isTerminalStatus } from '../../shared/contracts/task-status.js';

/**
 * Returns true if the agent has an active finding that needs attention.
 * Shared between App.tsx (filtering) and selectProject (auto-select).
 */
export function isActiveFinding(agent: AgentState): boolean {
  return (
    agent.anomaly !== null &&
    !agent.snoozedUntil &&
    !agent.suppressed &&
    agent.taskStatus !== 'pending' &&
    (agent.taskStatus === undefined || !isTerminalStatus(agent.taskStatus))
  );
}

/**
 * Returns true if the agent is a healthy running task — no anomaly,
 * not snoozed/suppressed, not pending, not in a terminal state. Mirrors
 * the `healthy` filter in App.tsx so the project-switch fallback surfaces
 * the same set of tasks the user sees in the Healthy pane.
 */
export function isHealthyRunning(agent: AgentState): boolean {
  return (
    agent.anomaly === null &&
    !agent.snoozedUntil &&
    !agent.suppressed &&
    agent.taskStatus !== 'pending' &&
    (agent.taskStatus === undefined || !isTerminalStatus(agent.taskStatus))
  );
}
