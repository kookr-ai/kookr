import type { AgentState } from '../shared/protocol.js';

/** Group findings by anomaly type, only when ≥3 findings share the same type. */
export function groupFindings(findings: AgentState[]): { ungrouped: AgentState[]; groups: Map<string, AgentState[]> } {
  const byType = new Map<string, AgentState[]>();
  for (const agent of findings) {
    const type = agent.anomaly?.type ?? '';
    const list = byType.get(type) ?? [];
    list.push(agent);
    byType.set(type, list);
  }

  const groups = new Map<string, AgentState[]>();
  const ungrouped: AgentState[] = [];
  for (const [type, agents] of byType) {
    if (agents.length >= 3) {
      groups.set(type, agents);
    } else {
      ungrouped.push(...agents);
    }
  }

  return { ungrouped, groups };
}

export function groupLabel(type: string): string {
  switch (type) {
    case 'permission_blocked': return 'blocked on permission';
    case 'repeated_error': return 'hitting repeated errors';
    case 'needs_input': return 'waiting for input';
    default: return type;
  }
}
