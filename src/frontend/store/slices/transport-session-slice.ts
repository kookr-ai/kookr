import type { AgentState, TransportSessionSlice, StoreGet, StoreSet } from '../store-types.js';
import { SEVERITY_ORDER } from '../store-types.js';
import { mergeActivityAgent } from '../activity-history.js';
import { firstReadyKookrSTTEndpoint } from '../../../shared/contracts/speech.js';
import { clearSelectedTask, loadSelectedTask } from '../selected-task-storage.js';
import { withSelectionTransitionSource } from '../../selection-transition-recorder.js';

function isTerminalTaskStatus(status: AgentState['taskStatus']): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'terminated';
}

function isUserDismissedTaskStatus(status: AgentState['taskStatus']): boolean {
  return status === 'completed' || status === 'cancelled';
}

function isActionableFinding(agent: AgentState): boolean {
  return (
    agent.anomaly !== null
    && !agent.snoozedUntil
    && !agent.suppressed
    && agent.taskStatus !== 'pending'
    && !isTerminalTaskStatus(agent.taskStatus)
  );
}

function nextActionableFindingId(agents: AgentState[], excludingAgentId: string): string | null {
  const findings = agents
    .filter((agent) => agent.agentId !== excludingAgentId && isActionableFinding(agent))
    .sort((left, right) => SEVERITY_ORDER[left.anomaly!.severity] - SEVERITY_ORDER[right.anomaly!.severity]);

  return findings[0]?.agentId ?? null;
}

function selectedAgentUpdateAfterServerState(
  selectedAgentId: string | null,
  selectedTaskId: string | null,
  previousAgents: AgentState[],
  nextAgents: AgentState[],
): { selectedAgentId?: string | null; selectedTaskId?: string | null; selectedAgentSource?: 'manual'; respondAllAgentIds?: null; leftPane?: 'activity'; narrowTab?: 'activity'; shortcutsArmed?: false } {
  if (!selectedAgentId) return {};

  const previousSelected = selectedTaskId
    ? previousAgents.find((agent) => agent.agentId === selectedAgentId && agent.taskId === selectedTaskId)
    : previousAgents.find((agent) => agent.agentId === selectedAgentId);
  const nextSelected = selectedTaskId
    ? nextAgents.find((agent) => agent.agentId === selectedAgentId && agent.taskId === selectedTaskId)
    : nextAgents.find((agent) => agent.agentId === selectedAgentId);
  if (!nextSelected) {
    // Server evicted the agent. Tag as 'manual' so the engagement guard isn't
    // confused into thinking the (now null) selection is an auto-advance landing.
    return { selectedAgentId: null, selectedTaskId: null, selectedAgentSource: 'manual', respondAllAgentIds: null };
  }

  if (
    previousSelected
    && !isUserDismissedTaskStatus(previousSelected.taskStatus)
    && isUserDismissedTaskStatus(nextSelected.taskStatus)
  ) {
    const nextAgentId = nextActionableFindingId(nextAgents, selectedAgentId);
    const nextAgent = nextAgentId ? nextAgents.find((agent) => agent.agentId === nextAgentId) : null;
    return {
      selectedAgentId: nextAgentId,
      selectedTaskId: nextAgent?.taskId ?? null,
      selectedAgentSource: 'manual',
      respondAllAgentIds: null,
      leftPane: 'activity',
      narrowTab: 'activity',
      shortcutsArmed: false,
    };
  }

  return {};
}

function selectedAgentRestoreAfterFirstSnapshot(
  agentsHydrated: boolean,
  selectedAgentId: string | null,
  nextAgents: AgentState[],
): {
  update: {
    selectedAgentId?: string | null;
    selectedTaskId?: string | null;
    selectedAgentSource?: 'manual';
    respondAllAgentIds?: null;
    leftPane?: 'activity';
    narrowTab?: 'activity';
    shortcutsArmed?: false;
  };
  missed: boolean;
} {
  if (agentsHydrated || selectedAgentId) return { update: {}, missed: false };

  const stored = loadSelectedTask();
  if (!stored) return { update: {}, missed: false };

  const restored = (
    stored.taskId
      ? nextAgents.find((agent) => agent.taskId === stored.taskId)
      : undefined
  ) ?? (
    stored.agentId
      ? nextAgents.find((agent) => agent.agentId === stored.agentId)
      : undefined
  );

  if (!restored) {
    clearSelectedTask();
    return {
      update: {
        selectedAgentId: null,
        selectedTaskId: null,
        selectedAgentSource: 'manual',
        respondAllAgentIds: null,
      },
      missed: true,
    };
  }

  return {
    update: {
      selectedAgentId: restored.agentId,
      selectedTaskId: restored.taskId ?? null,
      selectedAgentSource: 'manual',
      respondAllAgentIds: null,
      leftPane: 'activity',
      narrowTab: 'activity',
      shortcutsArmed: false,
    },
    missed: false,
  };
}

