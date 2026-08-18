import type { AgentState } from '../shared/protocol.js';

/**
 * Index of the finding the top-bar triage-queue indicator currently names, or
 * -1 when no finding is actively selected. A finding is "active" only when an
 * anomaly agent is the current selection; otherwise the indicator reads
 * "N waiting" and has no current index.
 *
 * Shared by the indicator's `currentIndex` prop and its focus action so the
 * displayed position and the finding the click focuses never drift apart.
 */
export function activeFindingIndex(
  findings: readonly AgentState[],
  selectedAgentId: string | null,
  isAnomalySelected: boolean,
): number {
  if (!isAnomalySelected) return -1;
  return findings.findIndex((finding) => finding.agentId === selectedAgentId);
}

/**
 * The finding to focus when the queue indicator is activated: the actively
 * selected finding if there is one, otherwise the first waiting finding.
 * Returns null when there are no findings (the indicator is inert in that
 * reserved/empty state, so this is never reached in practice).
 */
export function queueFocusTarget(
  findings: readonly AgentState[],
  selectedAgentId: string | null,
  isAnomalySelected: boolean,
): AgentState | null {
  const activeIndex = activeFindingIndex(findings, selectedAgentId, isAnomalySelected);
  return findings[activeIndex] ?? findings[0] ?? null;
}
