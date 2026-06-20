import type { AgentState } from './protocol.js';
import { isTerminalStatus } from './contracts/task-status.js';
import type { EmptyEnterAdvanceDiagnostics } from './terminal-input-contract.js';

export type { EmptyEnterAdvanceDiagnostics } from './terminal-input-contract.js';

/**
 * Canonical routability predicates shared by the frontend triage navigation
 * and the server empty-Enter advancement (#1079). Keeping a single definition
 * is what makes parity provable: both sides filter the routable set the same
 * way, so server-driven advancement can never land on a task the frontend
 * would have excluded.
 */

/** True when the agent has an active finding that needs attention. */
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
 * True when the agent is a healthy running task — no anomaly, not
 * snoozed/suppressed, not pending, not terminal.
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

/**
 * True when an agent may be the target of empty-Enter routing — either an
 * active finding or a healthy running task. Pending, terminal, snoozed, and
 * suppressed agents are never routable.
 */
export function isRoutableAgent(agent: AgentState): boolean {
  return isActiveFinding(agent) || isHealthyRunning(agent);
}

export interface NextRoutableSelection {
  sessionId: string;
  taskId: string | null;
}

export interface SelectNextRoutableInput {
  /**
   * Ordered candidate session ids as the frontend presents them (findings
   * first, then healthy, each in `compareRoutableAgents` order). When empty or
   * omitted the server falls back to deriving the order from `agents`.
   */
  orderedSessionIds?: readonly string[];
  /** Session the advancement is moving away from. */
  currentSessionId: string;
  /** Authoritative server snapshot used to re-validate every candidate. */
  agents: readonly AgentState[];
}

export interface SelectNextRoutableResult {
  next: NextRoutableSelection | null;
  diagnostics: EmptyEnterAdvanceDiagnostics;
}

/**
 * Picks the next routable session after `currentSessionId`, following the
 * frontend-provided order when available and re-validating each candidate
 * against the authoritative server snapshot so excluded (pending/terminal/
 * snoozed/suppressed) or stale tasks are never selected.
 *
 * When no ordered candidate list is supplied the server derives a routable
 * order from its own snapshot (findings before healthy, snapshot order within
 * each group). This fallback intentionally reuses the same routability
 * predicates as the frontend, so it is strictly more consistent than a raw
 * snapshot walk even without client cooperation.
 */
export function selectNextRoutableSessionId(input: SelectNextRoutableInput): SelectNextRoutableResult {
  const byAgentId = new Map(input.agents.map((agent) => [agent.agentId, agent]));

  const provided = input.orderedSessionIds ?? [];
  const usingFrontendOrder = provided.length > 0;
  const uniqueProvided = dedupeBySession(provided);

  // Build the routable order: from the client's list when present (re-validated
  // against the snapshot), otherwise from the snapshot itself.
  const routable: AgentState[] = usingFrontendOrder
    ? uniqueProvided
        .map((sessionId) => byAgentId.get(sessionId))
        .filter((agent): agent is AgentState => agent !== undefined && isRoutableAgent(agent))
    : [
        ...input.agents.filter(isActiveFinding),
        ...input.agents.filter(isHealthyRunning),
      ];

  const currentIndex = routable.findIndex((agent) => agent.agentId === input.currentSessionId);

  const diagnosticsBase = {
    source: (usingFrontendOrder ? 'frontend-order' : 'fallback-snapshot-order') as EmptyEnterAdvanceDiagnostics['source'],
    candidateCount: provided.length,
    routableCount: routable.length,
    // Count only validation drops (missing/non-routable) among unique
    // candidates — duplicates collapsed by dedupe are not "excluded".
    excludedCount: Math.max(0, uniqueProvided.length - routable.length),
    currentInOrder: currentIndex >= 0,
  };

  if (routable.length === 0) {
    return { next: null, diagnostics: { ...diagnosticsBase, selectedSessionId: null } };
  }

  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % routable.length : 0;
  const next = routable[nextIndex];
  return {
    next: { sessionId: next.agentId, taskId: next.taskId ?? null },
    diagnostics: { ...diagnosticsBase, selectedSessionId: next.agentId },
  };
}

function dedupeBySession(sessionIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of sessionIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}