export function createTransportSessionSlice(set: StoreSet, get: StoreGet): TransportSessionSlice {
  return {
    agents: [],
    agentsHydrated: false,
    connected: false,
    terminalOutput: {},
    serverCwd: '',
    availableAgentTypes: [],
    defaultAgentType: 'claude-code',
    buildInfo: null,
    serverStartedAt: null,
    playbooks: [],
    playbooksLoading: false,
    playbooksLastFetchedAt: 0,
    playbooksLastFetchedCwd: '',
    hostCapabilities: {},
    sttUrl: '',
    ttsUrl: '',
    speechCapabilities: null,
    activeSTTInputId: null,
    totalSpendUsd: 0,
    maxActiveTasks: 0,
    bypassAllPermissions: false,
    drainStatus: { accepting: true, draining: false },
    coordinator: null,
    dashboardSelection: { selectedTaskId: null, selectedSessionId: null, selectionVersion: 0 },
    taskRelations: [],
    relationFilter: { mode: 'off', rootTaskId: null },
    setRelationFilter: (filter) => set(() => ({ relationFilter: filter })),

    handleSnapshot: (agents, serverCwd, build, serverStartedAt, sttEnabled, sttUrl, totalSpendUsd, achievements, availableAgentTypes, defaultAgentType, workspaceEnabled, sweepRunning, maxActiveTasks, speechCapabilities, coordinator, ttsUrl, bypassAllPermissions, drainStatus) => {
      let restoreMissed = false;
      withSelectionTransitionSource({ source: 'selectedAgentUpdateAfterServerState', reason: 'snapshot_reconcile' }, () => {
        set((prev) => {
          const previousByKey = new Map(prev.agents.map((agent) => [`${agent.agentId}:${agent.taskId ?? ''}`, agent]));
          const previousById = new Map(prev.agents.map((agent) => [agent.agentId, agent]));
          const mergedAgents = agents.map((agent) => (
            mergeActivityAgent(
              previousByKey.get(`${agent.agentId}:${agent.taskId ?? ''}`) ?? (!agent.taskId ? previousById.get(agent.agentId) : undefined),
              agent,
            )
          ));
          const descriptorSttUrl = firstReadyKookrSTTEndpoint(speechCapabilities);
          const nextSttUrl = sttEnabled && sttUrl ? sttUrl : descriptorSttUrl;
          const restoredSelection = selectedAgentRestoreAfterFirstSnapshot(prev.agentsHydrated, prev.selectedAgentId, mergedAgents);
          restoreMissed = restoredSelection.missed;
          return {
            agents: mergedAgents,
            ...selectedAgentUpdateAfterServerState(prev.selectedAgentId, prev.selectedTaskId, prev.agents, mergedAgents),
            ...restoredSelection.update,
            agentsHydrated: true,
            ...(serverCwd !== undefined ? { serverCwd } : {}),
            ...(availableAgentTypes !== undefined ? { availableAgentTypes } : {}),
            ...(defaultAgentType !== undefined ? { defaultAgentType } : {}),
            ...(build !== undefined ? { buildInfo: build } : {}),
            ...(serverStartedAt !== undefined ? { serverStartedAt } : {}),
            ...(nextSttUrl ? { sttUrl: nextSttUrl } : {}),
            ...(ttsUrl !== undefined ? { ttsUrl } : {}),
            ...(speechCapabilities !== undefined ? { speechCapabilities } : {}),
            ...(totalSpendUsd !== undefined ? { totalSpendUsd } : {}),
            ...(achievements !== undefined ? { achievements } : {}),
            ...(workspaceEnabled !== undefined ? { workspaceEnabled } : {}),
            ...(sweepRunning !== undefined ? { sweepRunning } : {}),
            ...(maxActiveTasks !== undefined ? { maxActiveTasks } : {}),
            bypassAllPermissions: bypassAllPermissions === true,
            ...(drainStatus !== undefined ? { drainStatus } : {}),
            ...(coordinator !== undefined ? { coordinator } : {}),
          };
        });
      });
      if (restoreMissed) {
        get().handleAlert('workspace', 'Previously watched task finished or was removed.', 'info');
      }
    },

    handleUpdate: (agentId, state) => {
      withSelectionTransitionSource({ source: 'selectedAgentUpdateAfterServerState', reason: 'agent_update_reconcile' }, () => {
        set((prev) => {
          const agents = prev.agents.map((agent) => (
            agent.agentId === agentId && (!state.taskId || agent.taskId === state.taskId)
              ? mergeActivityAgent(agent, state)
              : agent
          ));
          return {
            agents,
            ...selectedAgentUpdateAfterServerState(prev.selectedAgentId, prev.selectedTaskId, prev.agents, agents),
          };
        });
      });
    },

    handlePlaybooks: (playbooks, cwd, capabilities) => {
      set({
        playbooks,
        hostCapabilities: capabilities ?? {},
        playbooksLoading: false,
        playbooksLastFetchedAt: Date.now(),
        playbooksLastFetchedCwd: cwd,
      });
    },

    setConnected: (connected) => {
      set({ connected });
    },

    handleDashboardSelection: (selection) => {
      withSelectionTransitionSource({ source: 'handleDashboardSelection', reason: 'server_dashboard_selection' }, () => {
        set({
          dashboardSelection: selection,
          ...(selection.selectedSessionId !== undefined
            ? {
                selectedAgentId: selection.selectedSessionId,
                selectedTaskId: selection.selectedTaskId,
                selectedAgentSource: 'manual' as const,
              }
            : {}),
        });
      });
    },

    setTerminalOutput: (agentId, output) => {
      set((prev) => ({
        terminalOutput: { ...prev.terminalOutput, [agentId]: output },
      }));
    },

    setPlaybooksLoading: (loading) => {
      set({ playbooksLoading: loading });
    },

    setActiveSTTInput: (id) => {
      set({ activeSTTInputId: id });
    },
  };
}
