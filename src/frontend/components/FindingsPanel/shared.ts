// Shared helpers, constants, and pure data builders for the FindingsPanel
// feature module. The sub-components in this directory and the container
// (`../FindingsPanel.tsx`) both draw from here so selection, grouping, and
// project-label logic stays in one place. Pure (no JSX) so it can be
// unit-tested in isolation.

import type { AgentState } from '../../../shared/protocol.js';
import { projectLabel, projectColor, findingTypeLabel } from '../../presentation.js';
import { groupFindings, groupIdenticalPendingPrompts } from '../../group-findings.js';
import {
  MIN_BOTTOM_SECTIONS_HEIGHT,
  MAX_BOTTOM_SECTIONS_HEIGHT,
} from '../../store/bottom-sections-height-prefs.js';

export const HEALTHY_SECTION_COLLAPSED_KEY = 'kookr:findingsPanel.healthy';
export const PENDING_SECTION_COLLAPSED_KEY = 'kookr:findingsPanel.pending';
export const SNOOZED_SECTION_COLLAPSED_KEY = 'kookr:findingsPanel.snoozed';
export const COMPLETED_SECTION_COLLAPSED_KEY = 'kookr:findingsPanel.completed';

const FINDING_GROUP_RENDER_LIMIT = 25;

/** Callback shapes shared between the container's Props and the row components
 *  that receive them, so both reference a single definition. */
export type QueueDeleteTaskHandler = (args: { taskId: string; label: string }) => void;
export type QueueClearCompletedHandler = (args: {
  includeTerminated: boolean;
  projectId?: string;
  taskIds: string[];
  count: number;
}) => void;

export function isSelectedAgent(agent: AgentState, selectedAgentId: string | null, selectedTaskId: string | null): boolean {
  if (agent.agentId !== selectedAgentId) return false;
  return selectedTaskId ? agent.taskId === selectedTaskId : true;
}

export function agentRowKey(agent: AgentState): string {
  return `${agent.agentId}:${agent.taskId ?? ''}`;
}

export function agentProjectLabel(agent: AgentState): string {
  return agent.projectDisplayLabel ?? projectLabel(agent.cwd);
}

export function agentProjectColor(agent: AgentState): number {
  return projectColor(agent.projectId ?? agent.cwd);
}

export function severityClass(agent: AgentState): string {
  if (!agent.anomaly) return '';
  switch (agent.anomaly.type) {
    case 'permission_blocked': return 'permission';
    case 'repeated_error': return 'error';
    // A normal completed turn is a review-ready signal, not a hung turn — tone it down vs an explicit
    // mid-turn AskUserQuestion, which still reads as `input`. See issue #358.
    case 'needs_input': return agent.turnState === 'completed_turn' ? 'turn-complete' : 'input';
  }
}

export function severityLabel(agent: AgentState): string {
  return findingTypeLabel(agent);
}

export function visibleFindingAgents(
  agents: AgentState[],
  selectedAgentId: string | null,
  selectedTaskId: string | null,
  showAll: boolean,
): AgentState[] {
  if (showAll || agents.length <= FINDING_GROUP_RENDER_LIMIT) return agents;

  const visible = agents.slice(0, FINDING_GROUP_RENDER_LIMIT);
  if (selectedAgentId && !visible.some((agent) => isSelectedAgent(agent, selectedAgentId, selectedTaskId))) {
    const selected = agents.find((agent) => isSelectedAgent(agent, selectedAgentId, selectedTaskId));
    // Keep keyboard/current selection visible even when it falls outside the default flood cap.
    if (selected) return [...visible, selected];
  }
  return visible;
}

export type FindingDisplayItem =
  | { kind: 'single'; agent: AgentState }
  | { kind: 'rootCauseGroup'; root: AgentState; related: AgentState[] }
  | { kind: 'duplicateGroup'; key: string; type: string; agents: AgentState[] };

