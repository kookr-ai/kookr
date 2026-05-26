import type { AgentState } from '../shared/protocol.js';

export interface DashboardSelectionState {
  connectionId: string;
  selectedTaskId: string | null;
  selectedSessionId: string | null;
  selectionVersion: number;
  consumedIntentIds: Set<string>;
}

export type AdvanceSelectionResult =
  | { kind: 'advanced'; state: Omit<DashboardSelectionState, 'consumedIntentIds'> }
  | { kind: 'rejected'; reason: 'stale-selection' | 'duplicate-intent' | 'unknown-connection' };

export class DashboardSelectionController {
  private readonly states = new Map<string, DashboardSelectionState>();

  constructor(private readonly deps: { getAgents: () => readonly AgentState[] }) {}

  registerConnection(connectionId: string): void {
    if (this.states.has(connectionId)) return;
    this.states.set(connectionId, {
      connectionId,
      selectedTaskId: null,
      selectedSessionId: null,
      selectionVersion: 0,
      consumedIntentIds: new Set(),
    });
  }

  unregisterConnection(connectionId: string): void {
    this.states.delete(connectionId);
  }

  updateSelection(input: {
    connectionId: string;
    selectedTaskId: string | null;
    selectedSessionId: string | null;
  }): Omit<DashboardSelectionState, 'consumedIntentIds'> {
    this.registerConnection(input.connectionId);
    const state = this.states.get(input.connectionId)!;
    if (
      state.selectedTaskId !== input.selectedTaskId
      || state.selectedSessionId !== input.selectedSessionId
    ) {
      state.selectedTaskId = input.selectedTaskId;
      state.selectedSessionId = input.selectedSessionId;
      state.selectionVersion += 1;
    }
    return this.publicState(state);
  }

  getSelection(connectionId: string): Omit<DashboardSelectionState, 'consumedIntentIds'> | null {
    const state = this.states.get(connectionId);
    return state ? this.publicState(state) : null;
  }

  advanceIfSelectionStill(input: {
    connectionId: string;
    taskId: string;
    sessionId: string;
    selectionVersion: number;
    intentId: string;
  }): AdvanceSelectionResult {
    const state = this.states.get(input.connectionId);
    if (!state) return { kind: 'rejected', reason: 'unknown-connection' };
    if (state.consumedIntentIds.has(input.intentId)) {
      return { kind: 'rejected', reason: 'duplicate-intent' };
    }
    if (
      state.selectedTaskId !== input.taskId
      || state.selectedSessionId !== input.sessionId
      || state.selectionVersion !== input.selectionVersion
    ) {
      return { kind: 'rejected', reason: 'stale-selection' };
    }

    state.consumedIntentIds.add(input.intentId);
    const next = this.nextAgentAfter(input.sessionId);
    state.selectedTaskId = next?.taskId ?? null;
    state.selectedSessionId = next?.agentId ?? null;
    state.selectionVersion += 1;
    return { kind: 'advanced', state: this.publicState(state) };
  }

  private nextAgentAfter(sessionId: string): AgentState | null {
    const agents = this.deps.getAgents();
    const activeFindings = agents.filter((agent) => agent.anomaly && agent.taskStatus !== 'pending');
    const healthy = agents.filter((agent) => !agent.anomaly && agent.taskStatus === 'inProgress');
    const all = [...activeFindings, ...healthy];
    if (all.length === 0) return null;
    const currentIndex = all.findIndex((agent) => agent.agentId === sessionId);
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % all.length : 0;
    return all[nextIndex] ?? null;
  }

  private publicState(state: DashboardSelectionState): Omit<DashboardSelectionState, 'consumedIntentIds'> {
    return {
      connectionId: state.connectionId,
      selectedTaskId: state.selectedTaskId,
      selectedSessionId: state.selectedSessionId,
      selectionVersion: state.selectionVersion,
    };
  }
}
