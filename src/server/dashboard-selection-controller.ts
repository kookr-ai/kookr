import type { AgentState } from '../shared/protocol.js';
import {
  selectNextRoutableSessionId,
  type EmptyEnterAdvanceDiagnostics,
} from '../shared/task-routing.js';

export interface DashboardSelectionState {
  connectionId: string;
  selectedTaskId: string | null;
  selectedSessionId: string | null;
  selectionVersion: number;
  consumedIntentIds: Set<string>;
}

export type AdvanceSelectionResult =
  | {
      kind: 'advanced';
      state: Omit<DashboardSelectionState, 'consumedIntentIds'>;
      diagnostics: EmptyEnterAdvanceDiagnostics;
    }
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

  /**
   * True when any currently-connected dashboard has `taskId` selected — the
   * server-side "an operator is present on this task" signal used by the
   * hung-task reap presence auto-hold (RFC rfc-reap-grace-warning.md). Presence
   * is inherently live: a disconnected client's state was removed by
   * {@link unregisterConnection}, so this can never report a closed tab as
   * present.
   */
  isTaskSelectedByAnyConnection(taskId: string): boolean {
    for (const state of this.states.values()) {
      if (state.selectedTaskId === taskId) return true;
    }
    return false;
  }

  advanceIfSelectionStill(input: {
    connectionId: string;
    taskId: string;
    sessionId: string;
    selectionVersion: number;
    intentId: string;
    /**
     * Routable session ids in the frontend's presentation order. When provided
     * the server follows this order (re-validated against its snapshot);
     * otherwise it derives a routable order from the snapshot itself (#1079).
     */
    orderedCandidateSessionIds?: readonly string[];
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
    const { next, diagnostics } = selectNextRoutableSessionId({
      orderedSessionIds: input.orderedCandidateSessionIds,
      currentSessionId: input.sessionId,
      agents: this.deps.getAgents(),
    });
    state.selectedTaskId = next?.taskId ?? null;
    state.selectedSessionId = next?.sessionId ?? null;
    state.selectionVersion += 1;
    return { kind: 'advanced', state: this.publicState(state), diagnostics };
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