export function buildFindingDisplayItems(findings: AgentState[]): FindingDisplayItem[] {
  const byAgentId = new Map(findings.map((agent) => [agent.agentId, agent]));
  const causalityKeys = new Set<string>();
  const rootRelatedByKey = new Map<string, AgentState[]>();

  for (const root of findings) {
    if (!root.anomaly?.likelyRootCause) continue;
    const related = (root.anomaly.relatedFindingIds ?? [])
      .map((id) => byAgentId.get(id))
      .filter((agent): agent is AgentState => Boolean(agent) && agentRowKey(agent) !== agentRowKey(root));
    if (related.length === 0) continue;

    rootRelatedByKey.set(agentRowKey(root), related);
    causalityKeys.add(agentRowKey(root));
    for (const agent of related) causalityKeys.add(agentRowKey(agent));
  }

  const nonCausalFindings = findings.filter((agent) => !causalityKeys.has(agentRowKey(agent)));
  const identicalPromptGroups = groupIdenticalPendingPrompts(nonCausalFindings);
  const promptGroupByKey = new Map<string, { key: string; type: string; agents: AgentState[] }>();
  const promptGroupedKeys = new Set<string>();
  for (const group of identicalPromptGroups) {
    const type = group.agents[0]?.anomaly?.type ?? 'needs_input';
    const displayGroup = { key: `prompt:${group.key}`, type, agents: group.agents };
    for (const agent of group.agents) {
      const key = agentRowKey(agent);
      promptGroupByKey.set(key, displayGroup);
      promptGroupedKeys.add(key);
    }
  }

  const { groups: duplicateGroups } = groupFindings(nonCausalFindings.filter((agent) => !promptGroupedKeys.has(agentRowKey(agent))));
  const duplicateGroupByKey = new Map<string, { key: string; type: string; agents: AgentState[] }>();
  for (const [type, agents] of duplicateGroups) {
    const displayGroup = { key: `type:${type}`, type, agents };
    for (const agent of agents) duplicateGroupByKey.set(agentRowKey(agent), displayGroup);
  }

  const items: FindingDisplayItem[] = [];
  const consumed = new Set<string>();
  const emittedGroupKeys = new Set<string>();

  for (const agent of findings) {
    const key = agentRowKey(agent);
    if (consumed.has(key)) continue;

    const related = (rootRelatedByKey.get(key) ?? [])
      .filter((candidate) => !consumed.has(agentRowKey(candidate)));
    if (related.length > 0) {
      items.push({ kind: 'rootCauseGroup', root: agent, related });
      consumed.add(key);
      for (const relatedAgent of related) consumed.add(agentRowKey(relatedAgent));
      continue;
    }

    const promptGroup = promptGroupByKey.get(key);
    if (promptGroup && !emittedGroupKeys.has(promptGroup.key)) {
      items.push({ kind: 'duplicateGroup', key: promptGroup.key, type: promptGroup.type, agents: promptGroup.agents });
      emittedGroupKeys.add(promptGroup.key);
      for (const groupedAgent of promptGroup.agents) consumed.add(agentRowKey(groupedAgent));
      continue;
    }

    const duplicateGroup = duplicateGroupByKey.get(key);
    if (duplicateGroup && !emittedGroupKeys.has(duplicateGroup.key)) {
      items.push({ kind: 'duplicateGroup', key: duplicateGroup.key, type: duplicateGroup.type, agents: duplicateGroup.agents });
      emittedGroupKeys.add(duplicateGroup.key);
      for (const groupedAgent of duplicateGroup.agents) consumed.add(agentRowKey(groupedAgent));
      continue;
    }

    items.push({ kind: 'single', agent });
    consumed.add(key);
  }

  return items;
}

/** Group healthy agents: playbook iterations are collapsed, standalone agents shown individually. */
export function groupHealthyAgents(agents: AgentState[]): { standalone: AgentState[]; groups: Map<string, AgentState[]> } {
  const groups = new Map<string, AgentState[]>();
  const standalone: AgentState[] = [];

  for (const agent of agents) {
    if (agent.playbookId) {
      const list = groups.get(agent.playbookId) ?? [];
      list.push(agent);
      groups.set(agent.playbookId, list);
    } else {
      standalone.push(agent);
    }
  }

  // Only group if there are 2+ agents with the same playbookId
  const realGroups = new Map<string, AgentState[]>();
  for (const [id, list] of groups) {
    if (list.length >= 2) {
      // Sort by startedAt descending (most recent first)
      list.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''));
      realGroups.set(id, list);
    } else {
      standalone.push(...list);
    }
  }

  return { standalone, groups: realGroups };
}

// Headroom kept above the bottom sections for the findings header + at least a
// couple of findings, so neither the drag nor a persisted height can grow the
// bottom area to the point of hiding the list it sits below.
const BOTTOM_SECTIONS_RESERVED_ABOVE_PX = 160;

/** Live upper bound for the bottom-sections height, given the current panel size. */
export function maxBottomSectionsHeightFor(panel: HTMLElement | null): number {
  if (!panel) return MAX_BOTTOM_SECTIONS_HEIGHT;
  return Math.max(
    MIN_BOTTOM_SECTIONS_HEIGHT,
    panel.getBoundingClientRect().height - BOTTOM_SECTIONS_RESERVED_ABOVE_PX,
  );
}
